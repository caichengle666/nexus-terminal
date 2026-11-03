const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const {
  createMainProcessErrorHandler,
  installRendererRecovery,
  loadUrlSafely,
  isAbortError,
} = require('../window-recovery');

const quietLog = { log() {}, warn() {}, error() {} };

const fakeWindow = (loadImpl) => {
  const webContents = new EventEmitter();
  webContents.reloads = 0;
  webContents.reload = () => { webContents.reloads += 1; };
  const win = {
    webContents,
    loads: [],
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    loadURL(url) { this.loads.push(url); return loadImpl ? loadImpl(url, this.loads.length) : Promise.resolve(); },
  };
  return win;
};

test('loadUrlSafely never rejects: ERR_ABORTED counts as success, other errors retry then show an error page', async () => {
  const aborted = fakeWindow(() => Promise.reject(Object.assign(new Error('ERR_ABORTED (-3) loading'), { errno: -3, code: 'ERR_ABORTED' })));
  assert.equal(await loadUrlSafely(aborted, 'http://127.0.0.1:22457', { log: quietLog }), true);
  assert.equal(aborted.loads.length, 1);

  const flaky = fakeWindow((_url, n) => (n < 3 ? Promise.reject(new Error('ERR_CONNECTION_REFUSED')) : Promise.resolve()));
  assert.equal(await loadUrlSafely(flaky, 'http://127.0.0.1:22457', { log: quietLog, retries: 3, retryDelayMs: 1 }), true);
  assert.equal(flaky.loads.length, 3);

  const dead = fakeWindow((url) => (url.startsWith('data:') ? Promise.resolve() : Promise.reject(new Error('ERR_CONNECTION_REFUSED'))));
  const ok = await loadUrlSafely(dead, 'http://127.0.0.1:22457', {
    log: quietLog, retries: 1, retryDelayMs: 1,
    errorPage: { title: 'T <b>', message: 'M', retryLabel: 'R' },
  });
  assert.equal(ok, false);
  const errorPage = decodeURIComponent(dead.loads.at(-1));
  assert.ok(errorPage.startsWith('data:text/html'));
  assert.ok(errorPage.includes('T &lt;b&gt;'), 'error page text is escaped');
  assert.ok(errorPage.includes('href="http://127.0.0.1:22457"'));
});

test('isAbortError recognises Electron ERR_ABORTED rejections only', () => {
  assert.equal(isAbortError({ errno: -3 }), true);
  assert.equal(isAbortError(new Error('ERR_ABORTED (-3) loading http://x')), true);
  assert.equal(isAbortError(new Error('ERR_CONNECTION_REFUSED')), false);
});

test('renderer crashes reload the window a limited number of times, then ask', async () => {
  const win = fakeWindow();
  let clock = 0;
  let asked = 0;
  installRendererRecovery(win, {
    log: quietLog,
    maxReloads: 2,
    windowMs: 60_000,
    now: () => clock,
    getUrl: () => 'http://127.0.0.1:22457',
    onCrashLoop: () => { asked += 1; return 'ignore'; },
  });
  win.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: -1 });
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(win.loads.length, 2);
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(win.loads.length, 2, 'stops reloading in a crash loop');
  assert.equal(asked, 1);
  clock += 120_000; // outside the window again
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(win.loads.length, 3);
  win.webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(win.loads.length, 3, 'clean exit is not a crash');
});

test('unresponsive renderer prompts once and reloads on request', async () => {
  const win = fakeWindow();
  let prompts = 0;
  installRendererRecovery(win, {
    log: quietLog,
    getUrl: () => null,
    onUnresponsive: async () => { prompts += 1; return 'reload'; },
  });
  win.webContents.emit('unresponsive');
  win.webContents.emit('unresponsive');
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prompts, 1);
  assert.equal(win.webContents.reloads, 1);
});

test('main-process errors are fatal only before startup completes', () => {
  let complete = false;
  let dialogs = 0;
  let quits = 0;
  const handle = createMainProcessErrorHandler({
    log: quietLog,
    isStartupComplete: () => complete,
    showFatalDialog: () => { dialogs += 1; },
    quit: () => { quits += 1; },
  });
  complete = true;
  assert.equal(handle('Unhandled rejection', new Error('ipc handler failed')), 'logged');
  assert.equal(quits, 0);
  assert.equal(dialogs, 0);
  complete = false;
  assert.equal(handle('Uncaught exception', new Error('startup failed')), 'fatal');
  assert.equal(handle('Uncaught exception', new Error('again')), 'fatal');
  assert.equal(dialogs, 1, 'one dialog only');
  assert.equal(quits, 1);
});
