const fs = require('fs');
const https = require('https');
const { createHash } = require('crypto');
const { MIRRORS, USER_AGENT, validateUpdateUrl, requestWithRedirect } = require('./update-network');

const SEGMENT_SIZE = 4 * 1024 * 1024;
const MAX_SEGMENTS = 32;
const CONCURRENCY = 6;

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
  for (const suffix of ['.part', '.meta.json', '']) {
    try { fs.rmSync(`${targetPath}${suffix}`, { force: true }); } catch { /* best effort */ }
  }
};

const probe = async (value, context) => {
  const { response, url } = await requestWithRedirect(value, {
    method: 'GET',
    agent: context.agent,
    headers: { 'Accept-Encoding': 'identity', Range: 'bytes=0-0' },
  });
  response.resume();
  const contentRange = response.headers['content-range'] || '';
  const contentLength = Number(response.headers['content-length']) || 0;
  const totalBytes = Number((contentRange.match(/\/(\d+)$/) || [])[1]) || contentLength;
  return { totalBytes, rangeSupported: response.statusCode === 206 && totalBytes > 0, finalUrl: url };
};

const downloadSegment = (value, start, end, fd, context, onData) => new Promise((resolve, reject) => {
  let parsed;
  try { parsed = validateUpdateUrl(value); } catch (error) { reject(error); return; }
  const request = https.request(parsed, {
    method: 'GET', agent: context.agent,
    headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity', Range: `bytes=${start}-${end}` },
  }, response => {
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
      response.resume();
      downloadSegment(new URL(response.headers.location, parsed).href, start, end, fd, context, onData).then(resolve, reject);
      return;
    }
    if (response.statusCode !== 206) { response.resume(); reject(new Error(`分片下载未获分段响应（HTTP ${response.statusCode}）。`)); return; }
    const expected = end - start + 1;
    let received = 0;
    response.on('data', chunk => {
      if (context.isCancelled()) return;
      fs.writeSync(fd, chunk, 0, chunk.length, start + received);
      received += chunk.length;
      onData(chunk.length);
    });
    response.on('end', () => received === expected ? resolve(received) : reject(new Error(`分片下载不完整：期望 ${expected} 字节，实际 ${received} 字节。`)));
    response.on('error', reject);
  });
  context.registerRequest(request);
  request.on('error', reject);
  request.on('close', () => context.unregisterRequest(request));
  request.end();
});

const downloadStream = (value, targetPath, context, onProgress) => new Promise((resolve, reject) => {
  let parsed;
  try { parsed = validateUpdateUrl(value); } catch (error) { reject(error); return; }
  const partPath = `${targetPath}.part`;
  const request = https.get(parsed, { agent: context.agent, headers: { 'User-Agent': USER_AGENT } }, response => {
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
      response.resume();
      downloadStream(new URL(response.headers.location, parsed).href, targetPath, context, onProgress).then(resolve, reject);
      return;
    }
    if (response.statusCode !== 200) { response.resume(); reject(new Error(`下载更新失败（HTTP ${response.statusCode}）。`)); return; }
    const totalBytes = Number(response.headers['content-length']) || 0;
    let receivedBytes = 0;
    const hash = createHash('sha256');
    const file = fs.createWriteStream(partPath);
    context.registerFile(file);
    file.on('error', error => { response.destroy(); reject(error); });
    response.on('data', chunk => {
      if (context.isCancelled()) return;
      receivedBytes += chunk.length; hash.update(chunk); file.write(chunk); onProgress(receivedBytes, totalBytes);
    });
    response.on('end', () => file.end(() => {
      if (totalBytes > 0 && receivedBytes !== totalBytes) { reject(new Error(`下载不完整：期望 ${totalBytes} 字节，实际 ${receivedBytes} 字节。`)); return; }
      fs.rmSync(targetPath, { force: true }); fs.renameSync(partPath, targetPath);
      resolve({ totalBytes, sha256: hash.digest('hex') });
    }));
    response.on('error', error => { file.destroy(); reject(error); });
  });
  context.registerRequest(request);
  request.on('error', reject);
  request.on('close', () => context.unregisterRequest(request));
});

const downloadParallel = async (value, targetPath, totalBytes, context, onProgress) => {
  const partPath = `${targetPath}.part`; const metaPath = `${targetPath}.meta.json`;
  const segmentSize = Math.max(SEGMENT_SIZE, Math.ceil(totalBytes / MAX_SEGMENTS));
  const chunkCount = Math.max(1, Math.min(MAX_SEGMENTS, Math.ceil(totalBytes / segmentSize)));
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { /* resume metadata unavailable */ }
  if (!meta || meta.url !== value || meta.totalBytes !== totalBytes || meta.chunkCount !== chunkCount) {
    fs.rmSync(partPath, { force: true });
    const segments = Array.from({ length: chunkCount }, (_, index) => ({ start: index * segmentSize, end: Math.min(totalBytes - 1, index * segmentSize + segmentSize - 1), downloaded: 0 }));
    meta = { url: value, totalBytes, chunkCount, segmentSize, segments }; fs.writeFileSync(metaPath, JSON.stringify(meta));
  }
  let fd = fs.openSync(partPath, fs.existsSync(partPath) ? 'r+' : 'w+'); let next = 0; let failed = false;
  const aggregated = () => meta.segments.reduce((sum, segment) => sum + segment.downloaded, 0);
  const worker = async () => {
    while (next < chunkCount && !context.isCancelled() && !failed) {
      const segment = meta.segments[next++]; const expected = segment.end - segment.start + 1;
      if (segment.downloaded >= expected) continue;
      try {
        await downloadSegment(value, segment.start + segment.downloaded, segment.end, fd, context, delta => { segment.downloaded += delta; onProgress(aggregated(), totalBytes); });
        fs.writeFileSync(metaPath, JSON.stringify(meta));
      } catch (error) { failed = true; throw error; }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunkCount) }, worker));
    if (context.isCancelled()) throw new Error('更新下载已取消。');
    if (aggregated() !== totalBytes) throw new Error(`下载不完整：${aggregated()}/${totalBytes} 字节。`);
    fs.closeSync(fd); fd = null;
    const hash = createHash('sha256');
    await new Promise((resolve, reject) => { const stream = fs.createReadStream(partPath); stream.on('data', chunk => hash.update(chunk)); stream.on('end', resolve); stream.on('error', reject); });
    fs.rmSync(targetPath, { force: true }); fs.renameSync(partPath, targetPath); fs.rmSync(metaPath, { force: true });
    return { totalBytes, sha256: hash.digest('hex') };
  } finally { if (fd !== null) try { fs.closeSync(fd); } catch { /* best effort */ } }
};

const downloadAsset = async (value, targetPath, context, onProgress) => {
  let lastError = null;
  for (const source of [value, ...MIRRORS.map(mirror => `${mirror}/${value}`)]) {
    try {
      const result = await probe(source, context);
      return result.rangeSupported ? await downloadParallel(source, targetPath, result.totalBytes, context, onProgress) : await downloadStream(source, targetPath, context, onProgress);
    } catch (error) {
      lastError = error; cleanupPartial(targetPath);
      if (context.isCancelled()) throw error;
    }
  }
  throw lastError || new Error('更新下载失败。');
};

module.exports = { buildProxyAgent, cleanupPartial, downloadAsset };
