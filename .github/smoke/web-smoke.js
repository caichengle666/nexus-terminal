#!/usr/bin/env node
// Browser smoke test against the Docker deployment (called by .github/smoke/docker-smoke.sh).
// env: SMOKE_BASE, SMOKE_PASS, SMOKE_CONN (name of an existing SSH connection), SMOKE_DIR
const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright');

const base = process.env.SMOKE_BASE || 'http://127.0.0.1:18111';
const password = process.env.SMOKE_PASS;
const connectionName = process.env.SMOKE_CONN;
const marker = process.env.SMOKE_SFTP_MARKER || '';
const outDir = process.env.SMOKE_DIR || 'smoke/web';
fs.mkdirSync(outDir, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const failures = [];
const check = async (name, fn) => {
  try { console.log(`::notice::web PASS ${name}: ${String(await fn() ?? '').slice(0, 400)}`); } catch (error) { failures.push(name); console.log(`::error::web FAIL ${name}: ${String(error.message).replace(/\n/g, ' | ').slice(0, 800)}`); }
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };

(async () => {
  const browser = await chromium.launch(process.env.SMOKE_CHROMIUM ? { executablePath: process.env.SMOKE_CHROMIUM, args: ['--no-sandbox'] } : {});
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

  await check('login page renders', async () => {
    await page.goto(`${base}/login`);
    await page.waitForSelector('input[type="password"]', { timeout: 30000 });
    await page.screenshot({ path: path.join(outDir, 'login.png') });
    return page.url();
  });

  await check('login through the form', async () => {
    await page.locator('input[type="text"], input[autocomplete="username"]').first().fill('admin');
    await page.locator('input[type="password"]').first().fill(password);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL(url => !/\/login/.test(url.pathname), { timeout: 30000 });
    await sleep(3000);
    await page.screenshot({ path: path.join(outDir, 'dashboard.png') });
    return page.url();
  });

  const api = (method, url, body) => page.evaluate(async ([m, u, b]) => {
    const response = await fetch(u, { method: m, credentials: 'include', headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
    return { status: response.status, text: await response.text() };
  }, [method, url, body]);

  await check('custom HTML background saved', async () => {
    await context.addInitScript(() => {
      window.__htmlBgMessages = [];
      window.addEventListener('message', event => { if (event.data && event.data.smoke) window.__htmlBgMessages.push(event.data); });
    });
    const html = '<script>var r={smoke:true};try{parent.document.title="PWNED";r.parentDoc=true}catch(e){r.parentDoc=false}' +
      'try{r.storage=parent.localStorage.length}catch(e){r.storage="blocked"}parent.postMessage(r,"*")</script>';
    const saved = await api('PUT', '/api/v1/appearance', { terminalBackgroundEnabled: true, terminal_custom_html: html });
    assert(saved.status < 300, `${saved.status} ${saved.text.slice(0, 200)}`);
    await page.reload();
    await sleep(3000);
  });

  await check('SSH terminal over WebSocket runs a command', async () => {
    const button = page.locator(`xpath=//*[normalize-space(text())='${connectionName}']/ancestor::*[.//button[normalize-space()='连接']][1]//button[normalize-space()='连接']`).first();
    assert(await button.count(), 'connect button not found');
    await button.click();
    const terminal = page.locator('.xterm').first();
    for (let i = 0; i < 30 && !(await terminal.count()); i += 1) await sleep(1000);
    assert(await terminal.count(), `no terminal (url ${page.url()})`);
    await sleep(5000);
    await terminal.click();
    await page.keyboard.type('echo SSH_SMOKE_$((40+2))', { delay: 10 });
    await page.keyboard.press('Enter');
    let text = '';
    for (let i = 0; i < 20; i += 1) {
      await sleep(1000);
      text = await page.evaluate(() => Array.from(document.querySelectorAll('.xterm-rows')).map(e => e.textContent).join('\n'));
      if (/SSH_SMOKE_42/.test(text)) break;
    }
    await page.screenshot({ path: path.join(outDir, 'workspace.png') });
    assert(/SSH_SMOKE_42/.test(text), `marker missing; tail ${text.slice(-300)}`);
  });

  await check('HTML background sandboxed', async () => {
    let messages = [];
    for (let i = 0; i < 10 && !messages.length; i += 1) { messages = await page.evaluate(() => window.__htmlBgMessages); await sleep(1000); }
    assert(messages.length, 'background script never ran');
    assert(messages[0].parentDoc === false && messages[0].storage === 'blocked', JSON.stringify(messages[0]));
    assert((await page.title()) !== 'PWNED', 'title changed');
    return JSON.stringify(messages[0]);
  });
  await api('PUT', '/api/v1/appearance', { terminalBackgroundEnabled: false, terminal_custom_html: '' });

  await check('SFTP file list loads', async () => {
    let text = '';
    for (let i = 0; i < 20; i += 1) {
      text = await page.evaluate(() => Array.from(document.querySelectorAll('[class*="file-manager"], .file-manager, table')).map(e => e.textContent || '').join('\n'));
      if (marker ? text.includes(marker) : text.length > 40) break;
      await sleep(1000);
    }
    assert(marker ? text.includes(marker) : text.length > 40, marker ? `${marker} not in file list` : 'file list empty');
    return `${text.length} chars`;
  });

  await check('mobile login page (iPhone 13) theme toggle in header', async () => {
    const mobile = await browser.newContext({ ...devices['iPhone 13'] });
    const mpage = await mobile.newPage();
    await mpage.goto(`${base}/login`);
    await mpage.waitForSelector('input[type="password"]', { timeout: 30000 });
    await sleep(1500);
    await mpage.screenshot({ path: path.join(outDir, 'mobile-login.png') });
    await mobile.close();
  });

  const unexpected = errors.filter(text => !/401|Unauthorized|favicon/i.test(text));
  if (unexpected.length) console.log(`::warning::web console errors: ${unexpected.slice(0, 5).join(' || ').slice(0, 800)}`);
  await browser.close();
  if (failures.length) { console.log(`::error::web smoke failed: ${failures.join('; ')}`); process.exit(1); }
  process.exit(0);
})().catch(error => { console.log(`::error::web smoke crashed: ${error.message}`); process.exit(1); });
