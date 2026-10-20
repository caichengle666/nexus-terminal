const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { installExecChannelLimiter, execBackground } = require('../dist/services/ssh-channel-limiter.js');
const resume = require('../dist/websocket/session-resume.js');
const { clientStates } = require('../dist/websocket/state.js');

const fakeClient = () => {
  const client = new EventEmitter();
  client.opened = [];
  client.exec = (command, optionsOrCb, maybeCb) => {
    const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
    const channel = new EventEmitter();
    client.opened.push({ command, channel, options: typeof optionsOrCb === 'function' ? undefined : optionsOrCb });
    setImmediate(() => cb(undefined, channel));
    return client;
  };
  return client;
};
const tick = () => new Promise(resolve => setImmediate(resolve));

test('exec channel limiter caps concurrency and drains the queue as channels close', async () => {
  const client = fakeClient();
  const limiter = installExecChannelLimiter(client, 2, 1000);
  const results = [];
  for (let i = 0; i < 4; i += 1) client.exec(`cmd${i}`, { pty: false }, (err, ch) => results.push([i, err, ch]));
  await tick();
  assert.equal(client.opened.length, 2);
  assert.equal(limiter.active, 2);
  assert.equal(limiter.queued, 2);
  assert.deepEqual(client.opened[0].options, { pty: false });
  client.opened[0].channel.emit('close');
  await tick();
  assert.equal(client.opened.length, 3);
  client.opened[1].channel.emit('close');
  client.opened[2].channel.emit('close');
  await tick();
  assert.equal(client.opened.length, 4);
  assert.equal(results.length, 4);
  assert.ok(results.every(([, err]) => !err));
  assert.equal(installExecChannelLimiter(client, 99), limiter, 'install is idempotent');
});

test('background execs cannot take the channels reserved for user commands', async () => {
  const client = fakeClient();
  const limiter = installExecChannelLimiter(client, 4, 1000, 2);
  assert.equal(limiter.maxBackground, 2);
  for (let i = 0; i < 3; i += 1) execBackground(client, `poll${i}`, { pty: false }, () => {});
  await tick();
  assert.equal(client.opened.length, 2, 'only 2 background channels');
  assert.equal(limiter.queued, 1);
  client.exec('user1', () => {});
  client.exec('user2', () => {});
  await tick();
  assert.deepEqual(client.opened.map(o => o.command), ['poll0', 'poll1', 'user1', 'user2']);
  client.opened[2].channel.emit('close'); // a user slot frees up, but the background quota is still full
  await tick();
  assert.equal(client.opened.length, 4);
  client.opened[0].channel.emit('close'); // a background slot frees up
  await tick();
  assert.equal(client.opened[4].command, 'poll2');
  assert.equal(limiter.activeBackground, 2);
});

test('exec channel limiter times out queued requests and fails them when the client closes', async () => {
  const client = fakeClient();
  installExecChannelLimiter(client, 1, 20);
  const errors = [];
  client.exec('busy', () => {});
  client.exec('queued-timeout', err => errors.push(err.message));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.match(errors[0], /通道繁忙/);
  client.exec('queued-close', err => errors.push(err.message));
  client.emit('close');
  assert.match(errors[1], /已关闭/);
});

test('exec channel limiter releases a slot when opening fails', async () => {
  const client = new EventEmitter();
  let calls = 0;
  client.exec = (_c, cb) => { calls += 1; setImmediate(() => cb(new Error('Channel open failure'))); return client; };
  installExecChannelLimiter(client, 1, 1000);
  const errors = [];
  client.exec('a', err => errors.push(err && err.message));
  client.exec('b', err => errors.push(err && err.message));
  await tick(); await tick();
  assert.equal(calls, 2);
  assert.deepEqual(errors, ['Channel open failure', 'Channel open failure']);
});

test('detached output buffer keeps only the newest bytes', () => {
  const state = { detachedAt: Date.now() };
  resume.appendDetachedOutput(state, Buffer.from('aaaa'), 6);
  resume.appendDetachedOutput(state, Buffer.from('bbbb'), 6);
  assert.equal(Buffer.concat(state.detachedOutput).toString(), 'aabbbb');
  assert.equal(state.detachedOutputTruncated, true);
  const live = {};
  resume.appendDetachedOutput(live, Buffer.from('x'), 6);
  assert.equal(live.detachedOutput, undefined, 'nothing is buffered while attached');
});

test('a dropped WebSocket detaches the SSH session, and a reconnect reattaches with replay', async () => {
  const sent = [];
  const shell = new EventEmitter();
  shell.setWindow = (rows, cols) => { shell.window = [rows, cols]; };
  let sshEnded = false;
  const oldWs = { readyState: 3, sessionId: 'sess-resume-1', username: 'u', userId: 1, send() {} };
  const state = {
    ws: oldWs,
    sshClient: { end() { sshEnded = true; }, exec() {} },
    sshShellStream: shell,
    isShellReady: true,
    dbConnectionId: 5,
  };
  clientStates.set('sess-resume-1', state);

  resume.detachClientConnection(oldWs, 10000);
  assert.ok(state.detachedAt);
  assert.equal(clientStates.get('sess-resume-1'), state);
  resume.appendDetachedOutput(state, Buffer.from('output while offline'));

  assert.equal(resume.canReattach(state, '5'), true);
  assert.equal(resume.canReattach(state, '6'), false);

  const newWs = { readyState: 1, username: 'u', userId: 1, send(m) { sent.push(JSON.parse(m)); } };
  resume.reattachClientConnection(newWs, 'sess-resume-1', state, { cols: 120, rows: 40 });
  newWs.readyState = 3; // stop the pollers the reattach restarted

  assert.equal(state.ws, newWs);
  assert.equal(newWs.sessionId, 'sess-resume-1');
  assert.equal(state.detachedAt, undefined);
  assert.equal(state.detachTimer, undefined);
  assert.equal(sshEnded, false);
  assert.deepEqual(shell.window, [40, 120]);
  assert.equal(sent[0].type, 'ssh:connected');
  assert.equal(sent[0].payload.resumed, true);
  assert.equal(Buffer.from(sent[1].payload, 'base64').toString(), 'output while offline');

  // the stale socket closing later must not tear the session down
  resume.detachClientConnection(oldWs, 10);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(clientStates.get('sess-resume-1'), state);
  clientStates.delete('sess-resume-1');
});

test('a detached session is cleaned up after the grace period', async () => {
  let sshEnded = false;
  const ws = { readyState: 3, sessionId: 'sess-resume-2', username: 'u', userId: 1, send() {} };
  const state = {
    ws,
    sshClient: { end() { sshEnded = true; } },
    sshShellStream: { end() {} },
    isShellReady: true,
    dbConnectionId: 5,
  };
  clientStates.set('sess-resume-2', state);
  resume.detachClientConnection(ws, 20);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(clientStates.has('sess-resume-2'), false);
  assert.equal(sshEnded, true);
});
