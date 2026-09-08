const fs = require('fs');
const https = require('https');
const { createHash } = require('crypto');
const {
  USER_AGENT,
  REQUEST_TIMEOUT_MS,
  MAX_REDIRECTS,
  resolveRedirectUrl,
  validateUpdateUrl,
  validateMirrorUrl,
  normalizeMirrorUrls,
  requestWithRedirect,
} = require('./update-network');

const SEGMENT_SIZE = 4 * 1024 * 1024;
const MAX_SEGMENTS = 32;
const CONCURRENCY = 6;
const MAX_UPDATE_SIZE = 2 * 1024 * 1024 * 1024;

const buildProxyAgent = async (proxy, loadModule) => {
  if (!proxy || !proxy.host || !proxy.port) return null;
  const auth = proxy.username ? `${proxy.username}:${proxy.password || ''}@` : '';
  const moduleName = proxy.type === 'HTTP' ? 'https-proxy-agent' : proxy.type === 'SOCKS5' ? 'socks-proxy-agent' : null;
  if (!moduleName) return null;
  const Agent = await loadModule(moduleName);
  if (!Agent) return null;
  try { return new Agent(`${proxy.type === 'HTTP' ? 'http' : 'socks5'}://${auth}${proxy.host}:${proxy.port}`); } catch { return null; }
};

const cleanupPartial = targetPath => {
  for (const suffix of ['.part', '.meta.json', '.meta.json.tmp', '']) {
    try { fs.rmSync(`${targetPath}${suffix}`, { force: true }); } catch { /* best effort */ }
  }
};

const buildMirrorUrl = (mirror, sourceUrl) => {
  const parsedMirror = validateMirrorUrl(mirror);
  const result = mirror.includes('{url}')
    ? mirror.replaceAll('{url}', sourceUrl)
    : `${parsedMirror.href.replace(/\/+$/, '')}/${sourceUrl}`;
  validateUpdateUrl(result, new Set([parsedMirror.hostname]));
  return result;
};

const writeMetadata = (metaPath, meta) => {
  const temporaryPath = `${metaPath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(meta));
  fs.rmSync(metaPath, { force: true });
  fs.renameSync(temporaryPath, metaPath);
};

const probe = async (value, context) => {
  const { response, url } = await requestWithRedirect(value, {
    method: 'GET',
    agent: context.agent,
    allowedHosts: context.allowedHosts,
    headers: { 'Accept-Encoding': 'identity', Range: 'bytes=0-0' },
  });
  response.resume();
  const contentRange = response.headers['content-range'] || '';
  const contentLength = Number(response.headers['content-length']) || 0;
  const totalBytes = Number((contentRange.match(/\/(\d+)$/) || [])[1]) || contentLength;
  if (totalBytes > MAX_UPDATE_SIZE) throw new Error('更新文件超过允许大小。');
  if (response.statusCode === 206 && !/^bytes\s+0-0\/\d+$/i.test(contentRange)) {
    throw new Error('更新资源的范围响应无效。');
  }
  return { totalBytes, rangeSupported: response.statusCode === 206 && totalBytes > 0, finalUrl: url };
};

const downloadSegment = (value, start, end, totalBytes, fd, context, onData, redirectCount = 0) => new Promise((resolve, reject) => {
  if (redirectCount > MAX_REDIRECTS) {
    reject(new Error('更新资源重定向次数过多。'));
    return;
  }
  let parsed;
  try { parsed = validateUpdateUrl(value, context.allowedHosts); } catch (error) { reject(error); return; }
  let settled = false;
  let redirected = false;
  let response;
  const fail = error => {
    if (settled || redirected) return;
    settled = true;
    response?.destroy();
    reject(error);
  };
  const request = https.request(parsed, {
    method: 'GET', agent: context.agent, timeout: REQUEST_TIMEOUT_MS,
    headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity', Range: `bytes=${start}-${end}` },
  }, responseValue => {
    response = responseValue;
    response.on('error', fail);
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
      redirected = true;
      response.resume();
      let redirectUrl;
      try { redirectUrl = resolveRedirectUrl(response.headers.location, parsed, context.allowedHosts); } catch (error) { settled = true; reject(error); return; }
      downloadSegment(redirectUrl, start, end, totalBytes, fd, context, onData, redirectCount + 1).then(resolve, reject);
      return;
    }
    if (response.statusCode !== 206) { response.resume(); fail(new Error(`分片下载未获分段响应（HTTP ${response.statusCode}）。`)); return; }
    const contentRange = response.headers['content-range'] || '';
    const rangeMatch = contentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
    if (!rangeMatch
      || Number(rangeMatch[1]) !== start
      || Number(rangeMatch[2]) !== end
      || Number(rangeMatch[3]) !== totalBytes) {
      response.resume();
      fail(new Error('分片下载响应区间无效。'));
      return;
    }
    const expected = end - start + 1;
    let received = 0;
    response.on('data', chunk => {
      if (settled || context.isCancelled()) {
        fail(new Error('更新下载已取消。'));
        return;
      }
      if (received + chunk.length > expected) {
        fail(new Error(`分片下载超出范围：期望 ${expected} 字节。`));
        return;
      }
      try {
        fs.writeSync(fd, chunk, 0, chunk.length, start + received);
        received += chunk.length;
        onData(chunk.length);
      } catch (error) {
        fail(error);
      }
    });
    response.on('end', () => {
      if (settled) return;
      if (received !== expected) {
        fail(new Error(`分片下载不完整：期望 ${expected} 字节，实际 ${received} 字节。`));
        return;
      }
      settled = true;
      resolve(received);
    });
    response.on('aborted', () => fail(new Error('分片下载连接中断。')));
  });
  context.registerRequest(request);
  request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('分片下载超时。')));
  request.on('error', fail);
  request.on('close', () => context.unregisterRequest(request));
  request.end();
});

const downloadStream = (value, targetPath, context, onProgress, redirectCount = 0) => new Promise((resolve, reject) => {
  if (redirectCount > MAX_REDIRECTS) {
    reject(new Error('更新资源重定向次数过多。'));
    return;
  }
  let parsed;
  try { parsed = validateUpdateUrl(value, context.allowedHosts); } catch (error) { reject(error); return; }
  const partPath = `${targetPath}.part`;
  let settled = false;
  let redirected = false;
  let response;
  let file;
  const fail = error => {
    if (settled || redirected) return;
    settled = true;
    response?.destroy();
    file?.destroy();
    reject(error);
  };
  const request = https.get(parsed, { agent: context.agent, timeout: REQUEST_TIMEOUT_MS, headers: { 'User-Agent': USER_AGENT } }, responseValue => {
    response = responseValue;
    response.on('error', fail);
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
      redirected = true;
      response.resume();
      let redirectUrl;
      try { redirectUrl = resolveRedirectUrl(response.headers.location, parsed, context.allowedHosts); } catch (error) { settled = true; reject(error); return; }
      downloadStream(redirectUrl, targetPath, context, onProgress, redirectCount + 1).then(resolve, reject);
      return;
    }
    if (response.statusCode !== 200) { response.resume(); fail(new Error(`下载更新失败（HTTP ${response.statusCode}）。`)); return; }
    const totalBytes = Number(response.headers['content-length']) || 0;
    if (totalBytes > MAX_UPDATE_SIZE) { response.resume(); fail(new Error('更新文件超过允许大小。')); return; }
    let receivedBytes = 0;
    const hash = createHash('sha256');
    file = fs.createWriteStream(partPath);
    context.registerFile(file);
    file.on('error', fail);
    response.on('data', chunk => {
      if (settled || context.isCancelled()) {
        fail(new Error('更新下载已取消。'));
        return;
      }
      if (receivedBytes + chunk.length > MAX_UPDATE_SIZE) {
        fail(new Error('更新文件超过允许大小。'));
        return;
      }
      try {
        receivedBytes += chunk.length;
        hash.update(chunk);
        if (!file.write(chunk)) response.pause();
        onProgress(receivedBytes, totalBytes);
      } catch (error) {
        fail(error);
      }
    });
    file.on('drain', () => response.resume());
    response.on('end', () => file.end(() => {
      if (settled) return;
      if (context.isCancelled()) { fail(new Error('更新下载已取消。')); return; }
      if (totalBytes > 0 && receivedBytes !== totalBytes) {
        fail(new Error(`下载不完整：期望 ${totalBytes} 字节，实际 ${receivedBytes} 字节。`));
        return;
      }
      try {
        fs.rmSync(targetPath, { force: true });
        fs.renameSync(partPath, targetPath);
        settled = true;
        resolve({ totalBytes: receivedBytes, sha256: hash.digest('hex') });
      } catch (error) {
        fail(error);
      }
    }));
    response.on('aborted', () => fail(new Error('更新下载连接中断。')));
  });
  context.registerRequest(request);
  request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('更新下载超时。')));
  request.on('error', fail);
  request.on('close', () => context.unregisterRequest(request));
});

const hashFile = filePath => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  const stream = fs.createReadStream(filePath);
  stream.on('data', chunk => hash.update(chunk));
  stream.on('end', () => resolve(hash.digest('hex')));
  stream.on('error', reject);
});

const downloadParallel = async (value, targetPath, totalBytes, context, onProgress) => {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || totalBytes > MAX_UPDATE_SIZE) {
    throw new Error('更新文件大小无效。');
  }
  const partPath = `${targetPath}.part`; const metaPath = `${targetPath}.meta.json`;
  const segmentSize = Math.max(SEGMENT_SIZE, Math.ceil(totalBytes / MAX_SEGMENTS));
  const chunkCount = Math.max(1, Math.min(MAX_SEGMENTS, Math.ceil(totalBytes / segmentSize)));
  const expectedSegments = Array.from({ length: chunkCount }, (_, index) => ({
    start: index * segmentSize,
    end: Math.min(totalBytes - 1, index * segmentSize + segmentSize - 1),
  }));
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { /* resume metadata unavailable */ }
  if (!meta
    || meta.url !== value
    || meta.totalBytes !== totalBytes
    || meta.chunkCount !== chunkCount
    || meta.segmentSize !== segmentSize
    || !Array.isArray(meta.segments)
    || meta.segments.length !== chunkCount
    || meta.segments.some((segment, index) => {
      const expected = expectedSegments[index];
      return !segment
        || segment.start !== expected.start
        || segment.end !== expected.end
        || !Number.isInteger(segment.downloaded)
        || segment.downloaded < 0
        || segment.downloaded > expected.end - expected.start + 1;
    })
    || (fs.existsSync(partPath) && fs.statSync(partPath).size > totalBytes)
    || (fs.existsSync(partPath) && meta.segments.some(segment => segment.downloaded > 0
      && fs.statSync(partPath).size < segment.start + segment.downloaded))) {
    fs.rmSync(partPath, { force: true });
    const segments = expectedSegments.map(segment => ({ ...segment, downloaded: 0 }));
    meta = { url: value, totalBytes, chunkCount, segmentSize, segments };
    writeMetadata(metaPath, meta);
  }
  let fd = fs.openSync(partPath, fs.existsSync(partPath) ? 'r+' : 'w+'); let next = 0; let failed = false;
  let metadataTimer = null;
  let lastMetadataWriteAt = 0;
  const aggregated = () => meta.segments.reduce((sum, segment) => sum + segment.downloaded, 0);
  const flushMetadata = () => {
    if (metadataTimer) clearTimeout(metadataTimer);
    metadataTimer = null;
    writeMetadata(metaPath, meta);
    lastMetadataWriteAt = Date.now();
  };
  const scheduleMetadataWrite = () => {
    const remaining = Math.max(0, 500 - (Date.now() - lastMetadataWriteAt));
    if (remaining === 0) {
      flushMetadata();
      return;
    }
    if (!metadataTimer) metadataTimer = setTimeout(flushMetadata, remaining);
  };
  const worker = async () => {
    while (next < chunkCount && !context.isCancelled() && !failed) {
      const segment = meta.segments[next++]; const expected = segment.end - segment.start + 1;
      if (segment.downloaded >= expected) continue;
      try {
        await downloadSegment(value, segment.start + segment.downloaded, segment.end, totalBytes, fd, context, delta => {
          segment.downloaded += delta;
          scheduleMetadataWrite();
          onProgress(aggregated(), totalBytes);
        });
        flushMetadata();
      } catch (error) {
        failed = true;
        flushMetadata();
        context.abortRequests?.();
        throw error;
      }
    }
  };
  try {
    const workerResults = await Promise.allSettled(
      Array.from({ length: Math.min(CONCURRENCY, chunkCount) }, worker),
    );
    const failedWorker = workerResults.find(result => result.status === 'rejected');
    if (failedWorker) throw failedWorker.reason;
    if (context.isCancelled()) throw new Error('更新下载已取消。');
    if (aggregated() !== totalBytes) throw new Error(`下载不完整：${aggregated()}/${totalBytes} 字节。`);
    if (fs.statSync(partPath).size !== totalBytes) throw new Error('更新文件大小校验失败。');
    flushMetadata();
    fs.closeSync(fd); fd = null;
    const sha256 = await hashFile(partPath);
    if (metadataTimer) clearTimeout(metadataTimer);
    metadataTimer = null;
    fs.rmSync(targetPath, { force: true }); fs.renameSync(partPath, targetPath); fs.rmSync(metaPath, { force: true });
    return { totalBytes, sha256 };
  } finally {
    if (metadataTimer) clearTimeout(metadataTimer);
    metadataTimer = null;
    if (fd !== null) try { fs.closeSync(fd); } catch { /* best effort */ }
  }
};

const downloadAsset = async (value, targetPath, context, onProgress, options = {}) => {
  let lastError = null;
  const mirrorUrls = normalizeMirrorUrls(options.mirrorUrls);
  const validMirrors = mirrorUrls.flatMap(mirror => {
    try { return [{ value: mirror, parsed: validateMirrorUrl(mirror) }]; } catch { return []; }
  });
  const sources = options.allowMirrors
    ? [value, ...validMirrors.map(({ value: mirror }) => {
      return buildMirrorUrl(mirror, value);
    })]
    : [value];
  const officialHosts = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
  const customHosts = new Set(options.allowMirrors ? validMirrors.map(({ parsed }) => parsed.hostname) : []);
  const allowedHosts = new Set([...officialHosts, ...customHosts]);
  const downloadContext = { ...context, allowedHosts };
  for (const source of sources) {
    try {
      const result = await probe(source, downloadContext);
      return result.rangeSupported
        ? await downloadParallel(source, targetPath, result.totalBytes, downloadContext, onProgress)
        : await downloadStream(source, targetPath, downloadContext, onProgress);
    } catch (error) {
      lastError = error;
      if (context.isCancelled()) throw error;
    }
  }
  throw lastError || new Error('更新下载失败。');
};

module.exports = { buildProxyAgent, buildMirrorUrl, cleanupPartial, downloadAsset, hashFile };
