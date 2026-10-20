const assert = require('node:assert/strict');
const test = require('node:test');
const {
  matchesWhitelist,
  normalizeIp,
  parseWhitelistEntries,
} = require('../dist/auth/ip-match.js');
const { isWsOriginAllowed } = require('../dist/websocket/origin-check.js');
const { getClientIp } = require('../dist/utils/client-ip.js');

test('empty whitelist allows every IP', () => {
  assert.equal(matchesWhitelist('203.0.113.7', ''), true);
  assert.equal(matchesWhitelist('203.0.113.7', null), true);
  assert.equal(matchesWhitelist('203.0.113.7', ' \n , \n'), true);
  assert.equal(matchesWhitelist('2001:db8::1', undefined), true);
});

test('loopback addresses are always allowed, including IPv4-mapped form', () => {
  assert.equal(matchesWhitelist('127.0.0.1', '10.0.0.1'), true);
  assert.equal(matchesWhitelist('::1', '10.0.0.1'), true);
  assert.equal(matchesWhitelist('::ffff:127.0.0.1', '10.0.0.1'), true);
});

test('single IPv4 / IPv6 entries', () => {
  const list = '192.168.1.10\n2001:db8::42';
  assert.equal(matchesWhitelist('192.168.1.10', list), true);
  assert.equal(matchesWhitelist('192.168.1.11', list), false);
  assert.equal(matchesWhitelist('2001:db8:0:0:0:0:0:42', list), true);
  assert.equal(matchesWhitelist('2001:db8::43', list), false);
});

test('IPv4-mapped IPv6 request IPs match IPv4 entries and CIDRs', () => {
  assert.equal(matchesWhitelist('::ffff:192.168.1.10', '192.168.1.10'), true);
  assert.equal(matchesWhitelist('::ffff:10.1.2.3', '10.0.0.0/8'), true);
  assert.equal(matchesWhitelist('::ffff:11.1.2.3', '10.0.0.0/8'), false);
  assert.equal(matchesWhitelist('::FFFF:c0a8:010a', '192.168.1.0/24'), true);
});

test('IPv4-mapped whitelist entries are normalized', () => {
  assert.equal(matchesWhitelist('192.168.1.10', '::ffff:192.168.1.10'), true);
  assert.equal(matchesWhitelist('192.168.1.77', '::ffff:192.168.1.0/120'), true);
  assert.equal(matchesWhitelist('192.168.2.77', '::ffff:192.168.1.0/120'), false);
});

test('CIDR v4 and v6', () => {
  const list = '10.0.0.0/8, 172.16.0.0/12\n2001:db8::/32';
  assert.equal(matchesWhitelist('10.255.255.255', list), true);
  assert.equal(matchesWhitelist('172.31.0.1', list), true);
  assert.equal(matchesWhitelist('172.32.0.1', list), false);
  assert.equal(matchesWhitelist('2001:db8:abcd::1', list), true);
  assert.equal(matchesWhitelist('2001:db9::1', list), false);
  assert.equal(matchesWhitelist('8.8.8.8', list), false);
});

test('invalid entries and unparseable IPs are rejected when a list is set', () => {
  assert.equal(matchesWhitelist('1.2.3.4', 'not-an-ip, 10.0.0.0/99'), false);
  assert.equal(matchesWhitelist('garbage', '1.2.3.4'), false);
  assert.equal(matchesWhitelist(undefined, '1.2.3.4'), false);
  assert.equal(matchesWhitelist('1.2.3.4', 'not-an-ip, 1.2.3.4'), true);
});

test('helpers', () => {
  assert.equal(normalizeIp('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(normalizeIp(' 10.0.0.1 '), '10.0.0.1');
  assert.deepEqual(parseWhitelistEntries('a, b\n\n c'), ['a', 'b', 'c']);
});

test('WebSocket origin check', () => {
  const none = new Set();
  assert.equal(isWsOriginAllowed(undefined, 'example.com', none), true);
  assert.equal(isWsOriginAllowed('https://example.com', 'example.com', none), true);
  assert.equal(isWsOriginAllowed('http://example.com:18111', 'example.com:18111', none), true);
  assert.equal(isWsOriginAllowed('http://example.com:18111', 'example.com', none), true); // nginx $host has no port
  assert.equal(isWsOriginAllowed('https://evil.test', 'example.com', none), false);
  assert.equal(isWsOriginAllowed('http://example.com:9999', 'example.com:18111', none), false);
  assert.equal(isWsOriginAllowed('null', 'example.com', none), false);
  assert.equal(isWsOriginAllowed('http://localhost:22457', 'localhost:22458', none), true); // Electron
  assert.equal(isWsOriginAllowed('http://localhost:5173', '127.0.0.1:3001', none), true); // Vite proxy
  assert.equal(isWsOriginAllowed('http://localhost:5173', 'example.com', none), false);
  assert.equal(isWsOriginAllowed('https://app.example.org', 'backend:3001', new Set(['https://app.example.org'])), true);
  // Host without port: X-Forwarded-Port / strict mode pin the port
  assert.equal(isWsOriginAllowed('http://example.com:18111', 'example.com', none, '18111'), true);
  assert.equal(isWsOriginAllowed('http://example.com:9999', 'example.com', none, '18111'), false);
  assert.equal(isWsOriginAllowed('https://example.com', 'example.com', none, '443'), true);
  assert.equal(isWsOriginAllowed('http://example.com:9999', 'example.com', none, undefined, true), false);
  assert.equal(isWsOriginAllowed('https://example.com', 'example.com', none, undefined, true), true);
});

test('client IP honours TRUST_PROXY and ignores spoofed headers otherwise', () => {
  const req = (remoteAddress, xff, xRealIp) => ({
    socket: { remoteAddress },
    connection: { remoteAddress },
    headers: { ...(xff ? { 'x-forwarded-for': xff } : {}), ...(xRealIp ? { 'x-real-ip': xRealIp } : {}) },
  });
  const prev = process.env.TRUST_PROXY;
  try {
    delete process.env.TRUST_PROXY;
    assert.equal(getClientIp(req('::ffff:172.18.0.5', '1.1.1.1', '2.2.2.2')), '172.18.0.5');
    process.env.TRUST_PROXY = 'true';
    // one trusted hop: the right-most X-Forwarded-For entry (written by nginx) wins
    assert.equal(getClientIp(req('172.18.0.5', '6.6.6.6, 203.0.113.9')), '203.0.113.9');
    assert.equal(getClientIp(req('172.18.0.5')), '172.18.0.5');
    process.env.TRUST_PROXY = '2';
    assert.equal(getClientIp(req('172.18.0.5', '6.6.6.6, 203.0.113.9, 10.0.0.2')), '203.0.113.9');
  } finally {
    if (prev === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = prev;
  }
});
