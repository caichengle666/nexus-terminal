const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifyMacSignature,
  deriveManifestUrls,
  extractExpectedChecksum,
} = require('../update-verification');
const { parseSystemProxyRule, resolveRedirectUrl, validateUpdateUrl } = require('../update-network');
const { buildProxyUrl } = require('../update-download-service');
const { buildPortableLaunchScript, shouldUsePortableFallback } = require('../updater-service');
const { MESSAGES } = require('../main-i18n');

// Exact SHA256SUMS.txt and asset URLs of the real v0.9.22.45 GitHub release.
const RELEASE = 'https://github.com/caichengle666/nexus-terminal/releases/download/v0.9.22.45/';
const SHA256SUMS = [
  '71f5c411c5bf09264b28dd85cabbbc232f3ecbc69f3ecb97b292cb2db528f0fd  Nexus.Terminal.Setup.0.9.22.45.exe',
  '6392d66e301e4199a729f166afdc8971a7bd5ebc09aed512a6e157aeffa010f6  Nexus.Terminal.Portable.win-unpacked.zip',
  '891cea3b73b392420d7d3e68274ae8d1938b979245a3c9164c0fbf5cfaa70ccf  Nexus.Terminal-0.9.22.45-macOS-arm64.dmg',
  '15a459d25c7111719d8d817ba4b01c246dd0871ad3772e53dca273b90ef179fe  Nexus.Terminal-0.9.22.45-macOS-x64.dmg',
  '',
].join('\n');
// Same derivation as getSafeUpdateFilename() in main.js.
const filenameOf = value => decodeURIComponent(new URL(value).pathname).split('/').pop();

test('every real release asset resolves to its SHA-256 by the filename derived from its URL', () => {
  const expected = {
    'Nexus.Terminal.Setup.0.9.22.45.exe': '71f5c411c5bf09264b28dd85cabbbc232f3ecbc69f3ecb97b292cb2db528f0fd',
    'Nexus.Terminal.Portable.win-unpacked.zip': '6392d66e301e4199a729f166afdc8971a7bd5ebc09aed512a6e157aeffa010f6',
    'Nexus.Terminal-0.9.22.45-macOS-arm64.dmg': '891cea3b73b392420d7d3e68274ae8d1938b979245a3c9164c0fbf5cfaa70ccf',
    'Nexus.Terminal-0.9.22.45-macOS-x64.dmg': '15a459d25c7111719d8d817ba4b01c246dd0871ad3772e53dca273b90ef179fe',
  };
  for (const [name, hash] of Object.entries(expected)) {
    const url = `${RELEASE}${name}`;
    assert.doesNotThrow(() => validateUpdateUrl(url));
    assert.equal(extractExpectedChecksum(SHA256SUMS, filenameOf(url)), hash, name);
  }
});

test('manifest and signature URLs are derived from the real SHA256SUMS.txt asset', () => {
  assert.deepEqual(deriveManifestUrls(`${RELEASE}SHA256SUMS.txt`), {
    manifestUrl: `${RELEASE}SHA256SUMS.txt`,
    signatureUrl: `${RELEASE}SHA256SUMS.txt.sig`,
  });
});

test('GitHub release redirects to the asset CDNs are followed, others are refused', () => {
  const from = new URL(`${RELEASE}Nexus.Terminal.Setup.0.9.22.45.exe`);
  const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/1272359811/dbd3a78b?sp=r&sig=abc';
  assert.equal(resolveRedirectUrl(cdn, from), cdn);
  assert.ok(resolveRedirectUrl('https://objects.githubusercontent.com/x', from));
  assert.throws(() => resolveRedirectUrl('https://evil.example.com/x', from));
  assert.throws(() => resolveRedirectUrl('http://release-assets.githubusercontent.com/x', from));
});

test('parses Chromium proxy rules from session.resolveProxy()', () => {
  assert.deepEqual(parseSystemProxyRule('PROXY 127.0.0.1:7890'), { type: 'HTTP', host: '127.0.0.1', port: 7890 });
  assert.deepEqual(parseSystemProxyRule('PROXY 127.0.0.1:7890; DIRECT'), { type: 'HTTP', host: '127.0.0.1', port: 7890 });
  assert.deepEqual(parseSystemProxyRule('SOCKS5 localhost:1080'), { type: 'SOCKS5', host: 'localhost', port: 1080 });
  assert.deepEqual(parseSystemProxyRule('SOCKS5 [::1]:1080'), { type: 'SOCKS5', host: '[::1]', port: 1080 });
  assert.deepEqual(parseSystemProxyRule('HTTPS secure:443; PROXY p.lan:3128'), { type: 'HTTP', host: 'p.lan', port: 3128 });
  assert.equal(parseSystemProxyRule('DIRECT'), null);
  assert.equal(parseSystemProxyRule('DIRECT; PROXY 127.0.0.1:7890'), null);
  assert.equal(parseSystemProxyRule('SOCKS 127.0.0.1:1080'), null);
  assert.equal(parseSystemProxyRule('PROXY 127.0.0.1:99999'), null);
  assert.equal(parseSystemProxyRule(''), null);
  assert.equal(parseSystemProxyRule(undefined), null);
});

test('proxy URLs resolve DNS on the SOCKS proxy and escape credentials', () => {
  assert.equal(buildProxyUrl({ type: 'SOCKS5', host: '127.0.0.1', port: 1080 }), 'socks5h://127.0.0.1:1080');
  assert.equal(buildProxyUrl({ type: 'HTTP', host: '127.0.0.1', port: 7890 }), 'http://127.0.0.1:7890');
  const withAuth = new URL(buildProxyUrl({ type: 'HTTP', host: 'p', port: 1, username: 'a@b', password: 'p:w/d' }));
  assert.equal(withAuth.hostname, 'p');
  assert.equal(decodeURIComponent(withAuth.username), 'a@b');
  assert.equal(decodeURIComponent(withAuth.password), 'p:w/d');
});

test('an unnotarized DMG rejected by Gatekeeper is advisory, a broken signature is refused', () => {
  assert.equal(classifyMacSignature('Nexus.dmg: accepted\nsource=Notarized Developer ID', 0).status, 'valid');
  assert.equal(classifyMacSignature('Nexus.dmg: rejected\nsource=no usable signature', 3).status, 'unavailable');
  assert.equal(classifyMacSignature('Nexus.dmg: rejected\nsource=Unnotarized Developer ID', 3).status, 'unavailable');
  assert.equal(classifyMacSignature('', 1).status, 'unavailable');
  assert.equal(classifyMacSignature('Nexus.dmg: a sealed resource is missing or invalid', 3).status, 'invalid');
  assert.equal(classifyMacSignature('Nexus.dmg: CSSMERR_TP_CERT_REVOKED', 3).status, 'invalid');
});

test('the portable ZIP is only a fallback for a portable copy', () => {
  const zip = `${RELEASE}Nexus.Terminal.Portable.win-unpacked.zip`;
  assert.equal(shouldUsePortableFallback({ platform: 'win32', installationKind: 'system', primaryFilename: 'Nexus.Terminal.Setup.0.9.22.45.exe', fallbackUrl: zip }), false);
  assert.equal(shouldUsePortableFallback({ platform: 'darwin', installationKind: 'system', primaryFilename: 'Nexus.Terminal-0.9.22.45-macOS-arm64.dmg', fallbackUrl: zip }), false);
  assert.equal(shouldUsePortableFallback({ platform: 'win32', installationKind: 'portable', primaryFilename: 'Nexus.Terminal.Portable.win-unpacked.zip', fallbackUrl: zip }), false);
  assert.equal(shouldUsePortableFallback({ platform: 'win32', installationKind: 'portable', primaryFilename: 'Nexus.Terminal.Setup.0.9.22.45.exe', fallbackUrl: zip }), true);
  assert.equal(shouldUsePortableFallback({ platform: 'win32', installationKind: 'portable', primaryFilename: 'x.exe', fallbackUrl: null }), false);
});

test('portable swap waits for every process running from the target folder before deleting it', () => {
  const script = buildPortableLaunchScript({
    currentProcessId: 123,
    executable: 'C:\\temp\\portable\\Nexus Terminal.exe',
    extractPath: 'C:\\temp\\portable',
    targetDirectory: 'D:\\Apps\\Nexus Terminal\\',
    backupPath: 'C:\\temp\\backup',
    resultPath: 'C:\\temp\\portable-update-result.json',
  });
  assert.match(script, /\$targetPrefix = 'D:\\Apps\\Nexus Terminal\\'/);
  const waitIndex = script.indexOf('$_.Path.StartsWith($targetPrefix');
  assert.ok(waitIndex > script.indexOf('Wait-Process -Id $currentProcess.Id'));
  assert.ok(waitIndex < script.indexOf('Remove-Item'));
  // Without a target directory (fallback launch) nothing waits on a folder.
  const fallback = buildPortableLaunchScript({
    currentProcessId: 1, executable: 'C:\\t\\p\\Nexus Terminal.exe', extractPath: 'C:\\t\\p', targetDirectory: null, backupPath: 'C:\\t\\b', resultPath: 'C:\\t\\r.json',
  });
  assert.doesNotMatch(fallback, /targetPrefix/);
});

test('the macOS disk-image install dialog strings exist in every language', () => {
  for (const locale of Object.keys(MESSAGES)) {
    assert.ok(MESSAGES[locale].updateDetailDmg, locale);
    assert.ok(MESSAGES[locale].updateButtonDmg, locale);
  }
});
