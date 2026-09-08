const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const https = require('node:https');
const { EventEmitter } = require('node:events');

const { extractExpectedChecksum } = require('../update-verification');
const { requestWithRedirect } = require('../update-network');
const { buildMirrorUrl, downloadAsset } = require('../update-download-service');

const installerHash = 'b29261bf45a3354a0eb14e1aa5fe32461f52e8e7cd9fcf0a73af2dfeefce78d4';
const portableHash = 'e47668d8c32a34950bfdf6ac328d297f2e6ff98482580de3acdc5e46680a8318';

test('extracts an exact checksum filename match', () => {
  const manifest = `${portableHash}  Nexus Terminal Portable win-unpacked.zip`;
  assert.equal(extractExpectedChecksum(manifest, 'Nexus Terminal Portable win-unpacked.zip'), portableHash);
});

test('matches GitHub release filenames when spaces are normalized to dots', () => {
  const manifest = `${installerHash}  Nexus Terminal Setup 0.9.22.28.exe`;
  assert.equal(extractExpectedChecksum(manifest, 'Nexus.Terminal.Setup.0.9.22.28.exe'), installerHash);
});

test('does not match unrelated filenames', () => {
  const manifest = `${installerHash}  Nexus Terminal Setup 0.9.22.28.exe`;
  assert.equal(extractExpectedChecksum(manifest, 'Nexus.Terminal.Setup.0.9.22.29.exe'), null);
});

test('rejects ambiguous normalized filename matches', () => {
  const manifest = [
    `${installerHash}  Nexus Terminal Setup 0.9.22.28.exe`,
    `${portableHash}  Nexus.Terminal.Setup.0.9.22.28.exe`,
  ].join('\n');
  assert.equal(extractExpectedChecksum(manifest, 'Nexus.Terminal.Setup.0.9.22.28.exe'), null);
});

test('rejects when the update request reports socket hang up', async () => {
  const originalRequest = https.request;
  https.request = (_url, _options, callback) => {
    const request = {
      setTimeout() {},
      on(event, listener) {
        if (event === 'error') setImmediate(() => listener(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })));
        return request;
      },
      end() {
        void callback;
      },
    };
    return request;
  };
  try {
    await assert.rejects(
      requestWithRedirect('https://github.com/example/update.zip'),
      /socket hang up/,
    );
  } finally {
    https.request = originalRequest;
  }
});

test('rejects when the checksum response is aborted', async () => {
  const originalRequest = https.request;
  https.request = (_url, _options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = {};
      response.resume = () => {};
      response.setEncoding = () => {};
      response[Symbol.asyncIterator] = async function* () {
        await new Promise(resolve => setTimeout(resolve, 20));
      };
      process.nextTick(() => {
        callback(response);
        setTimeout(() => response.emit('aborted'), 0);
      });
    };
    return request;
  };
  try {
    await assert.rejects(
      require('../update-network').fetchUpdateText('https://github.com/example/checksums.txt'),
      /更新请求连接中断/,
    );
  } finally {
    https.request = originalRequest;
  }
});

test('does not pass updater-only callbacks into HTTPS request options', async () => {
  const originalRequest = https.request;
  let requestOptions;
  https.request = (_url, options, callback) => {
    requestOptions = options;
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { 'content-length': '0' };
      response.resume = () => {};
      response.setEncoding = () => {};
      response[Symbol.asyncIterator] = async function* () {};
      process.nextTick(() => callback(response));
    };
    return request;
  };
  try {
    await require('../update-network').fetchUpdateText('https://github.com/example/checksums.txt', null, {
      registerRequest: () => {},
      unregisterRequest: () => {},
    });
    assert.equal(Object.hasOwn(requestOptions, 'registerRequest'), false);
    assert.equal(Object.hasOwn(requestOptions, 'unregisterRequest'), false);
    assert.equal(Object.hasOwn(requestOptions, 'allowedHosts'), false);
  } finally {
    https.request = originalRequest;
  }
});

test('builds and validates mirror URLs', () => {
  assert.equal(
    buildMirrorUrl('https://mirror.example/{url}', 'https://github.com/example/update.zip'),
    'https://mirror.example/https://github.com/example/update.zip',
  );
  assert.equal(
    buildMirrorUrl('https://mirror.example/files', 'https://github.com/example/update.zip'),
    'https://mirror.example/files/https://github.com/example/update.zip',
  );
  assert.throws(
    () => buildMirrorUrl('http://mirror.example/{url}', 'https://github.com/example/update.zip'),
    /HTTPS/,
  );
});

test('downloads a ranged asset with the complete segment arguments', async () => {
  const originalRequest = https.request;
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-updater-test-'));
  const targetPath = path.join(temporaryDirectory, 'update.zip');
  const body = Buffer.from('ranged update');
  let requestCount = 0;
  https.request = (_url, options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = () => {};
    request.end = () => {
      requestCount += 1;
      const isProbe = requestCount === 1;
      const response = new EventEmitter();
      response.headers = isProbe
        ? { 'content-range': `bytes 0-0/${body.length}`, 'content-length': '1' }
        : { 'content-range': `bytes 0-${body.length - 1}/${body.length}` };
      response.statusCode = 206;
      response.resume = () => {};
      process.nextTick(() => {
        callback(response);
        if (!isProbe) {
          response.emit('data', body);
          response.emit('end');
        }
      });
    };
    return request;
  };
  try {
    const result = await downloadAsset('https://github.com/example/update.zip', targetPath, {
      agent: null,
      isCancelled: () => false,
      registerRequest: () => {},
      unregisterRequest: () => {},
      registerFile: () => {},
      abortRequests: () => {},
    }, () => {});
    assert.equal(fs.readFileSync(targetPath).toString(), body.toString());
    assert.equal(result.totalBytes, body.length);
  } finally {
    https.request = originalRequest;
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('falls back to a stream download when ranged downloading fails', async () => {
  const originalRequest = https.request;
  const originalGet = https.get;
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-updater-fallback-test-'));
  const targetPath = path.join(temporaryDirectory, 'update.zip');
  const body = Buffer.from('stream fallback update');
  let requestCount = 0;
  const stages = [];
  https.request = (_url, _options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = () => {};
    request.end = () => {
      requestCount += 1;
      const response = new EventEmitter();
      response.resume = () => {};
      if (requestCount === 1) {
        response.statusCode = 206;
        response.headers = { 'content-range': `bytes 0-0/${body.length}`, 'content-length': '1' };
        process.nextTick(() => callback(response));
        return;
      }
      process.nextTick(() => request.emit('error', Object.assign(new Error('range connection reset'), { code: 'ECONNRESET' })));
    };
    return request;
  };
  https.get = (_url, _options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = () => {};
    const response = new EventEmitter();
    response.statusCode = 200;
    response.headers = { 'content-length': String(body.length) };
    process.nextTick(() => {
      callback(response);
      response.emit('data', body);
      response.emit('end');
    });
    return request;
  };
  try {
    const result = await downloadAsset('https://github.com/example/update.zip', targetPath, {
      agent: null,
      isCancelled: () => false,
      registerRequest: () => {},
      unregisterRequest: () => {},
      registerFile: () => {},
      abortRequests: () => {},
      onStage: stage => stages.push(stage),
    }, () => {});
    assert.equal(fs.readFileSync(targetPath).toString(), body.toString());
    assert.equal(result.totalBytes, body.length);
    assert.equal(stages.includes('parallel-failed'), true);
  } finally {
    https.request = originalRequest;
    https.get = originalGet;
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('keeps partial update files available after a network failure', async () => {
  const originalRequest = https.request;
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-updater-resume-test-'));
  const targetPath = path.join(temporaryDirectory, 'update.zip');
  const partialPath = `${targetPath}.part`;
  const metadataPath = `${targetPath}.meta.json`;
  fs.writeFileSync(partialPath, 'partial');
  fs.writeFileSync(metadataPath, '{"url":"https://github.com/example/update.zip"}');
  https.request = (_url, _options, _callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.end = () => process.nextTick(() => request.emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })));
    request.destroy = () => {};
    return request;
  };
  try {
    await assert.rejects(
      downloadAsset('https://github.com/example/update.zip', targetPath, {
        agent: null,
        isCancelled: () => false,
        registerRequest: () => {},
        unregisterRequest: () => {},
        registerFile: () => {},
        abortRequests: () => {},
      }, () => {}),
      /socket hang up/,
    );
    assert.equal(fs.existsSync(partialPath), true);
    assert.equal(fs.existsSync(metadataPath), true);
  } finally {
    https.request = originalRequest;
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
