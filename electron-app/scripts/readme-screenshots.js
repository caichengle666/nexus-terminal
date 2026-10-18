#!/usr/bin/env node
// Drives the packaged desktop app (started with --remote-debugging-port=9222)
// to produce README screenshots on a CI runner. Needs playwright-core and sharp.
// env: SHOT_DIR, SHOT_PLATFORM (macos|windows), SSH_USER, SSH_KEY_FILE
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright-core');
const sharp = require('sharp');

const outDir = process.env.SHOT_DIR || 'shots';
const platform = process.env.SHOT_PLATFORM || process.platform;
const sshUser = process.env.SSH_USER;
const sshKey = process.env.SSH_KEY_FILE ? fs.readFileSync(process.env.SSH_KEY_FILE, 'utf8') : null;
fs.mkdirSync(outDir, { recursive: true });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (...args) => console.log(new Date().toISOString(), ...args);
const annotate = (level, message) => console.log(`::${level}::${platform}: ${String(message).replace(/\r?\n/g, ' | ')}`);

const connect = async () => {
  for (let i = 0; i < 90; i += 1) {
    try { return await chromium.connectOverCDP('http://127.0.0.1:9222'); } catch { await sleep(2000); }
  }
  throw new Error('could not reach the app on port 9222');
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

// OS-level capture so the shot carries the real window frame, cropped to the
// window's bounds. Falls back to a page-only capture if the OS refuses.
const captureWindow = async (page, name) => {
  const pagePath = path.join(outDir, `${name}-page.png`);
  await page.screenshot({ path: pagePath });
  const full = path.join(outDir, `.${name}-screen.png`);
  try {
    if (platform === 'macos') {
      execFileSync('screencapture', ['-x', '-o', full]);
    } else {
      const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('${full.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png)`;
      execFileSync('powershell', ['-NoProfile', '-Command', ps]);
    }
    const session = await page.context().newCDPSession(page);
    const { windowId } = await session.send('Browser.getWindowForTarget');
    const { bounds } = await session.send('Browser.getWindowBounds', { windowId });
    const screenWidth = await page.evaluate(() => window.screen.width);
    const meta = await sharp(full).metadata();
    const scale = meta.width / screenWidth;
    const left = Math.max(0, Math.round(bounds.left * scale));
    const top = Math.max(0, Math.round(bounds.top * scale));
    const width = Math.min(meta.width - left, Math.round(bounds.width * scale));
    const height = Math.min(meta.height - top, Math.round(bounds.height * scale));
    log(`screen ${meta.width}x${meta.height} scale ${scale} window`, bounds);
    await sharp(full).extract({ left, top, width, height }).png().toFile(path.join(outDir, `${name}.png`));
    fs.copyFileSync(full, path.join(outDir, `${name}-screen.png`));
  } catch (error) {
    annotate('warning', `OS capture failed for ${name}: ${error.message}`);
  } finally {
    fs.rmSync(full, { force: true });
  }
  log(`captured ${name}`);
};

(async () => {
  const browser = await connect();
  const page = await findMainPage(browser);
  log('main page', page.url());
  await page.waitForLoadState('domcontentloaded');

  const session = await page.context().newCDPSession(page);
  const { windowId } = await session.send('Browser.getWindowForTarget');
  await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  await session.send('Browser.setWindowBounds', { windowId, bounds: { left: 40, top: 40, width: 1440, height: 900 } });

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
  const connectionId = JSON.parse(created.text)?.connection?.id ?? JSON.parse(created.text)?.id;

  // Dashboard
  await page.goto('http://localhost:22457/');
  await sleep(4000);
  await captureWindow(page, 'dashboard');

  // Workspace with a live SSH session
  await page.goto('http://localhost:22457/workspace');
  await sleep(4000);
  const item = page.locator(`li[data-conn-id="${connectionId}"]`).first();
  if (await item.count()) {
    await item.click();
  } else {
    annotate('warning', `connection item ${connectionId} not found in list`);
  }
  await sleep(8000);
  const terminal = page.locator('.xterm').first();
  if (await terminal.count()) {
    await terminal.click();
    const commands = platform === 'macos'
      ? ['clear', 'sw_vers', 'uname -mrs', 'ls -lhG ~', 'df -h / | tail -1']
      : ['cls', '$PSVersionTable.PSVersion', '[System.Environment]::OSVersion.VersionString', 'Get-ChildItem C:\\ | Select-Object -First 8'];
    for (const command of commands) {
      await page.keyboard.type(command, { delay: 15 });
      await page.keyboard.press('Enter');
      await sleep(1200);
    }
  } else {
    annotate('warning', 'no terminal found in workspace');
  }
  await sleep(5000);
  await captureWindow(page, 'workspace');

  // Appearance customizer
  await page.goto('http://localhost:22457/settings');
  await sleep(4000);
  await captureWindow(page, 'settings');

  annotate('notice', 'screenshots captured');
  await browser.close().catch(() => {});
  process.exit(0);
})().catch(error => {
  annotate('error', error.message);
  console.error(error);
  process.exit(1);
});
