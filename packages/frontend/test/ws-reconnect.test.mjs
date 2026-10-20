import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const modulePath = process.env.WS_MODULE;
if (!modulePath) throw new Error('Run via test/run-ws-reconnect-test.mjs (WS_MODULE not set).');

// Minimal browser-like WebSocket: every connection attempt fails like a network drop
// (error event followed by close 1006, as browsers do).
const sockets = [];
class FakeWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); }
  send() {}
  close() { this.readyState = 3; }
  failLikeBrowser() {
    this.readyState = 3;
    this.onerror?.({ type: 'error' });
    this.onclose?.({ code: 1006, reason: '' });
  }
}
globalThis.WebSocket = FakeWebSocket;
globalThis.window = { location: { protocol: 'http:', host: 'localhost' } };

const { createWebSocketConnectionManager } = await import(pathToFileURL(modulePath).href);
const t = (key) => key;

test('error + close(1006) counts as a single reconnect attempt and retries cover ~150s', (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  sockets.length = 0;
  const mgr = createWebSocketConnectionManager('s1', '1', t);
  const statuses = [];
  mgr.onMessage('internal:reconnect-status', (p) => statuses.push(p));

  mgr.connect('ws://localhost/ws/');
  let elapsedMs = 0;
  for (let i = 0; i < 20 && mgr.connectionStatus.value !== 'error'; i++) {
    const ws = sockets[sockets.length - 1];
    ws.failLikeBrowser();
    const retry = statuses[statuses.length - 1];
    if (retry?.phase !== 'auto-retry') break;
    ctx.mock.timers.tick(retry.delay * 1000);
    elapsedMs += retry.delay * 1000;
  }

  const retries = statuses.filter(s => s.phase === 'auto-retry');
  assert.deepEqual(retries.map(r => r.attempt), [1, 2, 3, 4, 5, 6, 7, 8], 'attempts increase by one per failure');
  assert.ok(retries.every(r => r.max === 8));
  assert.equal(statuses[statuses.length - 1].phase, 'exhausted');
  assert.equal(mgr.connectionStatus.value, 'error');
  // 2+4+8+16+30+30+30+30 = 150s of retrying (inside the backend's 180s resume grace)
  assert.equal(elapsedMs, 150_000);
  assert.equal(sockets.length, 9, 'initial connect + 8 retries');
});

test('intentional disconnect does not schedule reconnects', (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  sockets.length = 0;
  const mgr = createWebSocketConnectionManager('s2', '1', t);
  const statuses = [];
  mgr.onMessage('internal:reconnect-status', (p) => statuses.push(p));
  mgr.connect('ws://localhost/ws/');
  const ws = sockets[0];
  mgr.disconnect();
  ws.onclose?.({ code: 1000, reason: '' });
  ctx.mock.timers.tick(60_000);
  assert.equal(statuses.length, 0);
  assert.equal(sockets.length, 1);
});

test('reconnect() while the previous socket is still CONNECTING detaches it (no stale ssh:connect / onclose)', (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  sockets.length = 0;
  const sent = [];
  const mgr = createWebSocketConnectionManager('s3', '42', t);
  const statuses = [];
  mgr.onMessage('internal:reconnect-status', (p) => statuses.push(p));
  mgr.connect('ws://localhost/ws/');
  const halfOpen = sockets[0];
  assert.equal(halfOpen.readyState, 0);

  mgr.reconnect();
  assert.equal(sockets.length, 2, 'a new socket is created');
  const fresh = sockets[1];
  fresh.send = (data) => sent.push({ socket: 'fresh', data: JSON.parse(data) });
  halfOpen.send = (data) => sent.push({ socket: 'stale', data: JSON.parse(data) });

  // Handlers on the superseded socket are gone, and it was asked to close.
  assert.equal(halfOpen.onopen, null);
  assert.equal(halfOpen.onclose, null);
  assert.equal(halfOpen.readyState, 3);

  // The fresh socket opens normally and sends exactly one ssh:connect.
  fresh.readyState = 1;
  fresh.onopen?.();
  assert.deepEqual(sent.map(s => [s.socket, s.data.type]), [['fresh', 'ssh:connect']]);

  // Even if the stale socket's (old) close fired late, nothing schedules a reconnect.
  ctx.mock.timers.tick(60_000);
  assert.equal(sockets.length, 2);
  assert.equal(statuses.filter(s => s.phase === 'auto-retry').length, 0);
});

test('a late close of a replaced socket does not clobber the live socket', (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  sockets.length = 0;
  const mgr = createWebSocketConnectionManager('s4', '1', t);
  const statuses = [];
  mgr.onMessage('internal:reconnect-status', (p) => statuses.push(p));
  mgr.connect('ws://localhost/ws/');
  const first = sockets[0];
  const staleOnClose = first.onclose; // captured before reconnect detaches it
  mgr.reconnect();
  const fresh = sockets[1];
  fresh.readyState = 1;
  fresh.onopen?.();
  staleOnClose?.({ code: 1006, reason: '' });
  ctx.mock.timers.tick(60_000);
  assert.equal(sockets.length, 2, 'no extra reconnect from the stale close');
  assert.equal(statuses.filter(s => s.phase === 'auto-retry').length, 0);
  let sentCount = 0;
  fresh.send = () => { sentCount++; };
  mgr.sendMessage({ type: 'ssh:input', payload: 'x' });
  assert.equal(sentCount, 1, 'input still goes to the live socket');
});

test('a failed reconnect (release timeout) leaves auto-reconnect working afterwards', (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  sockets.length = 0;
  const mgr = createWebSocketConnectionManager('s5', '1', t);
  const statuses = [];
  mgr.onMessage('internal:reconnect-status', (p) => statuses.push(p));
  mgr.connect('ws://localhost/ws/');
  const ws = sockets[0];
  ws.readyState = 1;
  ws.onopen?.();
  ws.onmessage?.({ data: JSON.stringify({ type: 'ssh:connected' }) });
  assert.equal(mgr.connectionStatus.value, 'connected');

  let result;
  mgr.reconnect().then((r) => { result = r; });
  // Backend never acks ssh:disconnect -> fail() after 5s.
  ctx.mock.timers.tick(5_000);
  assert.equal(statuses[statuses.length - 1].phase, 'failed');

  // The (still open) socket now drops: auto-reconnect must kick in.
  ws.failLikeBrowser();
  assert.equal(statuses[statuses.length - 1].phase, 'auto-retry');
  ctx.mock.timers.tick(2_000);
  assert.equal(sockets.length, 2, 'auto-reconnect created a new socket');
  return Promise.resolve().then(() => assert.equal(result, false));
});
