const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

// The sandbox / CI may set an HTTP proxy; these tests talk to a local server directly.
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[key];
const {
  isBlockedIp,
  assertUrlHostAllowed,
  assertHostResolvesSafely,
  guardedLookup,
  safeAxios,
  safeWebhookAxios,
  urlOriginForLog,
  summarizeUpstreamBodyForLog,
} = require('../dist/utils/safe-http.js');

test('blocks link-local and cloud metadata addresses', () => {
  for (const ip of ['169.254.169.254', '169.254.0.1', '169.254.255.255', '100.100.100.200',
    'fe80::1', 'febf::1', 'fe80::1%eth0', '[fe80::1]', 'fd00:ec2::254', 'FD00:EC2:0:0:0:0:0:254',
    '::ffff:169.254.169.254', '::ffff:100.100.100.200']) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
});

test('allows loopback, private LAN and public addresses (Ollama etc. keep working)', () => {
  for (const ip of ['127.0.0.1', '::1', '10.0.0.5', '172.16.3.4', '192.168.1.10', '100.64.0.1',
    '100.100.100.201', 'fd00:ec2::253', 'fc00::1', '8.8.8.8', '2001:4860:4860::8888', '169.253.255.255', 'fec0::1',
    'not-an-ip']) {
    assert.equal(isBlockedIp(ip), false, ip);
  }
});

test('URL literal hosts are checked before the request', () => {
  assert.throws(() => assertUrlHostAllowed('http://169.254.169.254/latest/meta-data/'), /禁止访问/);
  assert.throws(() => assertUrlHostAllowed('http://[fd00:ec2::254]/'), /禁止访问/);
  assert.throws(() => assertUrlHostAllowed('http://[::ffff:a9fe:a9fe]/'), /禁止访问/);
  assert.doesNotThrow(() => assertUrlHostAllowed('http://127.0.0.1:11434/v1'));
  assert.doesNotThrow(() => assertUrlHostAllowed('https://api.openai.com/v1'));
});

test('DNS results are checked (localhost allowed)', async () => {
  await assert.doesNotReject(assertHostResolvesSafely('localhost'));
  await assert.rejects(assertHostResolvesSafely('169.254.169.254'), /禁止访问/);
  await new Promise((resolve, reject) => {
    guardedLookup('localhost', {}, (err, address) => {
      try {
        assert.equal(err, null);
        assert.ok(['127.0.0.1', '::1'].includes(address));
        resolve();
      } catch (e) { reject(e); }
    });
  });
});

test('safe axios refuses metadata targets and redirects to them; webhooks never follow redirects', async t => {
  await assert.rejects(safeAxios.get('http://169.254.169.254/latest/meta-data/', { timeout: 2000 }), /禁止访问/);

  const server = http.createServer((req, res) => {
    if (req.url === '/redirect-to-metadata') {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
      return;
    }
    if (req.url === '/redirect-local') {
      res.writeHead(302, { Location: '/ok' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const ok = await safeAxios.get(`${base}/ok`);
  assert.equal(ok.data, 'ok');
  const followed = await safeAxios.get(`${base}/redirect-local`);
  assert.equal(followed.data, 'ok');
  await assert.rejects(safeAxios.get(`${base}/redirect-to-metadata`, { timeout: 2000 }), /禁止访问/);
  await assert.rejects(safeWebhookAxios.get(`${base}/redirect-local`), err => err.response?.status === 302 || /redirect/i.test(err.message));
});

test('log helpers keep only the origin and truncate bodies', () => {
  assert.equal(urlOriginForLog('https://hooks.slack.com/services/T000/B000/SECRET'), 'https://hooks.slack.com');
  assert.equal(urlOriginForLog('nope'), '(invalid url)');
  const long = 'x'.repeat(1000);
  assert.ok(summarizeUpstreamBodyForLog(long, 100).length < 130);
  assert.equal(summarizeUpstreamBodyForLog({ a: 1 }), '{"a":1}');
});
