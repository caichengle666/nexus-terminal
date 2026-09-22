const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { SftpService } = require('../dist/sftp/sftp.service.js');
const { StatusMonitorService } = require('../dist/services/status-monitor.service.js');
const { settingsService } = require('../dist/settings/settings.service.js');
const { TransfersService } = require('../dist/transfers/transfers.service.js');

const toLocalPath = (root, remotePath) => path.join(root, remotePath.replace(/^\/+/, ''));

const createMockSftp = root => ({
  createReadStream(remotePath, options) {
    return fs.createReadStream(toLocalPath(root, remotePath), options);
  },
  createWriteStream(remotePath, options) {
    return fs.createWriteStream(toLocalPath(root, remotePath), options);
  },
  lstat(remotePath, callback) {
    fs.lstat(toLocalPath(root, remotePath), callback);
  },
  unlink(remotePath, callback) {
    fs.unlink(toLocalPath(root, remotePath), callback);
  },
  rename(oldPath, newPath, callback) {
    fs.rename(toLocalPath(root, oldPath), toLocalPath(root, newPath), callback);
  },
  chmod(remotePath, mode, callback) {
    fs.chmod(toLocalPath(root, remotePath), mode, callback);
  },
});

const createEntry = (sourcePath, targetPath, content) => ({
  sourcePath,
  targetPath,
  type: 'file',
  size: content.length,
  mode: 0o100640,
  mtime: 1234567890,
});

test('SFTP relay transfers, resumes, replaces, and handles empty files', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-transfer-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source');
  const targetRoot = path.join(root, 'target');
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(path.join(targetRoot, 'dest'), { recursive: true });

  const service = new TransfersService();
  const sourceSftp = createMockSftp(sourceRoot);
  const targetSftp = createMockSftp(targetRoot);
  const content = Buffer.from('nexus-sftp-relay-content');
  fs.writeFileSync(path.join(sourceRoot, 'source.bin'), content);
  fs.writeFileSync(path.join(targetRoot, 'dest', 'file.bin'), 'old-content');
  const entry = createEntry('/source.bin', '/dest/file.bin', content);

  await service.transferFile(sourceSftp, targetSftp, entry, new AbortController().signal, () => {});
  assert.deepEqual(fs.readFileSync(path.join(targetRoot, 'dest', 'file.bin')), content);

  fs.unlinkSync(path.join(targetRoot, 'dest', 'file.bin'));
  const fingerprint = crypto.createHash('sha256')
    .update(`${entry.sourcePath}\0${entry.size}\0${entry.mtime}`)
    .digest('hex')
    .slice(0, 12);
  const partPath = path.join(targetRoot, 'dest', `file.bin.nexus-transfer.${fingerprint}.part`);
  fs.writeFileSync(partPath, content.subarray(0, 7));
  const progress = [];
  await service.transferFile(sourceSftp, targetSftp, entry, new AbortController().signal, (bytes, delta) => {
    progress.push({ bytes, delta });
  });
  assert.deepEqual(fs.readFileSync(path.join(targetRoot, 'dest', 'file.bin')), content);
  assert.deepEqual(progress[0], { bytes: 7, delta: 0 });

  fs.writeFileSync(path.join(sourceRoot, 'empty.bin'), Buffer.alloc(0));
  const emptyEntry = createEntry('/empty.bin', '/dest/empty.bin', Buffer.alloc(0));
  await service.transferFile(sourceSftp, targetSftp, emptyEntry, new AbortController().signal, () => {});
  assert.equal(fs.statSync(path.join(targetRoot, 'dest', 'empty.bin')).size, 0);
});

test('target path mapping cannot escape the selected directory', () => {
  const service = new TransfersService();
  assert.equal(service.safeJoinTargetPath('/uploads', 'folder/file.txt'), '/uploads/folder/file.txt');
  assert.throws(
    () => service.safeJoinTargetPath('/uploads', '../outside.txt'),
    /目标路径超出指定目录/,
  );
});

test('SFTP initialization is deduplicated and stale channel events do not clear a replacement', async () => {
  const sentMessages = [];
  const channels = [];
  let initializationCount = 0;
  const state = {
    dbConnectionId: 1,
    ws: {
      readyState: 1,
      send(message) { sentMessages.push(JSON.parse(message)); },
    },
    sshClient: {
      sftp(callback) {
        initializationCount += 1;
        const channel = new EventEmitter();
        channel.end = () => {};
        channels.push(channel);
        setImmediate(() => callback(null, channel));
      },
    },
  };
  const service = new SftpService(new Map([['session-1', state]]));

  await Promise.all([
    service.initializeSftpSession('session-1'),
    service.initializeSftpSession('session-1'),
  ]);
  assert.equal(initializationCount, 1);
  assert.equal(sentMessages.filter(message => message.type === 'sftp_ready').length, 1);

  const firstChannel = state.sftp;
  state.sftp = undefined;
  await service.initializeSftpSession('session-1');
  const replacementChannel = state.sftp;
  firstChannel.emit('close');
  assert.equal(state.sftp, replacementChannel);
});

test('SFTP initialization timeout rejects and closes a late stale channel', async () => {
  const sentMessages = [];
  let initializationCallback;
  let lateChannelEndCount = 0;
  const state = {
    dbConnectionId: 1,
    ws: {
      readyState: 1,
      send(message) { sentMessages.push(JSON.parse(message)); },
    },
    sshClient: {
      sftp(callback) { initializationCallback = callback; },
    },
  };
  const service = new SftpService(new Map([['session-1', state]]), { initializationTimeoutMs: 20 });

  await assert.rejects(service.initializeSftpSession('session-1'), /SFTP 初始化超时/);
  const lateChannel = new EventEmitter();
  lateChannel.end = () => { lateChannelEndCount += 1; };
  initializationCallback(null, lateChannel);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(state.sftp, undefined);
  assert.equal(lateChannelEndCount, 1);
  assert.ok(sentMessages.some(message => message.type === 'sftp_error' && /初始化超时/.test(message.payload.message)));
});

test('hanging directory read times out, invalidates its channel, and ignores a late callback', async () => {
  const sentMessages = [];
  let readdirCallback;
  let channelEndCount = 0;
  const sftp = new EventEmitter();
  sftp.readdir = (_path, callback) => { readdirCallback = callback; };
  sftp.end = () => { channelEndCount += 1; };
  const state = {
    dbConnectionId: 1,
    ws: {
      readyState: 1,
      send(message) { sentMessages.push(JSON.parse(message)); },
    },
    sshClient: {},
    sftp,
  };
  const service = new SftpService(new Map([['session-1', state]]), { metadataTimeoutMs: 20, recoveryDelaysMs: [] });

  await service.readdir('session-1', '/slow', 'request-1');
  readdirCallback(null, []);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(state.sftp, undefined);
  assert.equal(channelEndCount, 1);
  assert.equal(sentMessages.filter(message => message.type === 'sftp:readdir:success').length, 0);
  assert.equal(sentMessages.filter(message => message.type === 'sftp:readdir:error').length, 1);
  assert.equal(sentMessages.filter(message => message.type === 'sftp_unavailable').length, 1);
});

test('compression stream errors include the request id and are sent only once', async () => {
  const sentMessages = [];
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.close = () => {};
  const state = {
    ws: {
      readyState: 1,
      send(message) { sentMessages.push(JSON.parse(message)); },
    },
    sshClient: {
      exec(command, callback) {
        if (command.startsWith('command -v')) {
          const checkStream = new EventEmitter();
          checkStream.stderr = new EventEmitter();
          setImmediate(() => {
            callback(null, checkStream);
            setImmediate(() => {
              checkStream.emit('data', Buffer.from('/usr/bin/zip\n'));
              checkStream.emit('close', 0);
            });
          });
          return;
        }
        setImmediate(() => callback(null, stream));
      },
    },
  };
  const service = new SftpService(new Map([['session-1', state]]));

  await service.compress('session-1', {
    sources: ['/tmp/source'],
    destinationArchiveName: 'source.zip',
    format: 'zip',
    targetDirectory: '/tmp',
    requestId: 'compress-1',
  });
  await new Promise(resolve => setImmediate(resolve));
  stream.emit('error', new Error('stream failed'));
  stream.emit('close', 1);

  const errors = sentMessages.filter(message => message.type === 'sftp:compress:error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].requestId, 'compress-1');
  assert.equal(errors[0].payload.requestId, 'compress-1');
});

test('health monitoring skips probes while a session activity is active', async () => {
  let realpathCount = 0;
  const sftp = new EventEmitter();
  sftp.end = () => {};
  sftp.realpath = (_path, callback) => {
    realpathCount += 1;
    setImmediate(() => callback(null, '/home/test'));
  };
  const state = {
    dbConnectionId: 1,
    ws: { readyState: 1, send() {} },
    sshClient: {},
    sftp,
  };
  const service = new SftpService(new Map([['session-1', state]]), {
    healthIntervalMs: 10,
    healthTimeoutMs: 10,
  });

  service.beginSessionActivity('session-1');
  service.startHealthMonitoring?.('session-1');
  await new Promise(resolve => setTimeout(resolve, 25));
  service.endSessionActivity('session-1');

  assert.equal(realpathCount, 0);
  service.cleanupSftpSession('session-1');
});

test('health monitoring replaces a hung SFTP channel without reconnecting SSH', async () => {
  const sentMessages = [];
  const channels = [];
  let initializationCount = 0;
  const state = {
    dbConnectionId: 1,
    ws: {
      readyState: 1,
      send(message) { sentMessages.push(JSON.parse(message)); },
    },
    sshClient: {
      sftp(callback) {
        initializationCount += 1;
        const channel = new EventEmitter();
        channel.end = () => {};
        channel.realpath = initializationCount === 1
          ? (_path, _done) => {}
          : (_path, done) => setImmediate(() => done(null, '/home/test'));
        channels.push(channel);
        setImmediate(() => callback(null, channel));
      },
    },
  };
  const service = new SftpService(new Map([['session-1', state]]), {
    healthIntervalMs: 10,
    healthTimeoutMs: 10,
    initializationTimeoutMs: 30,
    recoveryDelaysMs: [0],
  });

  await service.initializeSftpSession('session-1');
  await new Promise(resolve => setTimeout(resolve, 55));

  assert.equal(initializationCount, 2);
  assert.equal(state.sftp, channels[1]);
  assert.equal(sentMessages.filter(message => message.type === 'sftp_ready').length, 2);
  assert.equal(sentMessages.filter(message => message.type === 'sftp_reconnect_required').length, 0);
  service.cleanupSftpSession('session-1');
});

test('health recovery exhaustion requests a full SSH reconnect', async () => {
  const sentMessages = [];
  let initializationCount = 0;
  const state = {
    dbConnectionId: 1,
    ws: {
      readyState: 1,
      send(message) { sentMessages.push(JSON.parse(message)); },
    },
    sshClient: {
      sftp(callback) {
        initializationCount += 1;
        if (initializationCount > 1) {
          setImmediate(() => callback(new Error('subsystem unavailable')));
          return;
        }
        const channel = new EventEmitter();
        channel.end = () => {};
        channel.realpath = (_path, _done) => {};
        setImmediate(() => callback(null, channel));
      },
    },
  };
  const service = new SftpService(new Map([['session-1', state]]), {
    healthIntervalMs: 10,
    healthTimeoutMs: 10,
    initializationTimeoutMs: 30,
    recoveryDelaysMs: [0, 0],
  });

  await service.initializeSftpSession('session-1');
  await new Promise(resolve => setTimeout(resolve, 65));

  assert.equal(initializationCount, 3);
  assert.equal(state.sftp, undefined);
  assert.equal(sentMessages.filter(message => message.type === 'sftp_reconnect_required').length, 1);
  service.cleanupSftpSession('session-1');
});

test('recursive directory deletion rejects dangerous root-like paths', async () => {
  const sentMessages = [];
  let execCount = 0;
  const state = {
    ws: {
      send(message) { sentMessages.push(JSON.parse(message)); },
    },
    sshClient: {
      exec() { execCount += 1; },
    },
  };
  const service = new SftpService(new Map([['session-1', state]]));

  for (const dangerousPath of ['', '/', '.', '..', '/tmp/../']) {
    await service.rmdir('session-1', dangerousPath, `request-${dangerousPath}`);
  }

  assert.equal(execCount, 0);
  assert.equal(sentMessages.length, 5);
  assert.ok(sentMessages.every(message => message.type === 'sftp:rmdir:error'));
});

test('status polling waits for the current request before scheduling another one', async t => {
  const originalGetInterval = settingsService.getStatusMonitorIntervalSeconds;
  settingsService.getStatusMonitorIntervalSeconds = async () => 0.01;
  t.after(() => {
    settingsService.getStatusMonitorIntervalSeconds = originalGetInterval;
  });

  const state = {
    ws: { readyState: 1 },
    sshClient: {},
  };
  const service = new StatusMonitorService(new Map([['session-1', state]]));
  let activeRequests = 0;
  let maxActiveRequests = 0;
  let requestCount = 0;
  service.fetchAndSendServerStatus = async () => {
    requestCount += 1;
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    await new Promise(resolve => setTimeout(resolve, 30));
    activeRequests -= 1;
  };

  await service.startStatusPolling('session-1');
  await new Promise(resolve => setTimeout(resolve, 95));
  service.stopStatusPolling('session-1');
  const countAfterStop = requestCount;
  await new Promise(resolve => setTimeout(resolve, 50));

  assert.equal(maxActiveRequests, 1);
  assert.ok(countAfterStop >= 2);
  assert.equal(requestCount, countAfterStop);
});
