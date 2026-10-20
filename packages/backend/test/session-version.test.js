const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.APP_BACKEND_DATA_PATH ||= fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-session-version-'));

const {
  isSessionVersionCurrent,
  isConnectionRevoked,
  isSessionStillValid,
  __setCachedSessionVersionForTest,
} = require('../dist/auth/session-version.js');
const { isAuthenticated } = require('../dist/auth/auth.middleware.js');

test('legacy sessions without a version match the default version 0', () => {
  assert.equal(isSessionVersionCurrent(undefined, 0), true);
  assert.equal(isSessionVersionCurrent(0, 0), true);
  assert.equal(isSessionVersionCurrent(undefined, 1), false);
  assert.equal(isSessionVersionCurrent(1, 2), false);
  assert.equal(isSessionVersionCurrent(2, 2), true);
  assert.equal(isSessionVersionCurrent(0, null), false); // user deleted
});

test('revocation scopes: logout closes only its own session, password change keeps the changer', () => {
  const a = { userId: 1, expressSessionId: 'sid-a' };
  const b = { userId: 1, expressSessionId: 'sid-b' };
  const other = { userId: 2, expressSessionId: 'sid-a' };
  const logout = { userId: 1, onlyExpressSessionId: 'sid-a', reason: 'logout' };
  assert.equal(isConnectionRevoked(a, logout), true);
  assert.equal(isConnectionRevoked(b, logout), false);
  assert.equal(isConnectionRevoked(other, logout), false);
  const change = { userId: 1, exceptExpressSessionId: 'sid-a', reason: 'password_changed' };
  assert.equal(isConnectionRevoked(a, change), false);
  assert.equal(isConnectionRevoked(b, change), true);
  assert.equal(isConnectionRevoked(other, change), false);
});

const runMiddleware = async session => {
  let status = 200;
  let body;
  let nextCalled = false;
  const req = { session };
  const res = {
    status(code) { status = code; return this; },
    json(payload) { body = payload; return this; },
  };
  await isAuthenticated(req, res, () => { nextCalled = true; });
  return { status, body, nextCalled };
};

test('isAuthenticated rejects a session whose version was bumped', async () => {
  __setCachedSessionVersionForTest(42, 3);
  let destroyed = false;
  const stale = { userId: 42, sessionVersion: 2, destroy(cb) { destroyed = true; cb && cb(); } };
  const result = await runMiddleware(stale);
  assert.equal(result.nextCalled, false);
  assert.equal(result.status, 401);
  assert.equal(result.body.code, 'SESSION_REVOKED');
  assert.equal(destroyed, true);

  const fresh = await runMiddleware({ userId: 42, sessionVersion: 3 });
  assert.equal(fresh.nextCalled, true);

  const pending2fa = await runMiddleware({ userId: 42, sessionVersion: 3, requiresTwoFactor: true });
  assert.equal(pending2fa.nextCalled, false);
  assert.equal(pending2fa.status, 401);

  assert.equal(await isSessionStillValid({ userId: 42, sessionVersion: 3 }), true);
  assert.equal(await isSessionStillValid({ userId: 42, sessionVersion: 1 }), false);
  __setCachedSessionVersionForTest(42, undefined);
});
