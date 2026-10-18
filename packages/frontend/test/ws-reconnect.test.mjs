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
