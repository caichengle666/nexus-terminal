const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Server } = require('ssh2');

// Isolated data dir + encryption key; must be set before loading dist modules.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-port-forward-test-'));
process.env.APP_BACKEND_DATA_PATH = dataDir;
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

const { getDbInstance, allDb } = require('../dist/database/connection.js');
const ConnectionRepository = require('../dist/connections/connection.repository.js');
const ConnectionService = require('../dist/connections/connection.service.js');
const Repo = require('../dist/port-forward/port-forward.repository.js');
const Service = require('../dist/port-forward/port-forward.service.js');
const { sanitizeRuleInput } = require('../dist/port-forward/port-forward.controller.js');
const { requireDesktopMode } = require('../dist/port-forward/port-forward.routes.js');
const ImportExport = require('../dist/services/import-export.service.js');
const { encrypt } = require('../dist/utils/crypto.js');

const PASSWORD = 'secret';
let sshServer;
let sshPort;
let echoServer;
let echoPort;
const directTcpip = [];
/** 服务器端登记的 -R：`${bindAddr}:${bindPort}` -> 对应的 ssh2 服务端连接 */
const remoteForwards = new Map();

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

/** 连上 host:port，发 payload，收满 expectLen 字节后返回 */
const roundTrip = (port, payload, { prefix, expectLen } = {}) => new Promise((resolve, reject) => {
  const sock = net.connect(port, '127.0.0.1');
  let buf = Buffer.alloc(0);
  const want = expectLen ?? payload.length;
  const timer = setTimeout(() => { sock.destroy(); reject(new Error(`timeout, got ${buf.length} bytes`)); }, 5000);
  sock.on('connect', () => {
    if (prefix) sock.write(prefix);
    sock.write(payload);
  });
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    if (buf.length >= want) {
      clearTimeout(timer);
      sock.destroy();
      resolve(buf);
    }
  });
  sock.on('error', err => { clearTimeout(timer); reject(err); });
});

test.before(async () => {
  echoServer = net.createServer(s => s.pipe(s));
  await new Promise(resolve => echoServer.listen(0, '127.0.0.1', resolve));
  echoPort = echoServer.address().port;

  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  sshServer = new Server({ hostKeys: [privateKey] }, client => {
    client.on('authentication', ctx => {
      if (ctx.method === 'password' && ctx.username === 'u' && ctx.password === PASSWORD) return ctx.accept();
      return ctx.reject(['password']);
    });
    client.on('ready', () => {
      // -L / -D：direct-tcpip
      client.on('tcpip', (accept, _reject, info) => {
        directTcpip.push(`${info.destIP}:${info.destPort}`);
        const channel = accept();
        const sock = net.connect(info.destPort, info.destIP);
        channel.pipe(sock).pipe(channel);
        sock.on('error', () => channel.close());
      });
      // -R：tcpip-forward / cancel-tcpip-forward
      client.on('request', (accept, reject, name, info) => {
        if (name === 'tcpip-forward') {
          const port = info.bindPort || 40000 + Math.floor(Math.random() * 1000);
          remoteForwards.set(`${info.bindAddr}:${port}`, client);
          accept && accept(port);
        } else if (name === 'cancel-tcpip-forward') {
          remoteForwards.delete(`${info.bindAddr}:${info.bindPort}`);
          accept && accept();
        } else {
          reject && reject();
        }
      });
    });
    client.on('error', () => {});
  });
  await new Promise(resolve => sshServer.listen(0, '127.0.0.1', resolve));
  sshPort = sshServer.address().port;
});

test.after(async () => {
  await Service.stopAll();
  sshServer?.close();
  echoServer?.close();
  try {
    const db = await getDbInstance();
    await new Promise(resolve => db.close(() => resolve()));
  } catch { /* ignore */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const createConn = (name, extra = {}) => ConnectionRepository.createConnection({
  name, type: 'SSH', host: '127.0.0.1', port: sshPort, username: 'u', auth_method: 'password',
  encrypted_password: encrypt(PASSWORD), proxy_id: null, proxy_type: null, notes: null, jump_chain: null, ...extra,
});

test('routes are gated to desktop mode (403 on web / Docker)', () => {
  const run = () => {
    let statusCode = 200;
    let body;
    let nextCalled = false;
    const res = { status(c) { statusCode = c; return this; }, json(b) { body = b; return this; } };
    requireDesktopMode({}, res, () => { nextCalled = true; });
    return { statusCode, body, nextCalled };
  };
  const prev = process.env.NEXUS_DESKTOP_PROXY_TOKEN;
  try {
    delete process.env.NEXUS_DESKTOP_PROXY_TOKEN;
    const web = run();
    assert.equal(web.statusCode, 403);
    assert.equal(web.nextCalled, false);
    assert.equal(web.body.code, 'PORT_FORWARD_DESKTOP_ONLY');

    process.env.NEXUS_DESKTOP_PROXY_TOKEN = 'desktop-token';
    const desktop = run();
    assert.equal(desktop.nextCalled, true);
  } finally {
    if (prev === undefined) delete process.env.NEXUS_DESKTOP_PROXY_TOKEN; else process.env.NEXUS_DESKTOP_PROXY_TOKEN = prev;
  }
});

test('rule input is validated and defaults to 127.0.0.1', () => {
  const r = sanitizeRuleInput({ type: 'local', bind_port: 8080, target_host: ' db.internal ', target_port: 5432 });
  assert.equal(r.bind_host, '127.0.0.1');
  assert.equal(r.target_host, 'db.internal');
  const d = sanitizeRuleInput({ type: 'dynamic', bind_port: 1080, target_host: 'x', target_port: 1 });
  assert.equal(d.target_host, null);
  assert.equal(d.target_port, null);
  assert.throws(() => sanitizeRuleInput({ type: 'bogus', bind_port: 1 }));
  assert.throws(() => sanitizeRuleInput({ type: 'local', bind_port: 0, target_host: 'a', target_port: 1 }));
  assert.throws(() => sanitizeRuleInput({ type: 'local', bind_port: 70000, target_host: 'a', target_port: 1 }));
  assert.throws(() => sanitizeRuleInput({ type: 'local', bind_port: 1, target_host: '', target_port: 1 }));
  assert.throws(() => sanitizeRuleInput({ type: 'local', bind_port: 1, bind_host: 'a b', target_host: 'x', target_port: 1 }));
  assert.throws(() => sanitizeRuleInput({ type: 'remote', bind_port: 1, target_host: 'x;rm', target_port: 1 }));
});

test('local -L forward pipes data through direct-tcpip', async () => {
  const connId = await createConn('pf-local');
  const bindPort = await freePort();
  const rule = await Repo.createRule(connId, { type: 'local', bind_port: bindPort, target_host: '127.0.0.1', target_port: echoPort });
  assert.equal(rule.bind_host, '127.0.0.1');

  const status = await Service.startRule(rule);
  assert.equal(status.running, true);
  // 重复启动是幂等的
  await Service.startRule(rule);

  const payload = crypto.randomBytes(64 * 1024);
  const echoed = await roundTrip(bindPort, payload);
  assert.ok(echoed.equals(payload), 'echoed payload differs');
  assert.ok(directTcpip.includes(`127.0.0.1:${echoPort}`));
  assert.ok(Service.getStatuses([rule])[0].connCount >= 1);

  await Service.stopRule(rule.id);
  assert.equal(Service.getStatuses([rule])[0].running, false);
  await assert.rejects(roundTrip(bindPort, Buffer.from('x')), /ECONNREFUSED/);
});

test('dynamic -D runs a SOCKS5 CONNECT proxy (IPv4 + domain, early data kept)', async () => {
  const connId = await createConn('pf-dynamic');
  const bindPort = await freePort();
  const rule = await Repo.createRule(connId, { type: 'dynamic', bind_port: bindPort });
  await Service.startRule(rule);

  // IPv4 地址类型，问候 + 请求 + 数据一次性发出（客户端不等应答）
  const req4 = Buffer.from([0x05, 0x01, 0x00, 0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, (echoPort >> 8) & 0xff, echoPort & 0xff]);
  const payload = Buffer.from('hello over socks');
  const out = await roundTrip(bindPort, payload, { prefix: req4, expectLen: 2 + 10 + payload.length });
  assert.deepEqual([...out.subarray(0, 2)], [0x05, 0x00]);
  assert.equal(out[3], 0x00, 'SOCKS reply should be success');
  assert.equal(out.subarray(12).toString(), payload.toString());

  // 域名地址类型
  const host = Buffer.from('localhost');
  const reqDomain = Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x05, 0x01, 0x00, 0x03, host.length]), host,
    Buffer.from([(echoPort >> 8) & 0xff, echoPort & 0xff]),
  ]);
  const out2 = await roundTrip(bindPort, Buffer.from('domain'), { prefix: reqDomain, expectLen: 12 + 6 });
  assert.equal(out2[3], 0x00);
  assert.equal(out2.subarray(12).toString(), 'domain');
  assert.ok(directTcpip.includes(`localhost:${echoPort}`));

  // 不支持的命令（BIND）返回 0x07
  const bindReq = Buffer.from([0x05, 0x01, 0x00, 0x05, 0x02, 0x00, 0x01, 127, 0, 0, 1, 0, 80]);
  const out3 = await roundTrip(bindPort, Buffer.alloc(0), { prefix: bindReq, expectLen: 4 });
  assert.equal(out3[3], 0x07);

  await Service.stopRule(rule.id);
});

test('parseSocks5Request handles partial input', () => {
  assert.equal(Service.parseSocks5Request(Buffer.from([0x05, 0x01, 0x00])), null);
  assert.equal(Service.parseSocks5Request(Buffer.from([0x05, 0x01, 0x00, 0x01, 1, 2])), null);
  assert.deepEqual(Service.parseSocks5Request(Buffer.from([0x05, 0x01, 0x00, 0x09, 0, 0])), { error: 0x08 });
  const ok = Service.parseSocks5Request(Buffer.from([0x05, 0x01, 0x00, 0x01, 10, 0, 0, 1, 0, 22, 0xaa]));
  assert.deepEqual(ok, { host: '10.0.0.1', port: 22, consumed: 10 });
});

test('remote -R registers tcpip-forward and routes inbound channels to the local target', async () => {
  const connId = await createConn('pf-remote');
  const rule = await Repo.createRule(connId, { type: 'remote', bind_port: 0, target_host: '127.0.0.1', target_port: echoPort });
  const status = await Service.startRule(rule);
  assert.equal(status.running, true);
  assert.ok(status.remotePort > 0, 'server-assigned port should be reported');

  const key = `127.0.0.1:${status.remotePort}`;
  const serverConn = remoteForwards.get(key);
  assert.ok(serverConn, 'server should have seen tcpip-forward');

  const echoed = await new Promise((resolve, reject) => {
    serverConn.forwardOut('127.0.0.1', status.remotePort, '127.0.0.1', 55555, (err, stream) => {
      if (err) return reject(err);
      let buf = Buffer.alloc(0);
      stream.on('data', d => {
        buf = Buffer.concat([buf, d]);
        if (buf.length >= 5) { stream.close(); resolve(buf.toString()); }
      });
      stream.write('ping!');
    });
  });
  assert.equal(echoed, 'ping!');

  await Service.stopRule(rule.id);
  assert.equal(remoteForwards.has(key), false, 'stop should cancel the remote forward');
});

test('start failure (port in use) is reported in status and does not leak', async () => {
  const connId = await createConn('pf-busy');
  const blocker = net.createServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const busyPort = blocker.address().port;
  try {
    const rule = await Repo.createRule(connId, { type: 'local', bind_port: busyPort, target_host: '127.0.0.1', target_port: echoPort });
    await assert.rejects(Service.startRule(rule), /EADDRINUSE/);
    const st = Service.getStatuses([rule])[0];
    assert.equal(st.running, false);
    assert.match(st.error, /EADDRINUSE/);
    Service.clearLastError(rule.id);
    assert.equal(Service.getStatuses([rule])[0].error, undefined);
  } finally {
    blocker.close();
  }
});

test('bad credentials fail cleanly', async () => {
  const connId = await createConn('pf-badauth', { encrypted_password: encrypt('wrong') });
  const rule = await Repo.createRule(connId, { type: 'dynamic', bind_port: await freePort() });
  await assert.rejects(Service.startRule(rule));
  assert.equal(Service.getStatuses([rule])[0].running, false);
  assert.ok(Service.getStatuses([rule])[0].error);
});

test('deleting a connection stops its forwards and removes its rules', async () => {
  const connId = await createConn('pf-delete');
  const bindPort = await freePort();
  const rule = await Repo.createRule(connId, { type: 'local', bind_port: bindPort, target_host: '127.0.0.1', target_port: echoPort, auto_start: true });
  await Service.startRule(rule);
  assert.ok((await Repo.listAutoStartRules()).some(r => r.id === rule.id));

  await ConnectionService.deleteConnection(connId);
  assert.equal(await Repo.getRuleById(rule.id), null);
  assert.equal(Service.getStatuses([rule])[0].running, false);
  await assert.rejects(roundTrip(bindPort, Buffer.from('x')), /ECONNREFUSED/);
});

test('export includes port_forwards per connection and import restores them', async () => {
  const db = await getDbInstance();
  const connId = await createConn('pf-export');
  await Repo.createRule(connId, { type: 'local', bind_host: '127.0.0.1', bind_port: 15432, target_host: 'db.internal', target_port: 5432, auto_start: true });
  await Repo.createRule(connId, { type: 'dynamic', bind_port: 1080 });

  const json = JSON.parse((await ImportExport.exportConnectionsAsJson()).toString('utf8'));
  const exported = json.connections.find(c => c.name === 'pf-export');
  assert.deepEqual(exported.port_forwards, [
    { type: 'local', bind_host: '127.0.0.1', bind_port: 15432, target_host: 'db.internal', target_port: 5432, auto_start: true },
    { type: 'dynamic', bind_host: '127.0.0.1', bind_port: 1080, auto_start: false },
  ]);

  // 只导入这一条（改名避免和原连接混淆），再塞一条坏规则
  exported.name = 'pf-export-imported';
  exported.port_forwards.push({ type: 'local', bind_port: 99999, target_host: 'x', target_port: 1 });
  const result = await ImportExport.importConnections(Buffer.from(JSON.stringify({ ...json, connections: [exported] })));
  assert.equal(result.successCount, 1);
  assert.ok(result.errors.some(e => /端口转发/.test(e.message)));

  const [row] = await allDb(db, "SELECT id FROM connections WHERE name = 'pf-export-imported'");
  const rules = await Repo.listRulesByConnection(row.id);
  assert.equal(rules.length, 2);
  assert.equal(rules[0].target_host, 'db.internal');
  assert.equal(rules[0].auto_start, 1);
  assert.equal(rules[1].type, 'dynamic');
  assert.equal(rules[1].target_host, null);

  // 旧文件（没有 port_forwards 字段）照常导入
  const legacy = { ...exported, name: 'pf-legacy' };
  delete legacy.port_forwards;
  const r2 = await ImportExport.importConnections(Buffer.from(JSON.stringify({ connections: [legacy] })));
  assert.equal(r2.successCount, 1);
});
