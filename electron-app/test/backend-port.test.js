const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');

const {
  isPortFree, findFreePort, readPidFile, writePidFile, removePidFile,
  reclaimStaleBackend, chooseBackendPort, probeBackendStatus, isProcessAlive,
} = require('../backend-port');

const tmpPidFile = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-backend-port-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'backend.pid');
};
const quietLog = { warn() {}, log() {}, error() {} };

test('isPortFree / findFreePort detect a busy port', async (t) => {
  const port = await findFreePort();
  assert.equal(await isPortFree(port), true);
  const server = net.createServer().listen(port, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  assert.equal(await isPortFree(port), false);
});

test('pidfile round trip; removePidFile keeps a file that belongs to a newer backend', (t) => {
  const pidFile = tmpPidFile(t);
  assert.equal(readPidFile(pidFile), null);
  writePidFile(pidFile, { pid: 1234, port: 22458 });
  assert.deepEqual({ pid: readPidFile(pidFile).pid, port: readPidFile(pidFile).port }, { pid: 1234, port: 22458 });
  removePidFile(pidFile, 9999);
  assert.ok(readPidFile(pidFile));
  removePidFile(pidFile, 1234);
  assert.equal(readPidFile(pidFile), null);
});

test('chooseBackendPort uses the preferred port when it is free', async (t) => {
  const port = await findFreePort();
  const choice = await chooseBackendPort({ preferredPort: port, pidFilePath: tmpPidFile(t), log: quietLog });
  assert.deepEqual(choice, { port, reclaimed: false, fallback: false });
});

test('a busy port held by something that is not our backend is left alone; a free port is used instead', async (t) => {
  const port = await findFreePort();
  const foreign = http.createServer((_req, res) => res.end('{"status":"other"}')).listen(port, '127.0.0.1');
  await new Promise(resolve => foreign.once('listening', resolve));
  t.after(() => foreign.close());
  const pidFile = tmpPidFile(t);
  writePidFile(pidFile, { pid: process.pid === 1 ? 2 : 1, port }); // pidfile 指向别的进程
  const killed = [];
  const choice = await chooseBackendPort({
    preferredPort: port, pidFilePath: pidFile, log: quietLog,
    deps: { reclaim: { isAlive: () => true, killProcess: (pid) => killed.push(pid) } },
  });
  assert.equal(choice.fallback, true);
  assert.notEqual(choice.port, port);
  assert.deepEqual(killed, [], 'must not kill an unverified process');
});

test('reclaimStaleBackend kills only a verified orphan (status pid matches the pidfile)', async (t) => {
  const pidFile = tmpPidFile(t);
  writePidFile(pidFile, { pid: 4242, port: 5555 });
  const killed = [];
  let alive = true;
  const result = await reclaimStaleBackend({
    pidFilePath: pidFile, port: 5555, log: quietLog,
    probe: async () => ({ status: 'ok', pid: 4242 }),
    isAlive: () => alive,
    killProcess: (pid, signal) => { killed.push([pid, signal]); alive = false; },
  });
  assert.equal(result, true);
  assert.deepEqual(killed, [[4242, 'SIGTERM']]);
  assert.equal(readPidFile(pidFile), null);

  writePidFile(pidFile, { pid: 4242, port: 5555 });
  const notOurs = await reclaimStaleBackend({
    pidFilePath: pidFile, port: 5555, log: quietLog,
    probe: async () => ({ status: 'ok' }), // 旧版本后端不返回 pid → 无法确认
    isAlive: () => true,
    killProcess: () => { throw new Error('must not kill'); },
  });
  assert.equal(notOurs, false);
});

test('end to end: a real orphaned "backend" process holding the port is reclaimed', { timeout: 20000 }, async (t) => {
  const port = await findFreePort();
  const pidFile = tmpPidFile(t);
  // 模拟残留的后端：监听端口，/api/v1/status 返回自己的 PID
  const script = `
    const http = require('http');
    http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', pid: process.pid }));
    }).listen(${port}, '127.0.0.1', () => console.log('READY'));
  `;
  const orphan = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { try { orphan.kill('SIGKILL'); } catch { /* gone */ } });
  await new Promise(resolve => orphan.stdout.once('data', resolve));
  writePidFile(pidFile, { pid: orphan.pid, port });
  assert.equal((await probeBackendStatus(port)).pid, orphan.pid);

  const choice = await chooseBackendPort({ preferredPort: port, pidFilePath: pidFile, log: quietLog });
  assert.deepEqual(choice, { port, reclaimed: true, fallback: false });
  assert.equal(isProcessAlive(orphan.pid), false);
});

test('main.js passes the chosen backend port and parent pid to the backend and the proxy', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(source, /PORT: String\(backendPort\)/);
  assert.match(source, /NEXUS_PARENT_PID: String\(process\.pid\)/);
  assert.match(source, /router: \(\) => `http:\/\/127\.0\.0\.1:\$\{backendPort\}`/);
  assert.match(source, /actualBackendUrlForFileDownloads = `http:\/\/localhost:\$\{backendPort\}`/);
  assert.doesNotMatch(source, /!backendProcess\.killed/);
});
