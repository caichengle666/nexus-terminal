const assert = require('node:assert/strict');
const test = require('node:test');
const { redact } = require('../dist/utils/logger.js');

test('redact hides cookies, passwords, bearer tokens and session ids', () => {
  assert.equal(redact('{"cookie":"connect.sid=s%3Aabc"}').includes('abc'), false);
  assert.equal(redact('password: hunter2').includes('hunter2'), false);
  assert.equal(redact('Authorization: Bearer sk-live-123').includes('sk-live-123'), false);
  assert.equal(redact('set connect.sid=s%3Axyz; Path=/').includes('xyz'), false);
  assert.equal(redact('普通日志 user=alice'), '普通日志 user=alice');
});
