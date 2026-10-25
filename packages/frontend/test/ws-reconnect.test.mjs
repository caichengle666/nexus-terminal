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

test('network drops (error + close 1006) retry forever with 0.5s→5s capped backoff, one attempt per failure', (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  sockets.length = 0;
  const mgr = createWebSocketConnectionManager('s1', '1', t, { probeAuth: async () => null });
  const statuses = [];
  mgr.onMessage('internal:reconnect-status', (p) => statuses.push(p));

  mgr.connect('ws://localhost/ws/');
  for (let i = 0; i < 30; i++) {
    sockets[sockets.length - 1].failLikeBrowser();
    const retry = statuses[statuses.length - 1];
    assert.equal(retry.phase, 'auto-retry', `still retrying after ${i + 1} failures`);
    ctx.mock.timers.tick(retry.delay * 1000);
  }
  const retries = statuses.filter(s => s.phase === 'auto-retry');
  assert.deepEqual(retries.slice(0, 7).map(r => r.delay), [0.5, 1, 2, 4, 5, 5, 5]);
  assert.deepEqual(retries.map(r => r.attempt), Array.from({ length: 30 }, (_, i) => i + 1), 'error+close counts once');
  assert.ok(!statuses.some(s => s.phase === 'exhausted'), 'never gives up on network failures');
  assert.equal(sockets.length, 31, 'initial connect + 30 retries');
  assert.equal(mgr.connectionStatus.value, 'connecting');
  mgr.dispose();
});

test('a dropped live session reconnects in 0.5s and re-sends ssh:connect with the same sessionId (backend reattaches)', (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  sockets.length = 0;
  const mgr = createWebSocketConnectionManager('sess-same', '7', t);
  mgr.connect('ws://localhost/ws/');
  const first = sockets[0];
  first.readyState = 1;
  first.onopen?.();
  first.onmessage?.({ data: JSON.stringify({ type: 'ssh:connected', payload: { sessionId: 'sess-same' } }) });
  first.failLikeBrowser();
  assert.equal(mgr.connectionStatus.value, 'connecting', 'no error flash while auto-reconnecting');
  ctx.mock.timers.tick(499);
  assert.equal(sockets.length, 1);
  ctx.mock.timers.tick(1);
  assert.equal(sockets.length, 2);
  const sent = [];
  const second = sockets[1];
  second.send = (d) => sent.push(JSON.parse(d));
  second.readyState = 1;
  second.onopen?.();
  assert.deepEqual(sent.map(m => [m.type, m.payload.sessionId, m.payload.connectionId]), [['ssh:connect', 'sess-same', '7']]);
  second.onmessage?.({ data: JSON.stringify({ type: 'ssh:connected', payload: { resumed: true } }) });
  assert.equal(mgr.connectionStatus.value, 'connected');
  // backoff restarts from 0.5s after a successful reattach
  const statuses = [];
  mgr.onMessage('internal:reconnect-status', (p) => statuses.push(p));
  second.failLikeBrowser();
  assert.equal(statuses[0].delay, 0.5);
  mgr.dispose();
});

test('retryNow skips the backoff wait, is debounced, and does nothing when auto-reconnect is not pending', (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  sockets.length = 0;
  const mgr = createWebSocketConnectionManager('s8', '1', t, { probeAuth: async () => null });
  mgr.connect('ws://localhost/ws/');
  assert.equal(mgr.retryNow('test'), false, 'socket is CONNECTING: nothing to do');
  for (let i = 0; i < 5; i++) {
    sockets[sockets.length - 1].failLikeBrowser();
    ctx.mock.timers.tick(i < 4 ? [500, 1000, 2000, 4000][i] : 0);
  }
  // now waiting on a 5s timer
  const before = sockets.length;
  assert.equal(mgr.retryNow('keyboard'), true);
  assert.equal(sockets.length, before + 1, 'connected immediately');
  sockets[sockets.length - 1].failLikeBrowser();
  assert.equal(mgr.retryNow('keyboard'), false, 'debounced within 1.2s');
  // the pending timer is not duplicated: exactly one more socket after the backoff
  ctx.mock.timers.tick(5000);
  assert.equal(sockets.length, before + 2);
  mgr.dispose();
});

test('retryNow cannot restart a session whose auto-reconnect was stopped (1008)', (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  sockets.length = 0;
  const mgr = createWebSocketConnectionManager('s9', '1', t);
  mgr.connect('ws://localhost/ws/');
  const ws = sockets[0];
  ws.readyState = 1;
  ws.onopen?.();
  ws.readyState = 3;
  ws.onclose?.({ code: 1008, reason: 'SSH connection failed (not retryable)' });
  assert.equal(mgr.retryNow('keyboard'), false);
  assert.equal(mgr.retryNow('online'), false);
  ctx.mock.timers.tick(60_000);
  assert.equal(sockets.length, 1);
});

test('repeated pre-open failures probe the login state and stop auto-reconnect on 401', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  sockets.length = 0;
  let probes = 0;
  const mgr = createWebSocketConnectionManager('s10', '1', t, { probeAuth: async () => { probes++; return false; } });
  const statuses = [];
  mgr.onMessage('internal:reconnect-status', (p) => statuses.push(p));
  mgr.connect('ws://localhost/ws/');
  for (let i = 0; i < 3; i++) {
    sockets[sockets.length - 1].failLikeBrowser();
    ctx.mock.timers.tick(statuses[statuses.length - 1].delay * 1000);
  }
  assert.equal(probes, 0, 'no probe before 4 consecutive failures');
  sockets[sockets.length - 1].failLikeBrowser();
  assert.equal(probes, 1);
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(statuses[statuses.length - 1], { phase: 'stopped', reason: 'auth' });
  assert.equal(mgr.connectionStatus.value, 'error', 'Enter reconnects manually after signing in');
  const count = sockets.length;
  ctx.mock.timers.tick(120_000);
  assert.equal(sockets.length, count, 'no more automatic retries');
});

test('pre-open failures keep retrying when the login probe is fine or unreachable', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  sockets.length = 0;
  let probes = 0;
  const mgr = createWebSocketConnectionManager('s11', '1', t, { probeAuth: async () => { probes++; return probes % 2 ? null : true; } });
  const statuses = [];
  mgr.onMessage('internal:reconnect-status', (p) => statuses.push(p));
  mgr.connect('ws://localhost/ws/');
  for (let i = 0; i < 12; i++) {
    sockets[sockets.length - 1].failLikeBrowser();
    await Promise.resolve(); await Promise.resolve();
    ctx.mock.timers.tick(statuses[statuses.length - 1].delay * 1000);
  }
  assert.equal(probes, 3);
  assert.ok(statuses.every(s => s.phase === 'auto-retry'));
  mgr.dispose();
});

test('dispose removes the online/visibilitychange listeners and pending timers', (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  sockets.length = 0;
  const listeners = { window: new Map(), document: new Map() };
  const target = (m) => ({
    addEventListener: (ev, fn) => m.set(ev, fn),
    removeEventListener: (ev, fn) => { if (m.get(ev) === fn) m.delete(ev); },
  });
  const prevWindow = globalThis.window; const prevDocument = globalThis.document;
  globalThis.window = { ...prevWindow, ...target(listeners.window) };
  globalThis.document = { visibilityState: 'visible', ...target(listeners.document) };
  try {
    const mgr = createWebSocketConnectionManager('s12', '1', t, { probeAuth: async () => null });
    assert.ok(listeners.window.has('online'));
    assert.ok(listeners.document.has('visibilitychange'));
    mgr.connect('ws://localhost/ws/');
    sockets[0].failLikeBrowser();
    // network comes back: the online event reconnects without waiting for the timer
    listeners.window.get('online')();
    assert.equal(sockets.length, 2);
    sockets[1].failLikeBrowser();
    mgr.dispose();
    assert.equal(listeners.window.size, 0);
    assert.equal(listeners.document.size, 0);
    ctx.mock.timers.tick(60_000);
    assert.equal(sockets.length, 2, 'pending reconnect timer cleared');
  } finally {
    globalThis.window = prevWindow; globalThis.document = prevDocument;
  }
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
  ctx.mock.timers.tick(500);
  assert.equal(sockets.length, 2, 'auto-reconnect created a new socket (0.5s backoff)');
  return Promise.resolve().then(() => assert.equal(result, false));
});

test('WS opens but SSH fails every time (1011): attempts still count up and give up', (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  sockets.length = 0;
  const mgr = createWebSocketConnectionManager('s6', '1', t);
  const statuses = [];
  mgr.onMessage('internal:reconnect-status', (p) => statuses.push(p));
  mgr.connect('ws://localhost/ws/');
  for (let i = 0; i < 20 && mgr.connectionStatus.value !== 'error'; i++) {
    const ws = sockets[sockets.length - 1];
    ws.readyState = 1;
    ws.onopen?.();
    ws.onmessage?.({ data: JSON.stringify({ type: 'ssh:error', payload: '连接失败: Timed out while waiting for handshake' }) });
    ws.readyState = 3;
    ws.onclose?.({ code: 1011, reason: 'SSH connection failed' });
    const retry = statuses[statuses.length - 1];
    if (retry?.phase !== 'auto-retry') break;
    ctx.mock.timers.tick(retry.delay * 1000);
  }
  const retries = statuses.filter(s => s.phase === 'auto-retry');
  assert.deepEqual(retries.map(r => r.attempt), [1, 2, 3, 4, 5, 6, 7, 8], 'not stuck at 1/8');
  assert.equal(statuses[statuses.length - 1].phase, 'exhausted');
  assert.equal(mgr.retryNow('keyboard'), false, 'keyboard input cannot restart an exhausted session');
});

test('non-retryable SSH failure (close 1008) stops auto-reconnect immediately', (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  sockets.length = 0;
  const mgr = createWebSocketConnectionManager('s7', '1', t);
  const statuses = [];
  mgr.onMessage('internal:reconnect-status', (p) => statuses.push(p));
  mgr.connect('ws://localhost/ws/');
  const ws = sockets[0];
  ws.readyState = 1;
  ws.onopen?.();
  ws.onmessage?.({ data: JSON.stringify({ type: 'ssh:error', payload: '连接失败: Handshake failed: no matching host key format' }) });
  ws.readyState = 3;
  ws.onclose?.({ code: 1008, reason: 'SSH connection failed (not retryable)' });
  ctx.mock.timers.tick(120_000);
  assert.equal(sockets.length, 1, 'no automatic retry');
  assert.deepEqual(statuses.map(s => s.phase), ['stopped']);
  assert.equal(mgr.connectionStatus.value, 'error', 'Enter can still reconnect manually');
});
