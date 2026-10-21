// express-rate-limit 8: the default keyGenerator now groups IPv6 clients by /56 subnet (ipv6Subnet),
// and it runs configuration validations (knownOptions, keyGeneratorIpFallback, ipv6Subnet, ...) once.
// The limiter options below mirror the authLimiter in src/index.ts (window 60s, draft-7 headers,
// no legacy headers, JSON message) behind one trusted proxy hop (TRUST_PROXY=true => 1).
const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const startApp = async limit => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(rateLimit({
    windowMs: 60 * 1000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { message: '请求过于频繁，请稍后再试。' },
  }));
  app.post('/login', (_req, res) => res.json({ ok: true }));
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}/login`;
  const hit = ip => fetch(url, { method: 'POST', headers: { 'X-Forwarded-For': ip } });
  return { server, hit };
};

test('limits per client and answers 429 with the JSON message and draft-7 headers', async t => {
  const errors = [];
  const origError = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };
  t.after(() => { console.error = origError; });
  const { server, hit } = await startApp(2);
  t.after(() => server.close());

  assert.equal((await hit('203.0.113.7')).status, 200);
  const second = await hit('203.0.113.7');
  assert.equal(second.status, 200);
  assert.match(second.headers.get('ratelimit') || '', /limit=2, remaining=0/);
  assert.ok(second.headers.get('ratelimit-policy'));
  assert.equal(second.headers.get('x-ratelimit-limit'), null, 'legacy headers stay disabled');
  const blocked = await hit('203.0.113.7');
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), { message: '请求过于频繁，请稍后再试。' });
  // A different IPv4 client has its own budget.
  assert.equal((await hit('203.0.113.8')).status, 200);
  assert.deepEqual(errors.filter(e => /ERR_ERL_/.test(e)), [], 'no express-rate-limit validation errors');
});

test('IPv6 clients are grouped by /56 subnet (express-rate-limit 8 default)', async t => {
  const { server, hit } = await startApp(1);
  t.after(() => server.close());

  assert.equal((await hit('2001:db8:1234:5601::1')).status, 200);
  // Same /56 (2001:db8:1234:5600::/56), different /64: shares the bucket.
  assert.equal((await hit('2001:db8:1234:56ff::abcd')).status, 429);
  // Different /56: separate bucket.
  assert.equal((await hit('2001:db8:1234:5700::1')).status, 200);
  // IPv4-mapped IPv6 is keyed like the plain IPv4 address.
  assert.equal(ipKeyGenerator('::ffff:198.51.100.9'), ipKeyGenerator('198.51.100.9'));
  assert.equal(ipKeyGenerator('2001:db8:1234:5601::1'), '2001:db8:1234:5600::/56');
});
