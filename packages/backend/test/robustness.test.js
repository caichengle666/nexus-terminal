// 回归测试：2026-11-03 健壮性审查（崩溃路径、UTF-8 分块、会话路由、备份权限、优雅退出）
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable, Readable } = require('node:stream');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-robustness-'));
process.env.APP_BACKEND_DATA_PATH = dataDir;
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { Server, utils } = require('ssh2');
const { getDbInstance } = require('../dist/database/connection.js');
const { initializeUpgradeHandler } = require('../dist/websocket/upgrade.js');
const SshService = require('../dist/services/ssh.service.js');
const { attachFallbackErrorListener, isFallbackErrorListener, ListenerGroup } = require('../dist/utils/ssh-client-guard.js');
const { bindShellSession, unbindShellSession } = require('../dist/websocket/shell-stream.js');
const { clientStates } = require('../dist/websocket/state.js');
const { handleSshExec } = require('../dist/websocket/handlers/ssh.handler.js');
const { SshSuspendService } = require('../dist/ssh-suspend/ssh-suspend.service.js');
const { SftpService } = require('../dist/sftp/sftp.service.js');
const { createGracefulShutdown } = require('../dist/utils/graceful-shutdown.js');

const OPEN = 1;
const tick = () => new Promise(resolve => setImmediate(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const fakeWs = (userId = 1) => {
  const ws = new EventEmitter();
  ws.readyState = OPEN;
  ws.userId = userId;
  ws.username = 'tester';
  ws.bufferedAmount = 0;
  ws.sent = [];
  ws.send = (raw) => ws.sent.push(JSON.parse(raw));
  return ws;
};

const fakeChannel = () => {
  const channel = new EventEmitter();
  channel.stderr = new EventEmitter();
  channel.readable = true;
  channel.writable = true;
  channel.pause = () => {};
  channel.resume = () => {};
  channel.end = () => { channel.ended = true; };
  channel.close = () => { channel.closed = true; };
  channel.setWindow = () => {};
  return channel;
};

const fakeSshClient = () => {
  const client = new EventEmitter();
  client.end = () => { client.ended = true; };
  return client;
};

const decodeOutputs = (ws) => Buffer.concat(
  ws.sent.filter(m => m.type === 'ssh:output').map(m => Buffer.from(m.payload, 'base64'))
).toString('utf8');

test.before(async () => {
  await getDbInstance();
});

test.after(async () => {
  try {
    const db = await getDbInstance();
    await new Promise(resolve => db.close(() => resolve()));
  } catch { /* ignore */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// --- #1 upgrade socket ---
test('upgrade socket has an error listener during async auth (client RST does not crash the process)', async () => {
  const server = http.createServer();
  let listenerCountDuringAuth = -1;
  let parserDone;
  const parserFinished = new Promise(resolve => { parserDone = resolve; });
  const sessionParser = (req, _res, next) => {
    setTimeout(() => {
      listenerCountDuringAuth = req.socket.listenerCount('error');
      // 模拟客户端在鉴权 await 期间 RST：没有监听器时这里会直接抛出 uncaughtException
      req.socket.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
      next();
      parserDone();
    }, 50);
  };
  const wss = { handleUpgrade: () => { throw new Error('should not upgrade'); } };
  initializeUpgradeHandler(server, wss, sessionParser);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const client = net.connect(port, '127.0.0.1');
  client.on('error', () => {});
  client.write('GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
  await parserFinished;
  await wait(20);
  client.destroy();
  await new Promise(resolve => server.close(resolve));
  assert.ok(listenerCountDuringAuth >= 1, `expected an error listener on the upgrade socket, got ${listenerCountDuringAuth}`);
});

// --- #2/#3 ssh2 clients keep an error listener after ready ---
const hostKey = utils.generateKeyPairSync('ed25519').private;
const startSshServer = ({ allowForward = false } = {}) => new Promise(resolve => {
  const rawSockets = [];
  const srv = new Server({ hostKeys: [hostKey] }, (conn) => {
    conn.on('authentication', ctx => ctx.accept());
    conn.on('ready', () => {});
    conn.on('error', () => {});
    if (allowForward) {
      conn.on('tcpip', (accept, _reject, info) => {
        const stream = accept();
        const upstream = net.connect(info.destPort, info.destIP);
        upstream.on('error', () => stream.destroy());
        stream.on('error', () => upstream.destroy());
        stream.pipe(upstream).pipe(stream);
      });
    }
  });
  srv._srv.on('connection', sock => rawSockets.push(sock));
  srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, rawSockets }));
});

const unsavedDetails = (port, extra = {}) => ({
  id: -1, name: 'robustness', host: '127.0.0.1', port, username: 'u', auth_method: 'password', password: 'x', ...extra,
});

test('client returned by establishSshConnection keeps an error listener after ready (no crash on ECONNRESET)', async () => {
  const { srv, port, rawSockets } = await startSshServer();
  const client = await SshService.establishSshConnection(unsavedDetails(port), 5000);
  try {
    assert.ok(client.listenerCount('error') >= 1, 'fallback error listener must survive ready');
    assert.ok(client.listeners('error').some(l => isFallbackErrorListener(client, l)));
    const closed = new Promise(resolve => client.once('close', resolve));
    rawSockets.forEach(sock => sock.resetAndDestroy());
    await closed;
  } finally {
    client.end();
    srv.close();
  }
});

test('jump host client keeps an error listener after ready (jump host reset does not crash)', async () => {
  const target = await startSshServer();
  const jump = await startSshServer({ allowForward: true });
  const details = unsavedDetails(target.port, {
    connection_proxy_setting: 'jump',
    jump_chain: [{ id: 'hop1', name: 'hop', host: '127.0.0.1', port: jump.port, username: 'u', auth_method: 'password', password: 'x' }],
  });
  const client = await SshService.establishSshConnection(details, 5000);
  try {
    const closed = new Promise(resolve => client.once('close', resolve));
    // 跳板机连接被 RST：中间跳 client 会 emit 'error'
    jump.rawSockets.forEach(sock => sock.resetAndDestroy());
    await closed;
    await wait(20);
  } finally {
    client.end();
    target.srv.close();
    jump.srv.close();
  }
});

test('attachFallbackErrorListener is idempotent and ListenerGroup only removes its own listeners', () => {
  const emitter = new EventEmitter();
  attachFallbackErrorListener(emitter, 'test');
  attachFallbackErrorListener(emitter, 'test');
  assert.equal(emitter.listenerCount('error'), 1);
  const group = new ListenerGroup();
  group.on(emitter, 'error', () => {});
  group.on(emitter, 'close', () => {});
  const foreignClose = () => {};
  emitter.on('close', foreignClose);
  group.removeAll();
  assert.equal(emitter.listenerCount('error'), 1);
  assert.deepEqual(emitter.listeners('close'), [foreignClose]);
  assert.doesNotThrow(() => emitter.emit('error', new Error('boom')));
});

// --- #5/#7 shell output ---
test('shell output is forwarded as raw bytes: a UTF-8 character split across chunks is not corrupted', () => {
  const sessionId = 'robust-utf8';
  const ws = fakeWs();
  const channel = fakeChannel();
  const state = { ws, sshClient: fakeSshClient(), sshShellStream: channel, dbConnectionId: 1, isShellReady: true };
  clientStates.set(sessionId, state);
  try {
    bindShellSession(state, sessionId, channel, { cleanup: () => {} });
    const bytes = Buffer.from('中文 ok 😀', 'utf8');
    channel.emit('data', bytes.subarray(0, 2));
    channel.emit('data', bytes.subarray(2, 5));
    channel.stderr.emit('data', bytes.subarray(5, 10));
    channel.emit('data', bytes.subarray(10));
    assert.equal(decodeOutputs(ws), '中文 ok 😀');
    assert.ok(!decodeOutputs(ws).includes('\uFFFD'));
  } finally {
    unbindShellSession(state);
    clientStates.delete(sessionId);
  }
});

test('shell output follows the session\'s current ws, rebinding does not stack listeners, and detach buffers output', () => {
  const sessionId = 'robust-route';
  const oldWs = fakeWs();
  const newWs = fakeWs();
  const channel = fakeChannel();
  const sshClient = fakeSshClient();
  const state = { ws: oldWs, sshClient, sshShellStream: channel, dbConnectionId: 1, isShellReady: true };
  clientStates.set(sessionId, state);
  try {
    bindShellSession(state, sessionId, channel, { cleanup: () => {} });
    const errorListenersAfterFirst = sshClient.listenerCount('error');
    bindShellSession(state, sessionId, channel, { cleanup: () => {} });
    assert.equal(sshClient.listenerCount('error'), errorListenersAfterFirst, 'rebind must not stack error listeners');
    assert.equal(channel.listenerCount('data'), 1);

    // WebSocket 断开 → 分离缓冲
    oldWs.readyState = 3;
    state.detachedAt = Date.now();
    state.detachedOutput = [];
    state.detachedOutputBytes = 0;
    channel.emit('data', Buffer.from('during-detach'));
    assert.equal(Buffer.concat(state.detachedOutput).toString(), 'during-detach');

    // 重连接回：state.ws 换成新连接，输出发到新连接
    state.detachedAt = undefined;
    state.ws = newWs;
    channel.emit('data', Buffer.from('after-reattach'));
    assert.equal(decodeOutputs(newWs), 'after-reattach');
    assert.equal(decodeOutputs(oldWs), '');

    // 解绑后 client 仍保留兜底 error 监听
    unbindShellSession(state);
    assert.ok(sshClient.listenerCount('error') >= 1);
    assert.doesNotThrow(() => sshClient.emit('error', new Error('late ECONNRESET')));
  } finally {
    unbindShellSession(state);
    clientStates.delete(sessionId);
  }
});

// --- #5/#8 exec output ---
test('exec output is decoded as a stream and the result goes to the session\'s current ws', async () => {
  const sessionId = 'robust-exec';
  const ws = fakeWs();
  ws.sessionId = sessionId;
  const reconnectedWs = fakeWs();
  let execStream;
  const sshClient = fakeSshClient();
  sshClient.exec = (_command, _options, callback) => {
    execStream = fakeChannel();
    execStream.signal = () => {};
    setImmediate(() => callback(undefined, execStream));
    return sshClient;
  };
  const state = { ws, sshClient, dbConnectionId: 1, connectionName: 'c' };
  clientStates.set(sessionId, state);
  try {
    handleSshExec(ws, { command: 'cat zh.txt', timeoutMs: 5000 }, 'req-1');
    await tick();
    const bytes = Buffer.from('你好，世界', 'utf8');
    execStream.emit('data', bytes.subarray(0, 4));
    execStream.emit('data', bytes.subarray(4, 8));
    execStream.emit('data', bytes.subarray(8));
    // 命令执行期间 WebSocket 断线重连，会话被接回
    state.ws = reconnectedWs;
    execStream.emit('exit', 0, null);
    execStream.emit('close');
    const results = reconnectedWs.sent.filter(m => m.type === 'ssh:exec:result');
    assert.equal(results.length, 1, 'result must go to the reconnected ws');
    assert.equal(ws.sent.filter(m => m.type === 'ssh:exec:result').length, 0);
    assert.equal(results[0].payload.stdout, '你好，世界');
    assert.equal(results[0].payload.ok, true);
  } finally {
    clientStates.delete(sessionId);
  }
});

// --- #4 suspend service ---
const fakeLogStorage = () => {
  const writes = [];
  return {
    writes,
    ensureLogDirectoryExists: async () => {},
    writeToLog: async (_id, data) => { writes.push(Buffer.isBuffer(data) ? data : Buffer.from(data)); },
    readLog: async () => Buffer.concat(writes).toString('utf8'),
    deleteLog: async () => {},
  };
};

test('suspend service keeps an error listener on the client and ends it when the channel exits', async () => {
  const storage = fakeLogStorage();
  const service = new SshSuspendService(storage);
  service.on('sessionAutoTerminated', () => {});
  const sshClient = fakeSshClient();
  const channel = fakeChannel();
  const foreignEnd = () => {};
  sshClient.on('end', foreignEnd); // 例如 exec 通道限流器的监听，不应被清掉
  const suspendId = await service.takeOverMarkedSession({
    userId: 7, originalSessionId: 's1', sshClient, channel, connectionName: 'c', connectionId: '1', logIdentifier: 'log-s1',
  });
  assert.ok(suspendId);
  const bytes = Buffer.from('挂起日志', 'utf8');
  channel.emit('data', bytes.subarray(0, 4));
  channel.emit('data', bytes.subarray(4));
  await tick();
  assert.equal(Buffer.concat(storage.writes).toString('utf8'), '挂起日志');

  channel.emit('exit', 0, null);
  assert.equal(sshClient.ended, true, 'underlying SSH connection must be closed after termination');
  assert.ok(sshClient.listenerCount('error') >= 1, 'fallback error listener must remain');
  assert.ok(sshClient.listeners('end').includes(foreignEnd));
  assert.doesNotThrow(() => sshClient.emit('error', Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' })));
});

test('resuming a suspended session leaves the client with an error listener during log read', async () => {
  const storage = fakeLogStorage();
  let errorListenersDuringRead = -1;
  const sshClient = fakeSshClient();
  storage.readLog = async () => { errorListenersDuringRead = sshClient.listenerCount('error'); return ''; };
  const service = new SshSuspendService(storage);
  const channel = fakeChannel();
  const suspendId = await service.takeOverMarkedSession({
    userId: 8, originalSessionId: 's2', sshClient, channel, connectionName: 'c', connectionId: '1', logIdentifier: 'log-s2',
  });
  const result = await service.resumeSession(8, suspendId);
  assert.ok(result);
  assert.ok(errorListenersDuringRead >= 1);
});

// --- #14 backup keeps the file mode ---
test('backupFile creates the .nexus-bak copy with the source file mode', async () => {
  const files = new Map([['/home/u/.env', { data: Buffer.from('SECRET=1\n'), mode: 0o100600 }]]);
  const createdWith = [];
  const sftp = {
    lstat(p, cb) {
      const f = files.get(p);
      if (!f) return cb(Object.assign(new Error('No such file'), { code: 2 }));
      cb(undefined, { size: f.data.length, mode: f.mode, isFile: () => true });
    },
    createReadStream(p) { return Readable.from([files.get(p).data]); },
    createWriteStream(p, opts) {
      createdWith.push(opts);
      const chunks = [];
      const stream = new Writable({
        write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
        final(cb) {
          files.set(p, { data: Buffer.concat(chunks), mode: 0o100000 | (opts?.mode ?? 0o644) });
          cb();
        },
      });
      stream.on('finish', () => setImmediate(() => stream.emit('close')));
      return stream;
    },
    chmod(p, mode, cb) { files.get(p).mode = 0o100000 | mode; cb(); },
    unlink(p, cb) { files.delete(p); cb(); },
  };
  const ws = fakeWs();
  const states = new Map([['sftp-s', { ws, sftp, sshClient: fakeSshClient(), dbConnectionId: 1 }]]);
  const service = new SftpService(states);
  await service.backupFile('sftp-s', '/home/u/.env', '/home/u/.env.nexus-bak-1', 'r1');
  assert.equal(ws.sent.at(-1).type, 'sftp:backupfile:success', JSON.stringify(ws.sent.at(-1)));
  assert.equal(createdWith[0]?.mode, 0o600);
  assert.equal(files.get('/home/u/.env.nexus-bak-1').mode & 0o7777, 0o600);
});

// --- #10 graceful shutdown ---
test('graceful shutdown closes the server, sessions and db, then exits 0', async () => {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const order = [];
  let exitCode;
  const shutdown = createGracefulShutdown({
    server,
    getWss: () => ({ clients: new Set(), close: () => order.push('wss') }),
    cleanupSessions: async () => { order.push('sessions'); },
    closeDb: async () => { order.push('db'); },
    exit: code => { exitCode = code; },
    log: () => {},
    timeoutMs: 5000,
  });
  const started = Date.now();
  await shutdown('SIGTERM');
  assert.equal(exitCode, 0);
  assert.equal(server.listening, false);
  assert.deepEqual(order, ['sessions', 'wss', 'db']);
  assert.ok(Date.now() - started < 2000);
});
