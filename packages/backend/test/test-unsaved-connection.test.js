const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Server } = require('ssh2');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-unsaved-'));
process.env.APP_BACKEND_DATA_PATH = dataDir;
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

const { getDbInstance } = require('../dist/database/connection.js');
const ConnectionRepository = require('../dist/connections/connection.repository.js');
const SshService = require('../dist/services/ssh.service.js');
const { encrypt } = require('../dist/utils/crypto.js');

const PASSWORD = 'secret';
let server;
let port;
const forwards = [];

test.before(async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  server = new Server({ hostKeys: [privateKey] }, client => {
    client.on('authentication', ctx => {
      if (ctx.method === 'password' && ctx.username === 'u' && ctx.password === PASSWORD) return ctx.accept();
      return ctx.reject(['password']);
    });
    // Act as a jump host: forward direct-tcpip channels.
    client.on('tcpip', (accept, _reject, info) => {
      forwards.push(`${info.destIP}:${info.destPort}`);
      const channel = accept();
      const sock = net.connect(info.destPort, info.destIP);
      channel.pipe(sock).pipe(channel);
      sock.on('error', () => channel.close());
    });
    client.on('error', () => {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

test.after(async () => {
  server?.close();
  try {
    const db = await getDbInstance();
    await new Promise(resolve => db.close(() => resolve()));
  } catch { /* ignore */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const saved = (name, extra = {}) => ConnectionRepository.createConnection({
  name, type: 'SSH', host: '127.0.0.1', port, username: 'u', auth_method: 'password',
  encrypted_password: encrypt(PASSWORD), proxy_id: null, proxy_type: null, notes: null, jump_chain: null, ...extra,
});

test('test-unsaved fills a blank password from the saved connection (edit mode)', async () => {
  const id = await saved('target');
  const result = await SshService.testUnsavedConnection({
    host: '127.0.0.1', port, username: 'u', auth_method: 'password', password: '', connectionId: id,
  });
  assert.ok(typeof result.latency === 'number');

  await assert.rejects(SshService.testUnsavedConnection({
    host: '127.0.0.1', port, username: 'u', auth_method: 'password', password: '',
  }));

  // An explicitly typed (wrong) password wins over the saved one.
  await assert.rejects(SshService.testUnsavedConnection({
    host: '127.0.0.1', port, username: 'u', auth_method: 'password', password: 'wrong', connectionId: id,
  }));
});

test('test-unsaved honours jump_chain', async () => {
  const hopId = await saved('hop');
  forwards.length = 0;
  const result = await SshService.testUnsavedConnection({
    host: '127.0.0.1', port, username: 'u', auth_method: 'password', password: PASSWORD,
    proxy_type: 'jump', jump_chain: [hopId],
  });
  assert.ok(typeof result.latency === 'number');
  assert.deepEqual(forwards, [`127.0.0.1:${port}`], 'connection went through the jump host');

  await assert.rejects(
    SshService.testUnsavedConnection({
      host: '127.0.0.1', port, username: 'u', auth_method: 'password', password: PASSWORD,
      proxy_type: 'jump', jump_chain: [hopId], connectionId: hopId,
    }),
    /itself/,
  );
});
