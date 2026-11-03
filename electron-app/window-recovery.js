'use strict';

// Main-window resilience helpers:
//  - loadURL failures (ERR_CONNECTION_REFUSED while the frontend server warms up,
//    ERR_ABORTED when a navigation is superseded) must not become unhandled
//    rejections that quit the app.
//  - A crashed renderer (OOM from a huge scrollback, GPU driver reset, ...) used to
//    leave a blank white window. Reload it automatically a few times, then ask.
//  - An unresponsive renderer gets a "wait / reload" prompt instead of nothing.
//  - Unhandled rejections in the main process are logged; only failures before the
//    main window finished starting are fatal (error dialog, then quit).

const ERR_ABORTED = -3;

const isAbortError = (error) => error?.errno === ERR_ABORTED || error?.code === 'ERR_ABORTED'
  || /ERR_ABORTED/.test(String(error?.message || ''));

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Load a URL into a BrowserWindow, retrying transient failures.
 * Never rejects: resolves true on success, false when it finally gave up (the
 * window then shows a small error page with a retry link if `errorPage` is given).
 */
async function loadUrlSafely(win, url, options = {}) {
  const retries = Number.isInteger(options.retries) ? options.retries : 3;
  const retryDelayMs = options.retryDelayMs ?? 1000;
  const log = options.log ?? console;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (!win || win.isDestroyed?.()) return false;
    try {
      await win.loadURL(url);
      return true;
    } catch (error) {
      // A newer navigation replaced this one (redirect, reload, user action): not a failure.
      if (isAbortError(error)) return true;
      log.warn?.(`[Window] loadURL ${url} failed (attempt ${attempt + 1}/${retries + 1}): ${error?.message || error}`);
      if (attempt < retries) await delay(retryDelayMs * (attempt + 1));
    }
  }
  if (options.errorPage && win && !win.isDestroyed?.()) {
    try {
      await win.loadURL(buildErrorPageUrl(options.errorPage, url));
    } catch (error) {
      log.warn?.(`[Window] Failed to show load error page: ${error?.message || error}`);
    }
  }
  return false;
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ch]));

function buildErrorPageUrl({ title, message, retryLabel }, targetUrl) {
  const html = `<!doctype html><html><head><meta charset="UTF-8"><style>
    html,body{height:100%;margin:0}
    body{display:grid;place-items:center;color:#e8edf6;background:#0b1220;font:14px/1.5 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
    .card{max-width:460px;padding:28px 36px;border-radius:16px;background:rgba(18,24,38,.75);border:1px solid rgba(255,255,255,.1);text-align:center}
    h1{font-size:16px;margin:0 0 8px}p{color:#9aa7bd;margin:0 0 16px}
    a{color:#7aa2ff}
  </style></head><body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`
    + `<a href="${escapeHtml(targetUrl)}">${escapeHtml(retryLabel)}</a></div></body></html>`;
  return `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`;
}

/**
 * Attach crash / hang recovery to a window's webContents.
 * Returns a detach function (used by tests).
 */
function installRendererRecovery(win, options = {}) {
  const contents = win.webContents;
  const maxReloads = options.maxReloads ?? 3;
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? console;
  const reloadTimes = [];

  const reload = () => {
    if (win.isDestroyed?.()) return;
    const url = typeof options.getUrl === 'function' ? options.getUrl() : null;
    if (url) {
      void loadUrlSafely(win, url, { log, errorPage: options.errorPage });
    } else {
      try { contents.reload(); } catch (error) { log.warn?.(`[Window] reload failed: ${error?.message || error}`); }
    }
  };

  const onGone = (_event, details = {}) => {
    const reason = details.reason || 'unknown';
    log.error?.(`[Window] Renderer process gone (reason: ${reason}, exitCode: ${details.exitCode ?? 'n/a'})`);
    if (reason === 'clean-exit' || options.isQuitting?.()) return;
    const current = now();
    while (reloadTimes.length > 0 && current - reloadTimes[0] > windowMs) reloadTimes.shift();
    if (reloadTimes.length < maxReloads) {
      reloadTimes.push(current);
      reload();
      return;
    }
    // Crashing in a loop: stop reloading and let the user decide.
    Promise.resolve(options.onCrashLoop?.(reason))
      .then(choice => { if (choice === 'reload') { reloadTimes.length = 0; reload(); } })
      .catch(error => log.warn?.(`[Window] crash dialog failed: ${error?.message || error}`));
  };

  let unresponsivePromptOpen = false;
  const onUnresponsive = () => {
    log.warn?.('[Window] Renderer became unresponsive.');
    if (unresponsivePromptOpen || !options.onUnresponsive) return;
    unresponsivePromptOpen = true;
    Promise.resolve(options.onUnresponsive())
      .then(choice => { if (choice === 'reload') reload(); })
      .catch(error => log.warn?.(`[Window] unresponsive dialog failed: ${error?.message || error}`))
      .finally(() => { unresponsivePromptOpen = false; });
  };
  const onResponsive = () => log.log?.('[Window] Renderer is responsive again.');

  contents.on('render-process-gone', onGone);
  contents.on('unresponsive', onUnresponsive);
  contents.on('responsive', onResponsive);
  return () => {
    contents.removeListener('render-process-gone', onGone);
    contents.removeListener('unresponsive', onUnresponsive);
    contents.removeListener('responsive', onResponsive);
  };
}

/**
 * Main-process uncaughtException / unhandledRejection policy.
 * Before startup completes an error is fatal: show one dialog, then quit.
 * Afterwards: log only (a single failed IPC handler must not close the app).
 */
function createMainProcessErrorHandler(options) {
  const log = options.log ?? console;
  let fatalShown = false;
  return (kind, error) => {
    log.error?.(`[Main] ${kind}:`, error);
    if (options.isStartupComplete()) return 'logged';
    if (fatalShown) return 'fatal';
    fatalShown = true;
    try {
      options.showFatalDialog?.(error);
    } catch (dialogError) {
      log.error?.('[Main] Failed to show fatal error dialog:', dialogError);
    }
    options.quit();
    return 'fatal';
  };
}

module.exports = {
  createMainProcessErrorHandler,
  installRendererRecovery,
  isAbortError,
  loadUrlSafely,
  buildErrorPageUrl,
};
