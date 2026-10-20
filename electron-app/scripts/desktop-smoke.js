#!/usr/bin/env node
// End-to-end smoke test of a packaged desktop build on a CI runner.
// The app must be started with --remote-debugging-port=9222. Needs playwright-core.
// env: SMOKE_DIR, SMOKE_PLATFORM (macos|windows), SSH_USER, SSH_KEY_FILE
// Every check is reported as a ::notice/::error annotation; any failed check
// makes the script exit non-zero.
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright-core');

const outDir = process.env.SMOKE_DIR || 'smoke';
const platform = process.env.SMOKE_PLATFORM || process.platform;
const sshUser = process.env.SSH_USER;
const sshKey = process.env.SSH_KEY_FILE ? fs.readFileSync(process.env.SSH_KEY_FILE, 'utf8') : null;
fs.mkdirSync(outDir, { recursive: true });

const FRONTEND_PORT = 22457;
const BACKEND_PORT = 22458;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (...args) => console.log(new Date().toISOString(), ...args);
const clean = value => String(value).replace(/\r?\n/g, ' | ').slice(0, 900);
const failures = [];
const pass = (name, detail = '') => console.log(`::notice::${platform} PASS ${name}${detail ? `: ${clean(detail)}` : ''}`);
const fail = (name, detail = '') => { failures.push(name); console.log(`::error::${platform} FAIL ${name}${detail ? `: ${clean(detail)}` : ''}`); };
const check = async (name, fn) => {
  try {
    const detail = await fn();
    pass(name, detail);
  } catch (error) {
    fail(name, error && error.message ? error.message : error);
  }
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const connect = async () => {
  let lastError = null;
  for (let i = 0; i < 60; i += 1) {
    try { return await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 15000 }); } catch (error) { lastError = error; await sleep(2000); }
  }
  throw new Error(`could not reach the app on port 9222: ${lastError?.message}`);
};

const findMainPage = async browser => {
  for (let i = 0; i < 90; i += 1) {
    const pages = browser.contexts().flatMap(context => context.pages());
    const page = pages.find(item => new RegExp(`localhost:${FRONTEND_PORT}`).test(item.url()));
    if (page) return page;
    await sleep(2000);
  }
  const urls = browser.contexts().flatMap(context => context.pages()).map(item => item.url());
  throw new Error(`main window not found; pages: ${urls.join(', ')}`);
};

const tcpConnects = (host, port) => new Promise(resolve => {
  const socket = net.connect({ host, port, timeout: 3000 });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('timeout', () => { socket.destroy(); resolve(false); });
  socket.once('error', () => resolve(false));
});

const rawRequest = (port, requestPath, headers = {}, method = 'GET', body = null) => new Promise(resolve => {
  const request = http.request({ host: '127.0.0.1', port, path: requestPath, method, headers: body ? { 'Content-Type': 'application/json', ...headers } : headers, timeout: 8000 }, response => {
    let body = '';
    response.on('data', chunk => { body += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, body }));
  });
  request.on('timeout', () => { request.destroy(); resolve({ status: 0, body: 'timeout' }); });
  request.on('error', error => resolve({ status: 0, body: error.message }));
  request.end(body ? JSON.stringify(body) : undefined);
});
const rawGet = (port, requestPath, headers = {}) => rawRequest(port, requestPath, headers);

const lanAddresses = () => Object.values(os.networkInterfaces()).flat()
  .filter(item => item && item.family === 'IPv4' && !item.internal)
  .map(item => item.address);

const capture = async (page, name) => {
  await page.screenshot({ path: path.join(outDir, `${name}.png`) }).catch(error => log('screenshot failed', name, error.message));
};

const terminalText = page => page.evaluate(() => Array.from(document.querySelectorAll('.xterm-rows'))
  .map(element => element.textContent || '').join('\n'));

(async () => {
  // ---- network exposure (P0: desktop servers must only listen on loopback) ----
  await check('frontend/backend not reachable from LAN addresses', async () => {
    const exposed = [];
    for (const address of lanAddresses()) {
      for (const port of [FRONTEND_PORT, BACKEND_PORT]) {
        if (await tcpConnects(address, port)) exposed.push(`${address}:${port}`);
      }
    }
    assert(exposed.length === 0, `listening on ${exposed.join(', ')}`);
    return `checked ${lanAddresses().join(', ') || 'no LAN address'}`;
  });

  const browser = await connect();
  const page = await findMainPage(browser);
  log('main page', page.url());
  await page.waitForLoadState('domcontentloaded');
  const consoleErrors = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', error => consoleErrors.push(`pageerror: ${error.message}`));
  const pageSession = await page.context().newCDPSession(page);
  await pageSession.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  await check('loopback guards: foreign Host header refused', async () => {
    const backend = await rawGet(BACKEND_PORT, '/api/v1/auth/needs-setup', { Host: 'evil.example' });
    const frontend = await rawGet(FRONTEND_PORT, '/api/v1/auth/needs-setup', { Host: 'evil.example' });
    assert(backend.status >= 400 || backend.status === 0, `backend answered ${backend.status}`);
    assert(frontend.status >= 400 || frontend.status === 0, `frontend proxy answered ${frontend.status}`);
    return `backend ${backend.status}, frontend ${frontend.status}`;
  });

  const password = 'NexusSmoke#2026';
  await check('loopback setup without the desktop proxy token refused', async () => {
    const response = await rawRequest(BACKEND_PORT, '/api/v1/auth/setup', { Host: `127.0.0.1:${BACKEND_PORT}` }, 'POST',
      { username: 'admin', password, confirmPassword: password });
    assert(response.status >= 400 || response.status === 0, `backend accepted setup: ${response.status} ${response.body.slice(0, 120)}`);
    return `status ${response.status}`;
  });

  const api = (method, url, body) => page.evaluate(async ([m, u, b]) => {
    const response = await fetch(u, {
      method: m,
      credentials: 'include',
      headers: b ? { 'Content-Type': 'application/json' } : {},
      body: b ? JSON.stringify(b) : undefined,
    });
    return { status: response.status, text: await response.text() };
  }, [method, url, body]);

  await check('electron bridge available', async () => {
    const info = await page.evaluate(async () => ({
      hasApi: typeof window.electronAPI === 'object',
      version: await window.electronAPI?.getAppVersion?.(),
      kind: await window.electronAPI?.getInstallationKind?.(),
    }));
    assert(info.hasApi && info.version, 'window.electronAPI missing');
    return `version ${info.version}, installation ${JSON.stringify(info.kind)}`;
  });

  // ---- local terminal (node-pty) open, echo, close timing ----
  await check('local terminal (node-pty) runs a command and closes quickly', async () => {
    const result = await page.evaluate(async isWindows => {
      const api = window.electronAPI;
      let output = '';
      let exited = null;
      let id = null;
      const offOutput = api.onLocalTerminalOutput(payload => { if (payload.terminalId === id) output += payload.data; });
      const offExit = api.onLocalTerminalExit(payload => { if (payload.terminalId === id) exited = payload.exitCode; });
      const created = await api.createLocalTerminal({ cols: 100, rows: 30 });
      id = created.terminalId;
      await new Promise(resolve => setTimeout(resolve, 2500));
      const command = isWindows ? 'echo LOCAL_SMOKE_%NUMBER_OF_PROCESSORS%_OK\r' : 'echo LOCAL_SMOKE_$((40+2))_OK\r';
      await api.writeLocalTerminal({ terminalId: id, data: command });
      const started = Date.now();
      while (!/LOCAL_SMOKE_\d+_OK/.test(output) && Date.now() - started < 15000) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      const closeStart = Date.now();
      await api.closeLocalTerminal(id);
      const closeMs = Date.now() - closeStart;
      const exitWait = Date.now();
      while (exited === null && Date.now() - exitWait < 10000) await new Promise(resolve => setTimeout(resolve, 100));
      offOutput(); offExit();
      return { ok: /LOCAL_SMOKE_\d+_OK/.test(output), closeMs, exitMs: Date.now() - closeStart, exited, tail: output.slice(-300) };
    }, platform === 'windows');
    assert(result.ok, `marker not seen; output tail: ${result.tail}`);
    assert(result.closeMs < 3000, `close took ${result.closeMs} ms`);
    return `close ${result.closeMs} ms, exit event after ${result.exitMs} ms (code ${result.exited})`;
  });

  // ---- first-run setup + login (through the app's own proxy) ----
  await check('setup and login', async () => {
    const setup = await api('GET', '/api/v1/auth/needs-setup');
    if (/"needsSetup":true/.test(setup.text)) {
      const created = await api('POST', '/api/v1/auth/setup', { username: 'admin', password, confirmPassword: password });
      assert(created.status < 300, `setup ${created.status} ${created.text.slice(0, 200)}`);
    }
    const login = await api('POST', '/api/v1/auth/login', { username: 'admin', password, rememberMe: true });
    assert(login.status === 200, `login ${login.status} ${login.text.slice(0, 200)}`);
    const status = await api('GET', '/api/v1/auth/status');
    assert(status.status === 200 && /admin/.test(status.text), `status ${status.status} ${status.text.slice(0, 200)}`);
    return 'ok';
  });

  await check('wrong password rejected', async () => {
    const response = await page.evaluate(async () => {
      const r = await fetch('/api/v1/auth/login', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'wrong-password-123' }) });
      return r.status;
    });
    assert(response === 401 || response === 400 || response === 403, `got ${response}`);
    return `status ${response}`;
  });

  // ---- terminal custom HTML background runs sandboxed (P0) ----
  await check('custom HTML background is sandboxed', async () => {
    await page.context().addInitScript(() => {
      window.__htmlBgMessages = [];
      window.addEventListener('message', event => { if (event.data && event.data.smoke) window.__htmlBgMessages.push(event.data); });
    });
    const html = '<div id="x">bg</div><script>' +
      'var r={smoke:true,alive:true};' +
      'try{parent.document.title="PWNED";r.parentDoc=true}catch(e){r.parentDoc=false}' +
      'try{r.bridge=typeof parent.electronAPI}catch(e){r.bridge="blocked"}' +
      'try{r.cookie=document.cookie.length}catch(e){r.cookie="blocked"}' +
      'parent.postMessage(r,"*");</script>';
    const saved = await api('PUT', '/api/v1/appearance', { terminalBackgroundEnabled: true, terminal_custom_html: html });
    assert(saved.status < 300, `saving appearance ${saved.status} ${saved.text.slice(0, 200)}`);
    return 'saved';
  });

  // ---- SSH terminal through the backend ----
  const host = 'smoke-local';
  await check('create SSH connection', async () => {
    assert(sshUser && sshKey, 'local SSH not prepared');
    const created = await api('POST', '/api/v1/connections', {
      name: host, type: 'SSH', host: '127.0.0.1', port: 22, username: sshUser, auth_method: 'key', private_key: sshKey,
    });
    assert(created.status < 300, `${created.status} ${created.text.slice(0, 200)}`);
    return 'ok';
  });

  await page.goto(`http://localhost:${FRONTEND_PORT}/`);
  await sleep(5000);
  await capture(page, 'dashboard');

  await check('SSH terminal runs a command', async () => {
    const connectButton = page.locator(`xpath=//*[normalize-space(text())='${host}']/ancestor::*[.//button[normalize-space()='连接' or normalize-space()='Connect']][1]//button[normalize-space()='连接' or normalize-space()='Connect']`).first();
    assert(await connectButton.count(), 'connect button not found on the dashboard');
    await connectButton.click();
    let terminal = page.locator('.xterm').first();
    for (let i = 0; i < 30 && !(await terminal.count()); i += 1) await sleep(1000);
    assert(await terminal.count(), `no terminal in workspace (url ${page.url()})`);
    await sleep(6000);
    await terminal.click();
    const command = platform === 'windows' ? 'Write-Output ("SSH_SMOKE_" + (40+2))' : 'echo SSH_SMOKE_$((40+2))';
    await page.keyboard.type(command, { delay: 10 });
    await page.keyboard.press('Enter');
    let text = '';
    for (let i = 0; i < 20; i += 1) {
      await sleep(1000);
      text = await terminalText(page);
      if (/SSH_SMOKE_42/.test(text)) break;
    }
    await capture(page, 'workspace');
    assert(/SSH_SMOKE_42/.test(text), `marker not in terminal; tail: ${text.slice(-300)}`);
    return 'SSH_SMOKE_42 printed';
  });

  await check('HTML background script ran but could not reach the app', async () => {
    let messages = [];
    for (let i = 0; i < 10; i += 1) {
      messages = await page.evaluate(() => window.__htmlBgMessages || []);
      if (messages.length) break;
      await sleep(1000);
    }
    const title = await page.title();
    const frames = await page.evaluate(() => Array.from(document.querySelectorAll('iframe')).map(frame => frame.getAttribute('sandbox')));
    assert(title !== 'PWNED', 'background script changed the app title');
    assert(frames.some(value => value !== null && !/allow-same-origin/.test(value)), `no sandboxed iframe found: ${JSON.stringify(frames)}`);
    assert(messages.length > 0, 'background script never ran');
    const m = messages[0];
    assert(m.parentDoc === false, 'background script reached parent.document');
    assert(m.bridge === 'blocked' || m.bridge === 'undefined', `bridge visible: ${m.bridge}`);
    return JSON.stringify(m);
  });
  await api('PUT', '/api/v1/appearance', { terminalBackgroundEnabled: false, terminal_custom_html: '' });

  await check('SFTP lists the home directory', async () => {
    let text = '';
    for (let i = 0; i < 15; i += 1) {
      text = await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('[class*="file-manager"], [class*="FileManager"], .file-manager, table'));
        return candidates.map(element => element.textContent || '').join('\n');
      });
      if (text.length > 40) break;
      await sleep(1000);
    }
    assert(text.length > 40, 'file manager stayed empty');
    return `${text.length} chars of listing`;
  });

  await check('settings page opens', async () => {
    const link = page.getByText('设置', { exact: true }).first();
    if (await link.count()) await link.click(); else await page.goto(`http://localhost:${FRONTEND_PORT}/settings`);
    await sleep(4000);
    await capture(page, 'settings');
    assert(/settings/.test(page.url()), `url ${page.url()}`);
    return page.url();
  });

  await check('logout clears the session', async () => {
    const out = await api('POST', '/api/v1/auth/logout');
    const status = await api('GET', '/api/v1/auth/status');
    assert(out.status < 300, `logout ${out.status}`);
    assert(status.status === 401 || !/"isAuthenticated":true/.test(status.text), `still logged in: ${status.status} ${status.text.slice(0, 120)}`);
    return `status after logout ${status.status}`;
  });

  const relevantErrors = consoleErrors.filter(text => !/401|Unauthorized|favicon/i.test(text));
  if (relevantErrors.length) {
    console.log(`::warning::${platform} ${relevantErrors.length} console errors: ${clean(relevantErrors.slice(0, 5).join(' || '))}`);
  } else {
    pass('no unexpected console errors');
  }
  fs.writeFileSync(path.join(outDir, 'console-errors.txt'), consoleErrors.join('\n'));

  await browser.close().catch(() => {});
  if (failures.length) {
    console.log(`::error::${platform} ${failures.length} smoke checks failed: ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log(`::notice::${platform} all desktop smoke checks passed`);
  process.exit(0);
})().catch(error => {
  console.log(`::error::${platform} smoke crashed: ${clean(error.message)}`);
  console.error(error);
  process.exit(1);
});
