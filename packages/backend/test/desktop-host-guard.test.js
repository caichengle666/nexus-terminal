const test = require('node:test');
const assert = require('node:assert/strict');
const { isLoopbackHostHeader, shouldRejectDesktopHost } = require('../dist/auth/desktop-host-guard');

test('loopback Host headers are recognised', () => {
  for (const host of ['localhost', 'localhost:22457', '127.0.0.1:22458', '[::1]:22458', 'LOCALHOST:1']) {
    assert.equal(isLoopbackHostHeader(host), true, host);
  }
  for (const host of ['evil.example', 'evil.example:22458', '127.0.0.1.nip.io', 'localhost.evil.com', 'localhost:abc', '[::1]x', '', undefined, '127.0.0.2']) {
    assert.equal(isLoopbackHostHeader(host), false, String(host));
  }
});

test('desktop mode rejects non-loopback Host, other deployments do not', () => {
  const previous = process.env.NEXUS_DESKTOP_PROXY_TOKEN;
  try {
    delete process.env.NEXUS_DESKTOP_PROXY_TOKEN;
    assert.equal(shouldRejectDesktopHost({ headers: { host: 'nexus.example.com' } }), false);
    process.env.NEXUS_DESKTOP_PROXY_TOKEN = 'x'.repeat(48);
    assert.equal(shouldRejectDesktopHost({ headers: { host: 'nexus.example.com' } }), true);
    assert.equal(shouldRejectDesktopHost({ headers: { host: '127.0.0.1:22458' } }), false);
    assert.equal(shouldRejectDesktopHost({ headers: {} }), true);
  } finally {
    if (previous === undefined) delete process.env.NEXUS_DESKTOP_PROXY_TOKEN; else process.env.NEXUS_DESKTOP_PROXY_TOKEN = previous;
  }
});
