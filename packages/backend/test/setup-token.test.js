const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Keep the module's DB path import away from the repo data directory.
process.env.APP_BACKEND_DATA_PATH = process.env.APP_BACKEND_DATA_PATH
  || path.join(os.tmpdir(), `nexus-setup-token-test-${process.pid}`);

const {
  DESKTOP_PROXY_TOKEN_HEADER,
  isDesktopLocalRequest,
  isLoopbackBypassAllowed,
} = require('../dist/auth/setup-token.js');

const TOKEN = 'a'.repeat(64);
const req = ({ ip = '127.0.0.1', token } = {}) => ({
  ip,
  socket: { remoteAddress: ip },
  headers: token === undefined ? {} : { [DESKTOP_PROXY_TOKEN_HEADER]: token },
});

const withEnv = (vars, fn) => {
  const saved = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
};

test('loopback alone no longer bypasses the setup token', () => {
  withEnv({ NEXUS_DESKTOP_PROXY_TOKEN: undefined, SETUP_ALLOW_LOOPBACK_WITHOUT_TOKEN: 'true' }, () => {
    assert.equal(isLoopbackBypassAllowed(req()), false);
    assert.equal(isLoopbackBypassAllowed(req({ ip: '::1' })), false);
    assert.equal(isLoopbackBypassAllowed(req({ token: TOKEN })), false);
  });
});

test('desktop proxy token must match exactly', () => {
  withEnv({ NEXUS_DESKTOP_PROXY_TOKEN: TOKEN }, () => {
    assert.equal(isDesktopLocalRequest(req({ token: TOKEN })), true);
    assert.equal(isDesktopLocalRequest(req({ ip: '::ffff:127.0.0.1', token: TOKEN })), true);
    assert.equal(isDesktopLocalRequest(req()), false);
    assert.equal(isDesktopLocalRequest(req({ token: '' })), false);
    assert.equal(isDesktopLocalRequest(req({ token: TOKEN.slice(1) })), false);
    assert.equal(isDesktopLocalRequest(req({ token: `${TOKEN}b` })), false);
    assert.equal(isDesktopLocalRequest(req({ token: 'b'.repeat(64) })), false);
  });
});

test('desktop proxy token is ignored for non-loopback peers', () => {
  withEnv({ NEXUS_DESKTOP_PROXY_TOKEN: TOKEN }, () => {
    assert.equal(isDesktopLocalRequest(req({ ip: '192.168.1.20', token: TOKEN })), false);
  });
});

test('too-short configured tokens are rejected', () => {
  withEnv({ NEXUS_DESKTOP_PROXY_TOKEN: 'short' }, () => {
    assert.equal(isDesktopLocalRequest(req({ token: 'short' })), false);
  });
});
