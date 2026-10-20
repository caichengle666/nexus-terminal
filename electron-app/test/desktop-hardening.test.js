const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const test = require('node:test');

const {
  isAllowedLocalHostHeader,
  isAllowedSubframeNavigation,
  isRendererPermissionAllowed,
} = require('../security-utils');
const {
  isReleaseDownloadPath,
  requestWithRedirect,
  resolveRedirectUrl,
  validateUpdateUrl,
} = require('../update-network');
const { buildMirrorUrl } = require('../update-download-service');

const TRUSTED = ['http://localhost:22457'];
const RELEASE = 'https://github.com/caichengle666/nexus-terminal/releases/download/v0.9.22.46/';
const CDN = 'https://release-assets.githubusercontent.com/github-production-release-asset/1/abc?sig=x';

// ---------------------------------------------------------------------------
// Updater URL restriction
// ---------------------------------------------------------------------------

test('update URLs must be this repository\'s GitHub release downloads', () => {
  assert.doesNotThrow(() => validateUpdateUrl(`${RELEASE}SHA256SUMS.txt`));
  assert.doesNotThrow(() => validateUpdateUrl(`${RELEASE}Nexus.Terminal.Setup.0.9.22.46.exe`));
  assert.throws(() => validateUpdateUrl('https://github.com/attacker/nexus-terminal/releases/download/v1/x.exe'));
  assert.throws(() => validateUpdateUrl('https://github.com/caichengle666/other-repo/releases/download/v1/x.exe'));
  assert.throws(() => validateUpdateUrl('https://github.com/caichengle666/nexus-terminal/archive/refs/heads/main.zip'));
  assert.throws(() => validateUpdateUrl('https://github.com/caichengle666/nexus-terminal/releases/download/'));
  assert.throws(() => validateUpdateUrl('https://github.com/caichengle666/nexus-terminal/releases/download/../../../attacker/x/releases/download/v1/x.exe'));
  assert.throws(() => validateUpdateUrl('https://github.com/caichengle666/nexus-terminal/releases/download/%2e%2e/%2e%2e/%2e%2e/attacker/x.exe'));
  assert.throws(() => validateUpdateUrl(`http://github.com/caichengle666/nexus-terminal/releases/download/v1/x.exe`));
  assert.throws(() => validateUpdateUrl(`https://user:pw@github.com/caichengle666/nexus-terminal/releases/download/v1/x.exe`));
  assert.throws(() => validateUpdateUrl(`https://github.com:8443/caichengle666/nexus-terminal/releases/download/v1/x.exe`));
  assert.throws(() => validateUpdateUrl('https://evil.example.com/caichengle666/nexus-terminal/releases/download/v1/x.exe'));
});

test('GitHub asset CDNs are only accepted as redirect targets', () => {
  assert.throws(() => validateUpdateUrl(CDN));
  assert.throws(() => validateUpdateUrl('https://objects.githubusercontent.com/x'));
  assert.doesNotThrow(() => validateUpdateUrl(CDN, undefined, { isRedirect: true }));
  assert.equal(resolveRedirectUrl(CDN, new URL(`${RELEASE}x.exe`)), CDN);
  // A redirect to another repository on github.com is still refused.
  assert.throws(() => resolveRedirectUrl('https://github.com/attacker/x/releases/download/v1/x.exe', new URL(`${RELEASE}x.exe`)));
});

test('release path helper', () => {
  assert.equal(isReleaseDownloadPath('/caichengle666/nexus-terminal/releases/download/v1/a.zip'), true);
  assert.equal(isReleaseDownloadPath('/caichengle666/nexus-terminal/releases/latest'), false);
  assert.equal(isReleaseDownloadPath('/CaiChengLe666/nexus-terminal/releases/download/v1/a.zip'), false);
});

test('mirror URLs are only built for official release sources', () => {
  assert.equal(
    buildMirrorUrl('https://mirror.example/{url}', `${RELEASE}a.zip`),
    `https://mirror.example/${RELEASE}a.zip`,
  );
  assert.throws(() => buildMirrorUrl('https://mirror.example/{url}', 'https://github.com/attacker/x/releases/download/v1/a.zip'));
});

const mockRedirectChain = responses => {
  const requested = [];
  const originalRequest = https.request;
  https.request = (url, _options, callback) => {
    requested.push(String(url.href || url));
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.end = () => {
      const next = responses.shift();
      const response = new EventEmitter();
      response.statusCode = next.status;
      response.headers = next.location ? { location: next.location } : {};
      response.resume = () => {};
      process.nextTick(() => callback(response));
    };
    return request;
  };
  return { requested, restore: () => { https.request = originalRequest; } };
};

test('requestWithRedirect follows release -> CDN but refuses a CDN start URL', async () => {
  const chain = mockRedirectChain([{ status: 302, location: CDN }, { status: 200 }]);
  try {
    const { url } = await requestWithRedirect(`${RELEASE}a.zip`, { method: 'GET' });
    assert.equal(url, CDN);
    assert.deepEqual(chain.requested, [`${RELEASE}a.zip`, CDN]);
  } finally {
    chain.restore();
  }
  await assert.rejects(requestWithRedirect(CDN, { method: 'GET' }), /官方 GitHub Release/);
});

// ---------------------------------------------------------------------------
// Local server / renderer policy
// ---------------------------------------------------------------------------

test('local proxy accepts only loopback Host headers for its own port', () => {
  assert.equal(isAllowedLocalHostHeader('localhost:22457', 22457), true);
  assert.equal(isAllowedLocalHostHeader('127.0.0.1:22457', 22457), true);
  assert.equal(isAllowedLocalHostHeader('LOCALHOST:22457', 22457), true);
  assert.equal(isAllowedLocalHostHeader('localhost', 22457), false);
  assert.equal(isAllowedLocalHostHeader('localhost:22458', 22457), false);
  assert.equal(isAllowedLocalHostHeader('evil.example.com:22457', 22457), false);
  assert.equal(isAllowedLocalHostHeader('192.168.1.5:22457', 22457), false);
  assert.equal(isAllowedLocalHostHeader('localhost.evil.com:22457', 22457), false);
  assert.equal(isAllowedLocalHostHeader(undefined, 22457), false);
  assert.equal(isAllowedLocalHostHeader('', 22457), false);
});

test('permissions are denied by default and only allowlisted ones granted to the trusted origin', () => {
  for (const permission of ['clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen']) {
    assert.equal(isRendererPermissionAllowed(permission, 'http://localhost:22457/#/workspace', TRUSTED), true, permission);
    assert.equal(isRendererPermissionAllowed(permission, 'https://evil.example.com/', TRUSTED), false, permission);
    assert.equal(isRendererPermissionAllowed(permission, 'data:text/html,x', TRUSTED), false, permission);
  }
  for (const permission of ['openExternal', 'media', 'geolocation', 'midi', 'midiSysex', 'hid', 'serial', 'usb',
    'pointerLock', 'display-capture', 'mediaKeySystem', 'idle-detection', 'unknown']) {
    assert.equal(isRendererPermissionAllowed(permission, 'http://localhost:22457/', TRUSTED), false, permission);
  }
  assert.equal(isRendererPermissionAllowed(undefined, 'http://localhost:22457/', TRUSTED), false);
});

test('sub-frame navigations: trusted origin, blank and https only', () => {
  assert.equal(isAllowedSubframeNavigation('about:blank', TRUSTED), true);
  assert.equal(isAllowedSubframeNavigation('about:srcdoc', TRUSTED), true);
  assert.equal(isAllowedSubframeNavigation('http://localhost:22457/x', TRUSTED), true);
  assert.equal(isAllowedSubframeNavigation('https://newassets.hcaptcha.com/captcha/v1/x', TRUSTED), true);
  assert.equal(isAllowedSubframeNavigation('file:///C:/Windows/win.ini', TRUSTED), false);
  assert.equal(isAllowedSubframeNavigation('http://evil.example.com/', TRUSTED), false);
  assert.equal(isAllowedSubframeNavigation('data:text/html,<script>1</script>', TRUSTED), false);
  assert.equal(isAllowedSubframeNavigation('javascript:alert(1)', TRUSTED), false);
  assert.equal(isAllowedSubframeNavigation('ms-settings:', TRUSTED), false);
  assert.equal(isAllowedSubframeNavigation('', TRUSTED), false);
});

// ---------------------------------------------------------------------------
// Startup update check
// ---------------------------------------------------------------------------

const {
  LATEST_RELEASE_API_URL,
  checkForStartupUpdate,
  getAvailableUpdate,
  isVersionNewer,
} = require('../update-startup-check');

test('startup check compares versions like the About page', () => {
  assert.equal(isVersionNewer('v0.9.22.47', '0.9.22.46'), true);
  assert.equal(isVersionNewer('v0.9.23', '0.9.22.46'), true);
  assert.equal(isVersionNewer('v0.9.22.46', '0.9.22.46'), false);
  assert.equal(isVersionNewer('v0.9.22', '0.9.22.46'), false);
});

test('startup check only reports a newer, published, well-formed release', () => {
  const release = { tag_name: 'v0.9.22.47', html_url: 'https://github.com/caichengle666/nexus-terminal/releases/tag/v0.9.22.47' };
  assert.deepEqual(getAvailableUpdate(release, '0.9.22.46'), { version: 'v0.9.22.47', url: release.html_url });
  assert.equal(getAvailableUpdate(release, '0.9.22.47'), null);
  assert.equal(getAvailableUpdate({ ...release, prerelease: true }, '0.9.22.46'), null);
  assert.equal(getAvailableUpdate({ ...release, draft: true }, '0.9.22.46'), null);
  assert.equal(getAvailableUpdate({ ...release, tag_name: '<img src=x>' }, '0.9.22.46'), null);
  assert.equal(getAvailableUpdate({ ...release, html_url: 'https://evil.example.com/' }, '0.9.22.46').url,
    'https://github.com/caichengle666/nexus-terminal/releases/latest');
  assert.equal(getAvailableUpdate(null, '0.9.22.46'), null);
});

test('startup check is silent on network or HTTP errors', async () => {
  const quiet = { warn() {} };
  let requested;
  const ok = await checkForStartupUpdate({
    currentVersion: '0.9.22.46',
    log: quiet,
    fetchImpl: async target => {
      requested = target;
      return { status: 200, text: async () => JSON.stringify({ tag_name: 'v0.9.22.50', html_url: 'https://github.com/caichengle666/nexus-terminal/releases/tag/v0.9.22.50' }) };
    },
  });
  assert.equal(requested, LATEST_RELEASE_API_URL);
  assert.equal(ok.version, 'v0.9.22.50');
  assert.equal(await checkForStartupUpdate({ currentVersion: '0.9.22.46', log: quiet, fetchImpl: async () => ({ status: 403, text: async () => '' }) }), null);
  assert.equal(await checkForStartupUpdate({ currentVersion: '0.9.22.46', log: quiet, fetchImpl: async () => { throw new Error('offline'); } }), null);
  assert.equal(await checkForStartupUpdate({ currentVersion: '0.9.22.46', log: quiet, fetchImpl: async () => ({ status: 200, text: async () => 'not json' }) }), null);
});
