const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const {
  LATEST_RELEASE_API_URL,
  LATEST_RELEASE_PAGE_URL,
  buildMirrorCheckUrl,
  checkLatestRelease,
  classifyReleaseCheckError,
  createNetTransport,
  createNodeTransport,
  getDefaultAssetNames,
  normalizeApiRelease,
  parseChecksumAssetNames,
  parseTagFromText,
  releaseFromTag,
  validateReleaseCheckUrl,
} = require('../update-release-check');
const { checkForStartupUpdate } = require('../update-startup-check');

const quiet = { warn() {} };
const DOWNLOAD = 'https://github.com/caichengle666/nexus-terminal/releases/download/v0.9.23.2/';
// Real v0.9.23.2 release (GitHub API, 2026-10).
const API_RELEASE = {
  tag_name: 'v0.9.23.2',
  html_url: 'https://github.com/caichengle666/nexus-terminal/releases/tag/v0.9.23.2',
  draft: false,
  prerelease: false,
  assets: [
    'Nexus.Terminal-0.9.23.2-macOS-arm64.dmg',
    'Nexus.Terminal-0.9.23.2-macOS-x64.dmg',
    'Nexus.Terminal.Portable.win-unpacked.zip',
    'Nexus.Terminal.Setup.0.9.23.2.exe',
    'SHA256SUMS.txt',
  ].map(name => ({ name, browser_download_url: `${DOWNLOAD}${name}` })),
};
const SUMS = [
  '579eeb9b3988ed26101cd3f2c9fdae03ec6559d0b8282f61811f6695273e4675  Nexus.Terminal.Setup.0.9.23.2.exe',
  'adf96aac6a923e2b253c23fffa207554c7c5b79a32d81a2b62750230b9451b3c  Nexus.Terminal.Portable.win-unpacked.zip',
  '22111831282a5b56ed608c50e04d87629212166ad01cec09a1c3825cc0c76904  Nexus.Terminal-0.9.23.2-macOS-arm64.dmg',
  '33d0db622c8848bbfd254b3abf37e81aacf33be186474d75bc301ffc4e391b09  Nexus.Terminal-0.9.23.2-macOS-x64.dmg',
].join('\n');

const netError = message => Object.assign(new Error(message), {});

// Fake transport: routes map url -> response object | Error | function.
const fakeTransport = routes => {
  const calls = [];
  const transport = async (url, options) => {
    calls.push(url);
    const route = routes[url];
    if (!route) throw netError('net::ERR_NAME_NOT_RESOLVED');
    const value = typeof route === 'function' ? route(url, options) : route;
    if (value instanceof Error) throw value;
    return value;
  };
  transport.calls = calls;
  return transport;
};

test('URL policy only allows this repository\'s release check endpoints', () => {
  assert.ok(validateReleaseCheckUrl(LATEST_RELEASE_API_URL));
  assert.ok(validateReleaseCheckUrl(LATEST_RELEASE_PAGE_URL));
  assert.ok(validateReleaseCheckUrl('https://github.com/caichengle666/nexus-terminal/releases/tag/v0.9.23.2'));
  assert.ok(validateReleaseCheckUrl(`${DOWNLOAD}SHA256SUMS.txt`));
  assert.ok(validateReleaseCheckUrl('https://release-assets.githubusercontent.com/x', { isRedirect: true }));
  for (const bad of [
    'http://api.github.com/repos/caichengle666/nexus-terminal/releases/latest',
    'https://api.github.com/repos/someone/else/releases/latest',
    'https://api.github.com:8443/repos/caichengle666/nexus-terminal/releases/latest',
    'https://github.com/someone/else/releases/latest',
    'https://github.com/caichengle666/nexus-terminal/releases/tag/evil',
    'https://u:p@github.com/caichengle666/nexus-terminal/releases/latest',
    'https://release-assets.githubusercontent.com/x',
    'https://evil.example/caichengle666/nexus-terminal/releases/latest',
  ]) {
    assert.throws(() => validateReleaseCheckUrl(bad), /refused|invalid/, bad);
  }
  // A mirror host is allowed only when configured, and can never impersonate GitHub.
  assert.ok(validateReleaseCheckUrl('https://ghproxy.example/anything', { mirrorHosts: new Set(['ghproxy.example']) }));
  assert.throws(() => validateReleaseCheckUrl('https://github.com/x', { mirrorHosts: new Set(['github.com']) }));
});

test('mirror URLs wrap the source URL and keep the mirror host', () => {
  assert.equal(buildMirrorCheckUrl('https://ghproxy.example/', LATEST_RELEASE_API_URL), `https://ghproxy.example/${LATEST_RELEASE_API_URL}`);
  assert.equal(buildMirrorCheckUrl('https://m.example/p?u={url}', LATEST_RELEASE_PAGE_URL), `https://m.example/p?u=${LATEST_RELEASE_PAGE_URL}`);
  assert.throws(() => buildMirrorCheckUrl('http://m.example', LATEST_RELEASE_API_URL));
  assert.throws(() => buildMirrorCheckUrl('https://m.example', 'https://evil.example/x'));
});

test('tags are parsed from redirect URLs, mirror URLs and release pages (highest wins)', () => {
  assert.equal(parseTagFromText('https://github.com/caichengle666/nexus-terminal/releases/tag/v0.9.23.2'), 'v0.9.23.2');
  assert.equal(parseTagFromText('https://m.example/https://github.com/caichengle666/nexus-terminal/releases/tag/v0.9.23.2?x=1'), 'v0.9.23.2');
  assert.equal(parseTagFromText('<a href="/caichengle666/nexus-terminal/releases/tag/v0.9.22.9">old</a> <a href="/caichengle666/nexus-terminal/releases/tag/v0.9.23.2">'), 'v0.9.23.2');
  assert.equal(parseTagFromText('/caichengle666/nexus-terminal/releases/tag/v1.0-beta'), null);
  assert.equal(parseTagFromText('/other/repo/releases/tag/v9.9.9'), null);
});

test('assets rebuilt from a tag match the real release and the electron-builder naming', () => {
  const release = releaseFromTag('v0.9.23.2');
  const byName = Object.fromEntries(release.assets.map(asset => [asset.name, asset.browser_download_url]));
  for (const asset of API_RELEASE.assets) assert.equal(byName[asset.name], asset.browser_download_url, asset.name);
  assert.equal(release.html_url, API_RELEASE.html_url);
  // Keep the known naming in sync with electron-app/package.json (spaces become dots on GitHub).
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const version = pkg.releaseVersion;
  const expand = (pattern, extra) => pattern.replace('${productName}', pkg.build.productName).replaceAll('${ext}', extra.ext).replace('${arch}', extra.arch || '').replace(/ /g, '.');
  const names = getDefaultAssetNames(`v${version}`);
  assert.ok(names.includes(expand(pkg.build.nsis.artifactName, { ext: 'exe' })));
  assert.ok(names.includes(expand(pkg.build.mac.artifactName, { ext: 'dmg', arch: 'arm64' })));
  assert.ok(names.includes(expand(pkg.build.mac.artifactName, { ext: 'dmg', arch: 'x64' })));
  const workflow = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'build-electron.yml'), 'utf8');
  assert.ok(workflow.includes('Nexus Terminal Portable win-unpacked.zip'));
  assert.ok(names.includes('Nexus.Terminal.Portable.win-unpacked.zip'));
});

test('API release normalisation keeps only official asset URLs', () => {
  const release = normalizeApiRelease({
    ...API_RELEASE,
    html_url: 'https://evil.example/',
    assets: [...API_RELEASE.assets, { name: 'x.exe', browser_download_url: 'https://evil.example/x.exe' }],
  });
  assert.equal(release.assets.length, 5);
  assert.equal(release.html_url, API_RELEASE.html_url);
  assert.throws(() => normalizeApiRelease({ ...API_RELEASE, draft: true }));
  assert.throws(() => normalizeApiRelease({ ...API_RELEASE, tag_name: '<script>' }));
});

test('checksum manifest names are read with GitHub space normalisation', () => {
  assert.deepEqual(parseChecksumAssetNames(`${SUMS}\n`).length, 4);
  assert.deepEqual(parseChecksumAssetNames('579eeb9b3988ed26101cd3f2c9fdae03ec6559d0b8282f61811f6695273e4675  Nexus Terminal Setup 1.0.exe'), ['Nexus.Terminal.Setup.1.0.exe']);
  assert.deepEqual(parseChecksumAssetNames('579eeb9b3988ed26101cd3f2c9fdae03ec6559d0b8282f61811f6695273e4675  ../evil'), []);
});

test('network errors are classified into a short reason', () => {
  assert.equal(classifyReleaseCheckError(new Error('net::ERR_NAME_NOT_RESOLVED')).code, 'dns');
  assert.equal(classifyReleaseCheckError(Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), { code: 'ENOTFOUND' })).code, 'dns');
  assert.equal(classifyReleaseCheckError(new Error('net::ERR_CONNECTION_TIMED_OUT')).code, 'timeout');
  assert.equal(classifyReleaseCheckError(new Error('net::ERR_CONNECTION_RESET')).code, 'reset');
  assert.equal(classifyReleaseCheckError(new Error('net::ERR_PROXY_CONNECTION_FAILED')).code, 'proxy');
  assert.equal(classifyReleaseCheckError(new Error('net::ERR_CERT_AUTHORITY_INVALID')).code, 'tls');
  assert.equal(classifyReleaseCheckError(new Error('net::ERR_INTERNET_DISCONNECTED')).code, 'offline');
  assert.equal(classifyReleaseCheckError(new Error('weird')).code, 'network');
});

test('api.github.com success is used directly', async () => {
  const transport = fakeTransport({ [LATEST_RELEASE_API_URL]: { status: 200, body: JSON.stringify(API_RELEASE) } });
  const result = await checkLatestRelease({ transport, log: quiet });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'api.github.com');
  assert.equal(result.release.tag_name, 'v0.9.23.2');
  assert.equal(result.release.assets.length, 5);
  assert.deepEqual(transport.calls, [LATEST_RELEASE_API_URL]);
});

test('falls back to the github.com releases/latest redirect when the API is blocked', async () => {
  const transport = fakeTransport({
    [LATEST_RELEASE_API_URL]: netError('net::ERR_CONNECTION_TIMED_OUT'),
    [LATEST_RELEASE_PAGE_URL]: { status: 302, location: 'https://github.com/caichengle666/nexus-terminal/releases/tag/v0.9.23.2' },
    [`${DOWNLOAD}SHA256SUMS.txt`]: { status: 302, location: 'https://release-assets.githubusercontent.com/github-production-release-asset/1' },
    'https://release-assets.githubusercontent.com/github-production-release-asset/1': { status: 200, body: SUMS },
  });
  const result = await checkLatestRelease({ transport, log: quiet });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'github.com');
  assert.equal(result.release.tag_name, 'v0.9.23.2');
  assert.deepEqual(result.release.assets.map(asset => asset.name).sort(), API_RELEASE.assets.map(asset => asset.name).sort());
  assert.deepEqual(result.attempts.map(({ source, ok, code }) => ({ source, ok, code })), [
    { source: 'api.github.com', ok: false, code: 'timeout' },
    { source: 'github.com', ok: true, code: undefined },
  ]);
});

test('a rate-limited API (403) still finds the release through github.com, with default names when SHA256SUMS is unreachable', async () => {
  const transport = fakeTransport({
    [LATEST_RELEASE_API_URL]: { status: 403, body: '{"message":"API rate limit exceeded"}' },
    [LATEST_RELEASE_PAGE_URL]: { status: 302, location: '/caichengle666/nexus-terminal/releases/tag/v0.9.24' },
  });
  const result = await checkLatestRelease({ transport, log: quiet });
  assert.equal(result.ok, true);
  assert.equal(result.release.tag_name, 'v0.9.24');
  assert.ok(result.release.assets.some(asset => asset.name === 'Nexus.Terminal.Setup.0.9.24.exe'));
  assert.equal(result.attempts[0].code, 'rate-limit');
  assert.equal(result.attempts[0].status, 403);
});

test('redirects to foreign hosts are refused', async () => {
  const transport = fakeTransport({
    [LATEST_RELEASE_API_URL]: { status: 302, location: 'https://evil.example/release.json' },
    [LATEST_RELEASE_PAGE_URL]: { status: 302, location: 'https://evil.example/caichengle666/nexus-terminal/releases/tag/v9.9.9' },
  });
  const result = await checkLatestRelease({ transport, log: quiet });
  assert.equal(result.ok, false);
  assert.deepEqual(result.attempts.map(attempt => attempt.code), ['blocked', 'blocked']);
  assert.ok(!transport.calls.some(url => url.startsWith('https://evil.example')));
});

test('configured mirrors are tried last: API JSON first, then the releases page', async () => {
  const mirror = 'https://ghproxy.example';
  const transport = fakeTransport({
    [`${mirror}/${LATEST_RELEASE_API_URL}`]: { status: 404, body: 'not supported' },
    // The mirror follows the redirect itself and returns the tag page.
    [`${mirror}/${LATEST_RELEASE_PAGE_URL}`]: { status: 302, location: `${mirror}/page` },
    [`${mirror}/page`]: { status: 200, body: '<html><a href="/caichengle666/nexus-terminal/releases/tag/v0.9.23.2">v0.9.23.2</a></html>' },
  });
  const result = await checkLatestRelease({ transport, mirrorUrls: [mirror, 'http://insecure.example'], log: quiet });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'ghproxy.example');
  assert.equal(result.release.tag_name, 'v0.9.23.2');
  assert.ok(result.release.assets.every(asset => asset.browser_download_url.startsWith(DOWNLOAD)));
  assert.deepEqual(result.attempts.map(attempt => attempt.step), ['api', 'page', 'mirror-api', 'mirror-page']);
});

test('when everything fails every attempt carries its reason', async () => {
  const transport = fakeTransport({
    [LATEST_RELEASE_API_URL]: netError('net::ERR_NAME_NOT_RESOLVED'),
    [LATEST_RELEASE_PAGE_URL]: { status: 503, body: '' },
  });
  const result = await checkLatestRelease({ transport, mirrorUrls: ['http://bad.example'], log: quiet });
  assert.equal(result.ok, false);
  assert.deepEqual(result.attempts.map(({ source, code, status }) => ({ source, code, status })), [
    { source: 'api.github.com', code: 'dns', status: undefined },
    { source: 'github.com', code: 'http', status: 503 },
    { source: 'http://bad.example', code: 'blocked', status: undefined },
  ]);
});

// --- transports ------------------------------------------------------------

const fakeNetRequest = script => {
  const requests = [];
  const netRequest = options => {
    const request = new EventEmitter();
    request.options = options;
    request.headers = {};
    request.aborted = false;
    request.setHeader = (name, value) => { request.headers[name] = value; };
    request.abort = () => { request.aborted = true; };
    request.end = () => setImmediate(() => script(request));
    requests.push(request);
    return request;
  };
  netRequest.requests = requests;
  return netRequest;
};

test('net transport reports redirects without following them and reads bodies', async () => {
  const redirecting = fakeNetRequest(request => request.emit('redirect', 302, 'GET', 'https://github.com/caichengle666/nexus-terminal/releases/tag/v1.2.3', {}));
  const redirect = await createNetTransport(redirecting)(LATEST_RELEASE_PAGE_URL);
  assert.deepEqual(redirect, { status: 302, location: 'https://github.com/caichengle666/nexus-terminal/releases/tag/v1.2.3' });
  assert.equal(redirecting.requests[0].options.redirect, 'manual');
  assert.equal(redirecting.requests[0].aborted, true);
  assert.equal(redirecting.requests[0].headers['User-Agent'], 'Nexus-Terminal-Updater');

  const ok = fakeNetRequest(request => {
    const response = new EventEmitter();
    response.statusCode = 200;
    response.headers = {};
    request.emit('response', response);
    response.emit('data', Buffer.from('{"a":'));
    response.emit('data', Buffer.from('1}'));
    response.emit('end');
  });
  assert.deepEqual(await createNetTransport(ok)(LATEST_RELEASE_API_URL), { status: 200, body: '{"a":1}' });
});

test('net transport times out and surfaces Chromium net errors', async () => {
  const silent = fakeNetRequest(() => {});
  await assert.rejects(createNetTransport(silent)(LATEST_RELEASE_API_URL, { timeoutMs: 20 }), error => error.checkCode === 'timeout');
  assert.equal(silent.requests[0].aborted, true);
  const failing = fakeNetRequest(request => request.emit('error', new Error('net::ERR_NAME_NOT_RESOLVED')));
  await assert.rejects(createNetTransport(failing)(LATEST_RELEASE_API_URL), error => classifyReleaseCheckError(error).code === 'dns');
});

test('net transport enforces the size limit', async () => {
  const big = fakeNetRequest(request => {
    const response = new EventEmitter();
    response.statusCode = 200;
    response.headers = {};
    request.emit('response', response);
    response.emit('data', Buffer.alloc(64));
  });
  await assert.rejects(createNetTransport(big)(LATEST_RELEASE_API_URL, { maxBytes: 16 }), error => error.checkCode === 'too-large');
});

test('node transport uses the given proxy agent and does not follow redirects', async () => {
  const seen = [];
  const httpsModule = {
    request(url, options, onResponse) {
      seen.push({ url: url.href, agent: options.agent });
      const request = new EventEmitter();
      request.destroy = () => {};
      request.end = () => setImmediate(() => {
        const response = new EventEmitter();
        response.statusCode = 302;
        response.headers = { location: 'https://github.com/caichengle666/nexus-terminal/releases/tag/v1.0.0' };
        response.resume = () => {};
        onResponse(response);
      });
      return request;
    },
  };
  const agent = { proxy: true };
  const result = await createNodeTransport({ agent, httpsModule })(LATEST_RELEASE_PAGE_URL);
  assert.equal(result.status, 302);
  assert.equal(result.location, 'https://github.com/caichengle666/nexus-terminal/releases/tag/v1.0.0');
  assert.equal(seen[0].agent, agent);
});

test('startup check can use the robust release check', async () => {
  const update = await checkForStartupUpdate({
    currentVersion: '0.9.23.2',
    log: quiet,
    checkImpl: async () => ({ ok: true, release: releaseFromTag('v0.9.24') }),
  });
  assert.deepEqual(update, { version: 'v0.9.24', url: 'https://github.com/caichengle666/nexus-terminal/releases/tag/v0.9.24' });
  assert.equal(await checkForStartupUpdate({ currentVersion: '0.9.23.2', log: quiet, checkImpl: async () => ({ ok: false, attempts: [] }) }), null);
  assert.equal(await checkForStartupUpdate({ currentVersion: '0.9.23.2', log: quiet, checkImpl: async () => { throw new Error('boom'); } }), null);
});

test('main process exposes the check over trusted IPC and preload forwards it', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(main, /handleTrusted\('check-latest-release'/);
  assert.match(main, /net\.request\(\{ \.\.\.options, session: session\.defaultSession \}\)/);
  assert.match(preload, /checkLatestRelease: \(payload\) => ipcRenderer\.invoke\('check-latest-release', payload\)/);
});
