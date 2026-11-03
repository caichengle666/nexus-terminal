const assert = require('node:assert/strict');
const test = require('node:test');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const {
  watchParentProcess, parseParentPid, isProcessAlive, describeListenError, EXIT_CODE_ADDRESS_IN_USE,
} = require('../dist/utils/parent-watch.js');

test('parseParentPid accepts only positive integers', () => {
  assert.equal(parseParentPid('1234'), 1234);
  assert.equal(parseParentPid(' 42 '), 42);
  assert.equal(parseParentPid(''), null);
  assert.equal(parseParentPid(undefined), null);
  assert.equal(parseParentPid('-1'), null);
  assert.equal(parseParentPid('abc'), null);
});

test('isProcessAlive reports the current process alive and a bogus pid dead', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(2 ** 30), false);
});

test('fires once when stdin ends', async () => {
  const stdin = new PassThrough();
  const reasons = [];
  watchParentProcess({ parentPid: process.pid, stdin, ipc: null, pollIntervalMs: 0, onParentGone: r => reasons.push(r) });
  stdin.end();
  await new Promise(resolve => setImmediate(resolve));
  stdin.emit('close');
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /stdin/);
});

test('fires on IPC disconnect and when the parent pid disappears', async () => {
  const ipc = new EventEmitter();
  const reasons = [];
  watchParentProcess({ parentPid: 1, stdin: null, ipc, pollIntervalMs: 0, onParentGone: r => reasons.push(r) });
  ipc.emit('disconnect');
  assert.deepEqual(reasons.length, 1);

  let alive = true;
  const polled = [];
  const keepAlive = setTimeout(() => {}, 2000);
  watchParentProcess({ parentPid: 999, stdin: null, ipc: null, pollIntervalMs: 10, isProcessAlive: () => alive, onParentGone: r => polled.push(r) });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(polled.length, 0);
  alive = false;
  await new Promise(resolve => setTimeout(resolve, 40));
  clearTimeout(keepAlive);
  assert.equal(polled.length, 1);
  assert.match(polled[0], /999/);
});

test('describeListenError explains EADDRINUSE', () => {
  const message = describeListenError(Object.assign(new Error('x'), { code: 'EADDRINUSE' }), 22458, '127.0.0.1');
  assert.match(message, /127\.0\.0\.1:22458/);
  assert.match(message, /已被占用/);
  assert.equal(EXIT_CODE_ADDRESS_IN_USE, 98);
});

test('a child using watchParentProcess exits when its parent is killed (no orphan)', { timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-parent-watch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, 'child.pid');
  const modulePath = JSON.stringify(path.join(__dirname, '..', 'dist', 'utils', 'parent-watch.js'));
  // 子进程：监视父进程，父进程消失就退出
  const childScript = `
    const { watchParentProcess } = require(${modulePath});
    require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    watchParentProcess({ parentPid: Number(process.env.NEXUS_PARENT_PID), pollIntervalMs: 100, onParentGone: () => process.exit(0) });
    setInterval(() => {}, 1000);
  `;
  // 父进程：以 stdio pipe 启动子进程（与 Electron 主进程相同），然后一直挂着，等着被 SIGKILL
  const parentScript = `
    const { spawn } = require('child_process');
    spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: ['pipe', 'ignore', 'inherit'], env: { ...process.env, NEXUS_PARENT_PID: String(process.pid) } });
    setInterval(() => {}, 1000);
  `;
  const parent = spawn(process.execPath, ['-e', parentScript], { stdio: 'ignore' });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(isProcessAlive(childPid), true);
  parent.kill('SIGKILL');
  while (isProcessAlive(childPid) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  assert.equal(isProcessAlive(childPid), false, 'child must exit after its parent is killed');
});
