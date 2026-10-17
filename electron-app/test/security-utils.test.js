const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildRdpFileContent,
  hasBlockedOpenPathExtension,
  isSafeExternalUrl,
  isTrustedOrigin,
  sanitizeRdpConnection,
  validateOpenPathRequest,
} = require('../security-utils');

const TRUSTED = ['http://localhost:22457'];

test('trusts only the exact frontend origin', () => {
  assert.equal(isTrustedOrigin('http://localhost:22457/', TRUSTED), true);
  assert.equal(isTrustedOrigin('http://localhost:22457/#/settings?x=1', TRUSTED), true);
  assert.equal(isTrustedOrigin('blob:http://localhost:22457/3f2c', TRUSTED), true);
  assert.equal(isTrustedOrigin('http://localhost:22458/', TRUSTED), false);
  assert.equal(isTrustedOrigin('https://localhost:22457/', TRUSTED), false);
  assert.equal(isTrustedOrigin('http://localhost.evil.com:22457/', TRUSTED), false);
  assert.equal(isTrustedOrigin('http://127.0.0.1:22457/', TRUSTED), false);
  assert.equal(isTrustedOrigin('data:text/html,hi', TRUSTED), false);
  assert.equal(isTrustedOrigin('file:///etc/passwd', TRUSTED), false);
  assert.equal(isTrustedOrigin('not a url', TRUSTED), false);
  assert.equal(isTrustedOrigin(null, TRUSTED), false);
});

test('only plain http(s) URLs may be opened externally', () => {
  assert.equal(isSafeExternalUrl('https://github.com/caichengle666/nexus-terminal'), true);
  assert.equal(isSafeExternalUrl('http://example.com/a?b=c'), true);
  assert.equal(isSafeExternalUrl('file:///C:/Windows/System32/calc.exe'), false);
  assert.equal(isSafeExternalUrl('javascript:alert(1)'), false);
  assert.equal(isSafeExternalUrl('smb://attacker/share'), false);
  assert.equal(isSafeExternalUrl('ms-msdt:/id PCWDiagnostic'), false);
  assert.equal(isSafeExternalUrl('https://user:pass@example.com/'), false);
  assert.equal(isSafeExternalUrl(42), false);
});

test('refuses executable extensions for open-path', () => {
  for (const name of [
    'C:\\Users\\a\\evil.exe', 'C:\\x\\run.BAT', 'C:\\x\\a.cmd', 'C:\\x\\a.com', 'C:\\x\\a.ps1', 'C:\\x\\a.vbs',
    'C:\\x\\a.js', 'C:\\x\\setup.msi', 'C:\\x\\link.lnk', 'C:\\x\\a.scr', '/home/a/run.sh', '/Applications/Calc.app',
    '/Users/a/x.command', 'C:\\x\\evil.exe.', 'C:\\x\\evil.exe  ', '/Applications/Calc.app/Contents/MacOS',
  ]) {
    assert.equal(hasBlockedOpenPathExtension(name), true, name);
  }
  for (const name of ['C:\\Users\\a\\Documents', '/home/a/.config/nexus', '/tmp/history', 'C:\\x\\notes.txt', '/srv/data.v2']) {
    assert.equal(hasBlockedOpenPathExtension(name), false, name);
  }
});

test('open-path validation allows existing directories only', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-open-path-'));
  const file = path.join(directory, 'note.txt');
  const exe = path.join(directory, 'tool.exe');
  const appBundle = path.join(directory, 'Fake.app');
  fs.writeFileSync(file, 'x');
  fs.writeFileSync(exe, 'x');
  fs.mkdirSync(appBundle);
  const platform = process.platform === 'win32' ? 'win32' : 'linux';
  try {
    const allowed = validateOpenPathRequest(directory, { platform });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.path, fs.realpathSync(directory));
    assert.equal(validateOpenPathRequest(file, { platform }).ok, false);
    assert.equal(validateOpenPathRequest(exe, { platform }).ok, false);
    assert.equal(validateOpenPathRequest(appBundle, { platform }).ok, false);
    assert.equal(validateOpenPathRequest(path.join(directory, 'missing'), { platform }).ok, false);
    assert.equal(validateOpenPathRequest('relative/dir', { platform }).ok, false);
    assert.equal(validateOpenPathRequest('', { platform }).ok, false);
    assert.equal(validateOpenPathRequest(undefined, { platform }).ok, false);
    assert.equal(validateOpenPathRequest('https://example.com/', { platform }).ok, false);
    assert.equal(validateOpenPathRequest(`${directory}\n`, { platform }).ok, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('open-path refuses symlinks that resolve to executables', { skip: process.platform === 'win32' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-open-link-'));
  const target = path.join(directory, 'payload.app');
  const link = path.join(directory, 'innocent');
  fs.mkdirSync(target);
  fs.symlinkSync(target, link);
  try {
    assert.equal(validateOpenPathRequest(link, { platform: 'linux' }).ok, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('open-path refuses UNC paths on Windows', () => {
  const fakeFs = { realpathSync: value => value, statSync: () => ({ isDirectory: () => true }) };
  assert.equal(validateOpenPathRequest('\\\\attacker\\share', { platform: 'win32', fs: fakeFs }).ok, false);
  assert.equal(validateOpenPathRequest('//attacker/share', { platform: 'win32', fs: fakeFs }).ok, false);
  assert.equal(validateOpenPathRequest('C:\\Users\\a\\Documents', { platform: 'win32', fs: fakeFs }).ok, true);
});

test('sanitizes valid RDP connection details', () => {
  assert.deepEqual(sanitizeRdpConnection({ host: 'server.example.com', port: '3389', username: 'admin' }), {
    ok: true, host: 'server.example.com', port: 3389, username: 'admin', server: 'server.example.com:3389',
  });
  assert.deepEqual(sanitizeRdpConnection({ host: '10.0.0.5' }), {
    ok: true, host: '10.0.0.5', port: null, username: null, server: '10.0.0.5',
  });
  assert.equal(sanitizeRdpConnection({ host: 'fe80::1', port: 3390 }).server, '[fe80::1]:3390');
  assert.equal(sanitizeRdpConnection({ host: '[2001:db8::2]', port: 3389 }).server, '[2001:db8::2]:3389');
  assert.equal(sanitizeRdpConnection({ host: 'pc', username: 'DOMAIN\\user' }).username, 'DOMAIN\\user');
  assert.equal(sanitizeRdpConnection({ host: 'pc', username: 'user@corp.local' }).username, 'user@corp.local');
});

test('strips control characters so .rdp lines cannot be injected', () => {
  const result = sanitizeRdpConnection({ host: 'pc', username: 'bob\r\nalternate shell:s:cmd.exe' });
  assert.equal(result.ok, true);
  assert.equal(/[\r\n]/.test(result.username), false);
  const content = buildRdpFileContent(result);
  assert.equal(content.split('\n').filter(line => line.startsWith('alternate shell')).length, 0);
  assert.equal(content.split('\n').length, 5);
  // host with a newline injection is rejected by hostname validation after stripping
  assert.equal(sanitizeRdpConnection({ host: 'pc\r\nalternate shell:s:cmd.exe' }).ok, false);
});

test('rejects invalid RDP hosts and ports', () => {
  for (const host of ['', '   ', 'a b', 'pc;calc', 'pc&calc', '-v:evil', '/v:evil', 'host:3389', 'evil.com/x', '../x', 'a'.repeat(300), undefined]) {
    assert.equal(sanitizeRdpConnection({ host }).ok, false, String(host));
  }
  for (const port of ['0', '65536', '-1', '33 89', '3389;', 'abc', '1e3', 3.5, '999999']) {
    assert.equal(sanitizeRdpConnection({ host: 'pc', port }).ok, false, String(port));
  }
  assert.equal(sanitizeRdpConnection({ host: 'pc', port: '' }).ok, true);
  assert.equal(sanitizeRdpConnection({ host: 'pc', port: 65535 }).port, 65535);
  assert.equal(sanitizeRdpConnection({ host: 'pc', username: 'a"b' }).ok, false);
  assert.equal(sanitizeRdpConnection(null).ok, false);
});
