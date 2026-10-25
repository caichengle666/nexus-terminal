const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const sqlite3 = require('sqlite3');

process.env.ENCRYPTION_KEY ??= crypto.randomBytes(32).toString('hex');
// 测试只连本机假服务器：不要走环境里的 HTTP(S)_PROXY
for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) delete process.env[k];

const {
  normalizeGotifyBaseUrl,
  buildGotifyMessageUrl,
  normalizeGotifyPriority,
  maskGotifyToken,
  sendGotifyMessage,
} = require('../dist/notifications/gotify.js');
const gotifySender = require('../dist/notifications/senders/gotify.sender.service.js').default;
const { maskNotificationConfig, mergeMaskedNotificationConfig } = require('../dist/notifications/notification-secrets.js');
const { runMigrations } = require('../dist/database/migrations.js');

/** 本地假 Gotify：记录收到的请求，按 X-Gotify-Key 决定成功 / 401 */
const received = [];
let server;
let baseUrl;

test.before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.headers['x-gotify-key'] !== 'AppToken.123') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized', errorCode: 401, errorDescription: 'you need to provide a valid access token' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 42, appid: 1, message: 'ok' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server?.close());

test('server URL normalization', () => {
  assert.deepEqual(normalizeGotifyBaseUrl('https://gotify.example.com'), { baseUrl: 'https://gotify.example.com' });
  assert.equal(normalizeGotifyBaseUrl('  https://gotify.example.com///  ').baseUrl, 'https://gotify.example.com');
  assert.equal(normalizeGotifyBaseUrl('https://gotify.example.com/message?token=abc').baseUrl, 'https://gotify.example.com');
  assert.equal(normalizeGotifyBaseUrl('https://host/gotify/message').baseUrl, 'https://host/gotify');
  assert.equal(normalizeGotifyBaseUrl('http://192.168.1.5:8080/').baseUrl, 'http://192.168.1.5:8080');
  assert.equal(normalizeGotifyBaseUrl('ws://gotify.example.com').error, 'unsupportedProtocol');
  assert.equal(normalizeGotifyBaseUrl('file:///etc/passwd').error, 'unsupportedProtocol');
  assert.equal(normalizeGotifyBaseUrl('gotify.example.com').error, 'invalidUrl');
  assert.equal(normalizeGotifyBaseUrl('').error, 'invalidUrl');
  assert.equal(normalizeGotifyBaseUrl(null).error, 'invalidUrl');
  assert.equal(normalizeGotifyBaseUrl('https://u:p@gotify.example.com').error, 'credentialsInUrl');
  assert.equal(buildGotifyMessageUrl('https://host/gotify/'), 'https://host/gotify/message');
});

test('priority is clamped to 0..10 with default 5', () => {
  assert.equal(normalizeGotifyPriority(8), 8);
  assert.equal(normalizeGotifyPriority(0), 0);
  assert.equal(normalizeGotifyPriority(99), 10);
  assert.equal(normalizeGotifyPriority(-3), 0);
  assert.equal(normalizeGotifyPriority(4.6), 5);
  assert.equal(normalizeGotifyPriority(undefined), 5);
  assert.equal(normalizeGotifyPriority(''), 5);
  assert.equal(normalizeGotifyPriority('7'), 7);
  assert.equal(normalizeGotifyPriority('abc'), 5);
  assert.equal(maskGotifyToken('AppToken.123').includes('AppToken'), false);
});

test('sends title/message/priority to {base}/message with the token in X-Gotify-Key', async () => {
  received.length = 0;
  const result = await sendGotifyMessage(
    { serverUrl: `${baseUrl}/sub/path/message?token=ignored`, token: ' AppToken.123 ', priority: 42 },
    { title: 'Login success', message: 'admin logged in' },
  );
  assert.equal(result.id, 42);
  assert.equal(received.length, 1);
  const req = received[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/sub/path/message', 'token must not be put in the URL');
  assert.equal(req.headers['x-gotify-key'], 'AppToken.123');
  assert.deepEqual(JSON.parse(req.body), { title: 'Login success', message: 'admin logged in', priority: 10 });
});

test('fixed title from config wins; dispatcher sender uses subject + body', async () => {
  received.length = 0;
  await gotifySender.send({
    channelType: 'gotify',
    config: { serverUrl: baseUrl, token: 'AppToken.123', title: 'Nexus prod' },
    subject: 'SSH connect failure',
    body: 'host 10.0.0.1',
  });
  assert.deepEqual(JSON.parse(received[0].body), { title: 'Nexus prod', message: 'host 10.0.0.1', priority: 5 });
});

test('HTTP errors and bad configs are reported without leaking the token', async () => {
  await assert.rejects(
    sendGotifyMessage({ serverUrl: baseUrl, token: 'WrongSecretToken' }, { title: 't', message: 'm' }),
    (err) => /HTTP 401/.test(err.message) && /valid access token/.test(err.message) && !err.message.includes('WrongSecretToken'),
  );
  await assert.rejects(sendGotifyMessage({ serverUrl: baseUrl, token: '' }, { title: 't', message: 'm' }), /incomplete/);
  await assert.rejects(sendGotifyMessage({ serverUrl: 'ftp://x', token: 'a' }, { title: 't', message: 'm' }), /http:\/\/ or https:\/\//);
  // 请求头注入
  await assert.rejects(sendGotifyMessage({ serverUrl: baseUrl, token: 'a\r\nX-Evil: 1' }, { title: 't', message: 'm' }), /invalid characters/);
});

test('SSRF guard blocks cloud metadata addresses', async () => {
  await assert.rejects(
    sendGotifyMessage({ serverUrl: 'http://169.254.169.254', token: 'AppToken.123' }, { title: 't', message: 'm' }),
    /禁止访问|EBLOCKED|blocked/i,
  );
});

test('skipTlsVerify allows a self-signed HTTPS Gotify', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gotify-tls-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'),
      '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    t.skip('openssl not available');
    return;
  }
  const tls = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":7}'); });
  });
  await new Promise((resolve) => tls.listen(0, '127.0.0.1', resolve));
  const url = `https://127.0.0.1:${tls.address().port}`;
  try {
    await assert.rejects(sendGotifyMessage({ serverUrl: url, token: 'AppToken.123' }, { title: 't', message: 'm' }), /Failed to reach/);
    const ok = await sendGotifyMessage({ serverUrl: url, token: 'AppToken.123', skipTlsVerify: true }, { title: 't', message: 'm' });
    assert.equal(ok.id, 7);
  } finally {
    tls.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gotify token is masked for the client and kept when the masked value is sent back', () => {
  const masked = maskNotificationConfig({ serverUrl: 'https://g', token: 'AppToken.123', priority: 5 });
  assert.notEqual(masked.token, 'AppToken.123');
  assert.equal(masked.serverUrl, 'https://g');
  const merged = mergeMaskedNotificationConfig({ ...masked, priority: 8 }, { serverUrl: 'https://g', token: 'AppToken.123' });
  assert.equal(merged.token, 'AppToken.123');
  assert.equal(merged.priority, 8);
});

test('migration #14 rebuilds notification_settings so gotify rows are accepted, keeping existing channels', async () => {
  const db = new sqlite3.Database(':memory:');
  const exec = (sql) => new Promise((resolve, reject) => db.exec(sql, (e) => (e ? reject(e) : resolve())));
  const all = (sql) => new Promise((resolve, reject) => db.all(sql, (e, rows) => (e ? reject(e) : resolve(rows))));
  try {
    await exec(`
      CREATE TABLE notification_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_type TEXT NOT NULL CHECK(channel_type IN ('webhook', 'email', 'telegram')),
        name TEXT NOT NULL DEFAULT '', enabled BOOLEAN NOT NULL DEFAULT false,
        config TEXT NOT NULL DEFAULT '{}', enabled_events TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
      INSERT INTO notification_settings (id, channel_type, name, enabled, config, enabled_events) VALUES (3, 'telegram', 'tg', 1, '{"chatId":"1"}', '["LOGIN_SUCCESS"]');
      CREATE TABLE migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL DEFAULT 0);
      ${Array.from({ length: 13 }, (_, i) => `INSERT INTO migrations (id, name) VALUES (${i + 1}, 'm${i + 1}');`).join('\n')}
    `);
    await assert.rejects(exec(`INSERT INTO notification_settings (channel_type, name) VALUES ('gotify', 'g')`), /CHECK/);
    await runMigrations(db);
    await exec(`INSERT INTO notification_settings (channel_type, name) VALUES ('gotify', 'g')`);
    const rows = await all('SELECT id, channel_type, name, enabled, config, enabled_events FROM notification_settings ORDER BY id');
    assert.deepEqual(rows[0], { id: 3, channel_type: 'telegram', name: 'tg', enabled: 1, config: '{"chatId":"1"}', enabled_events: '["LOGIN_SUCCESS"]' });
    assert.equal(rows[1].channel_type, 'gotify');
    assert.ok(rows[1].id > 3, 'AUTOINCREMENT continues after existing ids');
  } finally {
    await new Promise((resolve) => db.close(resolve));
  }
});
