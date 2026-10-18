#!/usr/bin/env node
// Drives the packaged desktop app (started with --remote-debugging-port=9222)
// to produce README screenshots on a CI runner. Needs playwright-core.
// env: SHOT_DIR, SHOT_PLATFORM (macos|windows), SSH_USER, SSH_KEY_FILE
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const outDir = process.env.SHOT_DIR || 'shots';
const platform = process.env.SHOT_PLATFORM || process.platform;
const sshUser = process.env.SSH_USER;
const sshKey = process.env.SSH_KEY_FILE ? fs.readFileSync(process.env.SSH_KEY_FILE, 'utf8') : null;
fs.mkdirSync(outDir, { recursive: true });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (...args) => console.log(new Date().toISOString(), ...args);
const annotate = (level, message) => console.log(`::${level}::${platform}: ${String(message).replace(/\r?\n/g, ' | ')}`);

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
    const page = pages.find(item => /localhost:22457/.test(item.url()));
    if (page) return page;
    await sleep(2000);
  }
  const urls = browser.contexts().flatMap(context => context.pages()).map(item => item.url());
  throw new Error(`main window not found; pages: ${urls.join(', ')}`);
};

// The app draws its own title bar (min/max/close), so a page capture at a
// fixed 1440x900 viewport already looks like the whole window.
const captureWindow = async (page, name) => {
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  log(`captured ${name}`);
};

const clickText = async (page, text) => {
  const target = page.getByText(text, { exact: true }).first();
  if (!(await target.count())) return false;
  await target.click();
  return true;
};

(async () => {
  const browser = await connect();
  const page = await findMainPage(browser);
  log('main page', page.url());
  await page.waitForLoadState('domcontentloaded');

  const pageSession = await page.context().newCDPSession(page);
  await pageSession.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await sleep(1000);

  const api = (method, url, body) => page.evaluate(async ([m, u, b]) => {
    const response = await fetch(u, {
      method: m,
      credentials: 'include',
      headers: b ? { 'Content-Type': 'application/json' } : {},
      body: b ? JSON.stringify(b) : undefined,
    });
    return { status: response.status, text: await response.text() };
  }, [method, url, body]);

  const password = 'NexusDemo#2026';
  const setup = await api('GET', '/api/v1/auth/needs-setup');
  log('needs-setup', setup.status, setup.text);
  if (/"needsSetup":true/.test(setup.text)) {
    const created = await api('POST', '/api/v1/auth/setup', { username: 'admin', password, confirmPassword: password });
    log('setup', created.status, created.text.slice(0, 200));
  }
  const login = await api('POST', '/api/v1/auth/login', { username: 'admin', password, rememberMe: true });
  log('login', login.status, login.text.slice(0, 200));
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${login.text}`);

  const host = platform === 'macos' ? 'macbook-local' : 'win-local';
  const created = await api('POST', '/api/v1/connections', {
    name: host, type: 'SSH', host: '127.0.0.1', port: 22, username: sshUser, auth_method: 'key', private_key: sshKey,
  });
  log('connection', created.status, created.text.slice(0, 200));
  const demoConnections = [
    ['prod-web-01', '10.0.1.11'], ['prod-web-02', '10.0.1.12'], ['db-primary', '10.0.2.20'],
    ['staging-api', '10.0.3.30'], ['k8s-node-1', '10.0.4.41'],
  ];
  for (const [name, ip] of demoConnections) {
    await api('POST', '/api/v1/connections', { name, type: 'SSH', host: ip, port: 22, username: 'root', auth_method: 'password', password: 'demo-password' });
  }

  const quickCommands = platform === 'macos'
    ? [['磁盘占用', 'df -h'], ['内存/进程', 'top -l 1 | head -12'], ['网络连接', 'netstat -an | head -20']]
    : [['磁盘占用', 'Get-PSDrive -PSProvider FileSystem'], ['进程 Top10', 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 10'], ['网络连接', 'Get-NetTCPConnection | Select-Object -First 15']];
  for (const [name, command] of quickCommands) await api('POST', '/api/v1/quick-commands', { name, command });

  // Dashboard (reload so the new connections and audit entries show)
  await page.goto('http://localhost:22457/');
  await sleep(5000);
  await captureWindow(page, 'dashboard');

  // Connect from the dashboard card; navigation stays in-app from here on so
  // the SSH session survives.
  const connectButton = page.locator(`xpath=//*[normalize-space(text())='${host}']/ancestor::*[.//button[normalize-space()='连接']][1]//button[normalize-space()='连接']`).first();
  if (await connectButton.count()) {
    await connectButton.click();
  } else {
    annotate('warning', 'connect button for the local host not found on the dashboard');
  }
  await sleep(4000);
  if (!/\/workspace/.test(page.url())) await clickText(page, '终端');
  await sleep(8000);
  const terminal = page.locator('.xterm').first();
  if (await terminal.count()) {
    await terminal.click();
    const commands = platform === 'macos'
      ? ["export PS1='runner@macbook %1~ $ '; PS1='\\u@macbook \\W \\$ '", 'clear', 'sw_vers', 'uname -mrs', 'ls -lhG ~', 'df -h / | tail -1']
      : ["function prompt { 'PS ' + (Get-Location).Path + '> ' }", 'cls', '[System.Environment]::OSVersion.VersionString', '$PSVersionTable.PSVersion.ToString()', 'Get-ChildItem C:\\ | Select-Object -First 8'];
    for (const command of commands) {
      await page.keyboard.type(command, { delay: 15 });
      await page.keyboard.press('Enter');
      await sleep(1500);
    }
  } else {
    annotate('warning', `no terminal found in workspace (url ${page.url()})`);
  }
  await sleep(6000);
  await captureWindow(page, 'workspace');

  // Settings
  if (await clickText(page, '设置')) {
    await sleep(4000);
    await captureWindow(page, 'settings');
  }

  annotate('notice', 'screenshots captured');
  await browser.close().catch(() => {});
  process.exit(0);
})().catch(error => {
  annotate('error', error.message);
  console.error(error);
  process.exit(1);
});
