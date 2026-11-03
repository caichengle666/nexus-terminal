'use strict';

// 选择后端端口，并清理上次残留的后端进程。
//
// 后端默认用固定端口 22458。主进程被强杀或崩溃后（Windows 上子进程不会被连带结束），
// 旧后端可能还占着这个端口。启动时：
//  1. 端口空闲 → 直接用；
//  2. 端口被占用，且 userData 里的 pidfile 记录的进程仍在运行、并且该端口上的服务
//     通过 /api/v1/status 报告的 PID 与 pidfile 一致（确认就是我们上次启动的后端）→ 结束它，等端口释放后再用；
//  3. 否则（别的程序占着，或无法确认）→ 不动它，改用系统分配的空闲端口。
// 单实例锁保证此时不会有另一个正在运行的 Nexus Terminal 在用这个后端。

const fs = require('fs');
const http = require('http');
const net = require('net');

const PIDFILE_NAME = 'backend.pid';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

function findFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ port: 0, host, exclusive: true }, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function readPidFile(pidFilePath) {
  try {
    const data = JSON.parse(fs.readFileSync(pidFilePath, 'utf8'));
    if (data && Number.isInteger(data.pid) && data.pid > 0 && Number.isInteger(data.port)) return data;
  } catch { /* missing or corrupt */ }
  return null;
}

function writePidFile(pidFilePath, { pid, port }) {
  try {
    fs.writeFileSync(pidFilePath, JSON.stringify({ pid, port, startedAt: new Date().toISOString() }), { mode: 0o600 });
  } catch (error) {
    console.warn(`[Backend Port] 写入 pidfile 失败: ${error && error.message}`);
  }
}

function removePidFile(pidFilePath, expectedPid) {
  try {
    if (expectedPid !== undefined) {
      const current = readPidFile(pidFilePath);
      if (current && current.pid !== expectedPid) return; // 已被新的后端覆盖
    }
    fs.rmSync(pidFilePath, { force: true });
  } catch { /* ignore */ }
}

/** GET /api/v1/status，返回 JSON 或 null。 */
function probeBackendStatus(port, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/api/v1/status', timeout: timeoutMs, headers: { host: `localhost:${port}` } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { if (body.length < 4096) body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function waitFor(predicate, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

/**
 * 若端口被我们自己上次残留的后端占着，结束它。返回是否结束了进程。
 * 只有 pidfile 中的 PID 仍在运行、记录的端口一致、且端口上的服务报告同一个 PID 时才会动手。
 */
async function reclaimStaleBackend({ pidFilePath, port, host = '127.0.0.1', killProcess = (pid, signal) => process.kill(pid, signal), probe = probeBackendStatus, isAlive = isProcessAlive, log = console }) {
  const record = readPidFile(pidFilePath);
  if (!record) return false;
  if (record.pid === process.pid) return false;
  if (!isAlive(record.pid)) {
    removePidFile(pidFilePath);
    return false;
  }
  if (record.port !== port) return false;
  const status = await probe(port, host);
  if (!status || status.pid !== record.pid) {
    log.warn(`[Backend Port] 端口 ${port} 上的服务无法确认是上次残留的后端 (pidfile PID ${record.pid})，不结束它。`);
    return false;
  }
  log.warn(`[Backend Port] 发现上次残留的后端进程 (PID ${record.pid}) 占用端口 ${port}，正在结束它...`);
  try { killProcess(record.pid, 'SIGTERM'); } catch { /* already gone */ }
  let exited = await waitFor(() => !isAlive(record.pid), 5000);
  if (!exited) {
    try { killProcess(record.pid, 'SIGKILL'); } catch { /* already gone */ }
    exited = await waitFor(() => !isAlive(record.pid), 3000);
  }
  if (exited) removePidFile(pidFilePath, record.pid);
  return exited;
}

/**
 * 选出本次启动后端要用的端口。
 * @returns {Promise<{ port: number, reclaimed: boolean, fallback: boolean }>}
 */
async function chooseBackendPort({ preferredPort, pidFilePath, host = '127.0.0.1', log = console, deps = {} }) {
  const portFree = deps.isPortFree || isPortFree;
  const freePort = deps.findFreePort || findFreePort;
  if (await portFree(preferredPort, host)) {
    return { port: preferredPort, reclaimed: false, fallback: false };
  }
  const reclaimed = await reclaimStaleBackend({ pidFilePath, port: preferredPort, host, log, ...(deps.reclaim || {}) });
  if (reclaimed && await waitFor(() => portFree(preferredPort, host), 3000, 150)) {
    return { port: preferredPort, reclaimed: true, fallback: false };
  }
  const port = await freePort(host);
  log.warn(`[Backend Port] 端口 ${preferredPort} 被占用，本次改用端口 ${port}。`);
  return { port, reclaimed, fallback: true };
}

module.exports = {
  PIDFILE_NAME,
  isPortFree,
  findFreePort,
  isProcessAlive,
  readPidFile,
  writePidFile,
  removePidFile,
  probeBackendStatus,
  reclaimStaleBackend,
  chooseBackendPort,
};
