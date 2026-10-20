const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.APP_BACKEND_DATA_PATH ||= fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-session-id-'));

const { isValidSessionId } = require('../dist/websocket/session-id.js');
const { isSafeLogId, temporaryLogStorageService } = require('../dist/ssh-suspend/temporary-log-storage.service.js');

test('resume / connect session ids must match the ssh:connect format', () => {
  assert.equal(isValidSessionId('3f2b8c1e-9a4d-4c7e-8f00-1234567890ab'), true); // uuid
  assert.equal(isValidSessionId('lq3k9x0abc123def'), true); // base36 generateSessionId
  for (const bad of ['../../etc/x', 'a/b/c/d/e/f', 'short', '', 'x'.repeat(129), 'abc def ghi', 'abcdefgh.log', null, 42, undefined]) {
    assert.equal(isValidSessionId(bad), false, String(bad));
  }
});

test('suspend log ids cannot traverse out of the log directory', async () => {
  assert.equal(isSafeLogId('3f2b8c1e-9a4d-4c7e-8f00-1234567890ab'), true);
  for (const bad of ['../evil', '..', 'a/b', 'a\\b', '/abs', '', 'x'.repeat(200)]) {
    assert.equal(isSafeLogId(bad), false, bad);
  }
  await assert.rejects(temporaryLogStorageService.writeToLog('../../escape', 'x'), /无效的挂起日志标识/);
  await temporaryLogStorageService.writeToLog('valid-session-id', 'hello\n');
  const logFile = path.join(process.env.APP_BACKEND_DATA_PATH, 'temp_suspended_ssh_logs', 'valid-session-id.log');
  assert.equal(fs.readFileSync(logFile, 'utf8'), 'hello\n');
  await temporaryLogStorageService.deleteLog('valid-session-id');
  assert.equal(fs.existsSync(logFile), false);
});
