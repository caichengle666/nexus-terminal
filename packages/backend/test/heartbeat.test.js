const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluateHeartbeat } = require('../dist/websocket/heartbeat.js');

test('heartbeat terminates only after consecutive missed pongs', () => {
  const ws = { isAlive: true, bufferedAmount: 0 };
  assert.equal(evaluateHeartbeat(ws, 3), 'ping');
  ws.isAlive = false;
  assert.equal(evaluateHeartbeat(ws, 3), 'ping');
  assert.equal(evaluateHeartbeat(ws, 3), 'ping');
  assert.equal(evaluateHeartbeat(ws, 3), 'terminate');
});

test('a pong resets the missed counter', () => {
  const ws = { isAlive: false, bufferedAmount: 0 };
  evaluateHeartbeat(ws, 3);
  evaluateHeartbeat(ws, 3);
  ws.isAlive = true;
  assert.equal(evaluateHeartbeat(ws, 3), 'ping');
  assert.equal(ws.missedPongs, 0);
});

test('missed pongs are not counted while the send buffer is draining', () => {
  const ws = { isAlive: false, bufferedAmount: 10 * 1024 * 1024 };
  assert.equal(evaluateHeartbeat(ws, 2), 'ping'); // first observation, no baseline yet
  ws.missedPongs = 0;
  for (let i = 0; i < 10; i += 1) {
    ws.bufferedAmount -= 512 * 1024;
    assert.equal(evaluateHeartbeat(ws, 2), 'skip');
  }
  ws.bufferedAmount = 0;
  assert.equal(evaluateHeartbeat(ws, 2), 'ping');
  assert.equal(evaluateHeartbeat(ws, 2), 'terminate');
});

test('a stalled send buffer no longer skips forever', () => {
  const ws = { isAlive: false, bufferedAmount: 10 * 1024 * 1024 };
  assert.equal(evaluateHeartbeat(ws, 3), 'ping');
  assert.equal(evaluateHeartbeat(ws, 3), 'ping');
  assert.equal(evaluateHeartbeat(ws, 3), 'terminate');
});

test('send buffer over the hard cap terminates even when pongs arrive', () => {
  const ws = { isAlive: true, bufferedAmount: 200 * 1024 * 1024 };
  assert.equal(evaluateHeartbeat(ws, 3, 64 * 1024 * 1024, 2), 'ping');
  assert.equal(evaluateHeartbeat(ws, 3, 64 * 1024 * 1024, 2), 'terminate');
  const ok = { isAlive: true, bufferedAmount: 200 * 1024 * 1024 };
  evaluateHeartbeat(ok, 3, 64 * 1024 * 1024, 2);
  ok.bufferedAmount = 0;
  assert.equal(evaluateHeartbeat(ok, 3, 64 * 1024 * 1024, 2), 'ping');
  assert.equal(ok.overCapBeats, 0);
});
