const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-timeout-'));
process.env.APP_BACKEND_DATA_PATH = dataDir;
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

const { getDbInstance } = require('../dist/database/connection.js');
const { settingsRepository } = require('../dist/settings/settings.repository.js');
const {
  settingsService,
  normalizeConnectionTestTimeoutSeconds,
  CONNECTION_TEST_TIMEOUT_SECONDS_KEY,
} = require('../dist/settings/settings.service.js');
const SshService = require('../dist/services/ssh.service.js');

let blackhole;
let blackholePort;
const sockets = new Set();

test.before(async () => {
  await getDbInstance();
  // 接受 TCP 但从不发 SSH banner：模拟跨洋/代理下迟迟握不上手的机器
  blackhole = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('error', () => {});
    sock.on('close', () => sockets.delete(sock));
  });
  await new Promise((resolve) => blackhole.listen(0, '127.0.0.1', resolve));
  blackholePort = blackhole.address().port;
});

test.after(async () => {
  for (const s of sockets) s.destroy();
  blackhole?.close();
  try {
    const db = await getDbInstance();
    await new Promise((resolve) => db.close(() => resolve()));
  } catch { /* ignore */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('normalizeConnectionTestTimeoutSeconds clamps and rejects junk', () => {
  assert.equal(normalizeConnectionTestTimeoutSeconds(undefined), 15);
  assert.equal(normalizeConnectionTestTimeoutSeconds(null), 15);
  assert.equal(normalizeConnectionTestTimeoutSeconds(''), 15);
  assert.equal(normalizeConnectionTestTimeoutSeconds('abc'), 15);
  assert.equal(normalizeConnectionTestTimeoutSeconds('10abc'), 15);
  assert.equal(normalizeConnectionTestTimeoutSeconds('-3'), 15);
  assert.equal(normalizeConnectionTestTimeoutSeconds('0'), 15);
  assert.equal(normalizeConnectionTestTimeoutSeconds(Number.NaN), 15);
  assert.equal(normalizeConnectionTestTimeoutSeconds('1'), 5);
  assert.equal(normalizeConnectionTestTimeoutSeconds('30'), 30);
  assert.equal(normalizeConnectionTestTimeoutSeconds(' 45 '), 45);
  assert.equal(normalizeConnectionTestTimeoutSeconds('500'), 120);
  assert.equal(normalizeConnectionTestTimeoutSeconds(20.6), 21);
});

test('settings service and ssh service read the configured timeout', async () => {
  await settingsRepository.setSetting(CONNECTION_TEST_TIMEOUT_SECONDS_KEY, '30');
  assert.equal(await settingsService.getConnectionTestTimeoutSeconds(), 30);
  assert.equal(await SshService.getTestTimeoutMs(), 30000);

  await settingsRepository.setSetting(CONNECTION_TEST_TIMEOUT_SECONDS_KEY, '9999');
  assert.equal(await SshService.getTestTimeoutMs(), 120000);

  await settingsRepository.setSetting(CONNECTION_TEST_TIMEOUT_SECONDS_KEY, 'junk');
  assert.equal(await SshService.getTestTimeoutMs(), 15000);
});

test('test connection gives up after the configured timeout', async () => {
  await settingsRepository.setSetting(CONNECTION_TEST_TIMEOUT_SECONDS_KEY, '5');
  const started = Date.now();
  await assert.rejects(SshService.testUnsavedConnection({
    host: '127.0.0.1', port: blackholePort, username: 'u', auth_method: 'password', password: 'x',
  }));
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 4500, `should wait about 5s, waited ${elapsed}ms`);
  assert.ok(elapsed < 12000, `should not wait the old 15s default, waited ${elapsed}ms`);
});
