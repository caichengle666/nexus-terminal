const { app, BrowserWindow, ipcMain, dialog, session, Tray, Menu, nativeImage, shell, screen, net, Notification } = require('electron');
const { captureWindowState, resolveWindowState } = require('./window-state');
const { createTranslator } = require('./main-i18n');
const { HARDWARE_ACCELERATION_MODES, createGpuController, resolveDataDir } = require('./gpu-mode');

const tMain = createTranslator(() => (app.isReady() ? app.getLocale() : ''));
const path = require('path');
const url = require('url');
const express = require('express'); 
const http = require('http'); 
const { spawn } = require('child_process');
const { randomBytes, randomUUID } = require('crypto');
const getBackendNodeModulesPath = () => {
  if (app.isPackaged) return path.join(process.resourcesPath, 'packages', 'backend', 'dist', 'node_modules');
  return path.join(__dirname, '..', 'packages', 'backend', 'node_modules');
};

const resolveBackendProxyModule = (name) => {
  try {
    return require.resolve(name, { paths: [getBackendNodeModulesPath()] });
  } catch {
    return null;
  }
};

const proxyModuleCache = new Map();
const loadBackendProxyAgent = async (name) => {
  if (proxyModuleCache.has(name)) return proxyModuleCache.get(name);
  const entry = resolveBackendProxyModule(name);
  if (!entry) {
    proxyModuleCache.set(name, null);
    return null;
  }
  try {
    const module = await import(url.pathToFileURL(entry).href);
    const agent = module.HttpsProxyAgent || module.SocksProxyAgent || null;
    proxyModuleCache.set(name, agent);
    return agent;
  } catch {
    proxyModuleCache.set(name, null);
    return null;
  }
};
const fs = require('fs');
const os = require('os');
const iconv = require('iconv-lite');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { consumePortableUpdateResult, installPortableUpdate, shouldUsePortableFallback } = require('./updater-service');
const {
  deriveManifestUrls,
  extractExpectedChecksum,
  isUpdatePublicKeyConfigured,
  loadEd25519PublicKey,
  verifyManifestSignature,
  verifyUpdateSignature,
} = require('./update-verification');
const { UPDATE_PUBLIC_KEY_PEM } = require('./update-public-key');
const {
  buildRdpFileContent,
  isAllowedLocalHostHeader,
  isAllowedSubframeNavigation,
  isRendererPermissionAllowed,
  isSafeExternalUrl,
  isTrustedOrigin,
  sanitizeRdpConnection,
  validateOpenPathRequest,
} = require('./security-utils');
const updateNetwork = require('./update-network');
const updateDownloadService = require('./update-download-service');
const { STARTUP_UPDATE_CHECK_DELAY_MS, checkForStartupUpdate } = require('./update-startup-check');

let mainWindow;
let expressApp;
let httpServer;
let backendProcess;
let backendRestartTimer = null;
let frontendUrlForDownloads; // 用于IPC处理器访问前端URL
let actualBackendUrlForFileDownloads; // 新增：用于文件下载的后端URL
let tray = null;
let trayMenu = null;
let appStore = null;
let floatingNotificationBellWindow = null;
let floatingNotificationBellEnabled = true;
let floatingNotificationUnreadCount = 0;
let floatingNotificationBellTheme = {};
let floatingNotificationBellStatus = 'default';
let isQuitting = false;
let isAlwaysOnTop = false;
let previousCpuTimes = null;
const localTerminalSessions = new Map();
const PROD_FRONTEND_PORT = 22457;
const PROD_BACKEND_PORT = 22458;
// Both local servers bind to loopback only; nothing on the LAN may reach them.
const LOCAL_BIND_ADDRESS = '127.0.0.1';
// Per-launch secret shared only between this process and the backend child.
// The local proxy injects it on proxied /api and websocket requests so the
// backend can tell "desktop app on this machine" apart from anything else
// (it replaces the old blind loopback trust for the initial admin setup).
const DESKTOP_PROXY_TOKEN = randomBytes(32).toString('hex');
const DESKTOP_PROXY_TOKEN_HEADER = 'x-nexus-desktop-token';

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  // A second launch just brings the running window to the front.
  app.on('second-instance', (_event, argv = []) => {
    // node-pty (Windows, ConPTY) kills a terminal via child_process.fork(
    // 'conpty_console_list_agent'), which relies on ELECTRON_RUN_AS_NODE. The
    // runAsNode fuse is deliberately kept ON for that reason (turning it off makes
    // every local-terminal close spawn a throwaway app instance + 5 s node-pty
    // timeout). This guard stays in case the fuse is ever turned off.
    if (Array.isArray(argv) && argv.some(arg => /conpty_console_list_agent/i.test(String(arg)))) return;
    showMainWindow();
  });
}

// 硬件加速：默认自动 (GPU 开启)，GPU 崩溃 / 启动未完成 / 白屏时记录回退并以软件渲染重启。
// 某些 Windows 显卡驱动开启 GPU 合成时窗口全白，因此保留回退与手动关闭 (设置、托盘、--disable-gpu、NEXUS_DISABLE_GPU=1)。
const readGpuCompositing = () => {
  try {
    return String(app.getGPUFeatureStatus()?.gpu_compositing || '').startsWith('enabled');
  } catch {
    return false;
  }
};
const relaunchApp = () => {
  isQuitting = true;
  app.relaunch();
  app.quit();
  setTimeout(() => app.exit(0), 8000).unref?.();
};
const gpuMode = hasSingleInstanceLock ? createGpuController({
  app,
  dataDir: resolveDataDir({ exeDir: path.dirname(app.getPath('exe')), defaultUserData: app.getPath('userData') }),
  versions: { appVersion: require('./package.json').releaseVersion || app.getVersion(), electronVersion: process.versions.electron || '' },
  readGpuCompositing,
  onRelaunch: relaunchApp,
  onCompositingChanged: enabled => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('gpu-compositing-changed', { enabled });
  },
}) : null;
app.on('child-process-gone', (_event, details) => gpuMode?.onChildProcessGone(details));

// 用于在 download-file-request 和 will-download 之间传递期望的文件名
const pendingDownloadsInfo = new Map();
let updateDownloadState = null;
let completedUpdatePath = null;
let completedUpdateKind = null;
let completedUpdateSha256 = null;
let completedUpdateManifestSignatureVerified = false;
let updateInstallInProgress = false;
let updateProxyAgent = null;
const isDev = process.argv.includes('--dev'); // 确保 isDev 在此作用域可用
// DevTools only for unpackaged builds. A packaged build started with an explicit
// --remote-debugging-port (README screenshot CI) already grants full CDP access
// to whoever launched it, so keep its targets inspectable there as well.
const isDevToolsAllowed = () => !app.isPackaged || app.commandLine.hasSwitch('remote-debugging-port');

const isUpdaterNetworkError = error => {
  const code = error?.code;
  const message = String(error?.message || error || '').toLowerCase();
  return ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)
    || message.includes('socket hang up')
    || message.includes('更新请求连接中断')
    || message.includes('更新下载连接中断');
};

const reportUpdaterNetworkError = error => {
  if (!isUpdaterNetworkError(error) || !updateDownloadState) return false;
  console.warn(`[Updater] Network connection interrupted: ${error.message || error}`);
  updateDownloadState.cancelled = true;
  updateDownloadState.networkError = true;
  updateDownloadState.request?.destroy();
  updateDownloadState.requests?.forEach(request => request.destroy());
  if (!updateDownloadState.sender.isDestroyed()) {
    updateDownloadState.sender.send('update-progress', {
      status: 'failed',
      requestId: updateDownloadState.requestId || null,
      message: '更新网络连接中断，请检查网络后重试。',
    });
  }
  return true;
};

process.on('uncaughtException', error => {
  if (reportUpdaterNetworkError(error)) return;
  console.error('[Main] Uncaught exception:', error);
  app.quit();
});
process.on('unhandledRejection', error => {
  if (reportUpdaterNetworkError(error)) return;
  console.error('[Main] Unhandled rejection:', error);
  app.quit();
});

const buildUpdateProxyAgent = (proxy) => updateDownloadService.buildProxyAgent(proxy, loadBackendProxyAgent);
const validateUpdateUrl = updateNetwork.validateUpdateUrl;
const cleanupUpdatePartial = updateDownloadService.cleanupPartial;

const getSafeUpdateFilename = parsedUrl => {
  let filename;
  try {
    filename = path.basename(decodeURIComponent(parsedUrl.pathname));
  } catch {
    throw new Error('更新文件名编码无效。');
  }
  const safeFilename = filename.replace(/[<>:"/\\|?*]/g, '_');
  if (!safeFilename || safeFilename === '.' || safeFilename === '..'
    || /[\u0000-\u001f\u007f]/.test(safeFilename) || safeFilename.length > 180) {
    throw new Error('更新文件名无效。');
  }
  return safeFilename;
};

// ---------------------------------------------------------------------------
// Renderer trust boundary
// ---------------------------------------------------------------------------

// The only origin allowed to drive privileged IPC: the bundled frontend served
// on localhost (express in production, Vite in --dev).
const TRUSTED_FRONTEND_ORIGIN = `http://localhost:${PROD_FRONTEND_PORT}`;
const getTrustedFrontendOrigins = () => [TRUSTED_FRONTEND_ORIGIN];
// Content-Security-Policy added to everything the local express server serves.
// Intentionally conservative (no script/style/connect restrictions) so that
// inline styles, user backgrounds, websockets and captcha providers keep working.
const FRONTEND_CSP = "object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
let mainWindowStartupUrl = null;

const getSenderFrameUrl = event => {
  try {
    return event?.senderFrame?.url || null;
  } catch {
    return null;
  }
};

const isTrustedSender = event => {
  if (!event || !event.senderFrame) return false;
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (!event.sender || event.sender.id !== mainWindow.webContents.id) return false;
  return isTrustedOrigin(getSenderFrameUrl(event), getTrustedFrontendOrigins());
};

const assertTrustedSender = event => {
  if (isTrustedSender(event)) return;
  console.warn(`[Security] Rejected IPC from untrusted sender: ${getSenderFrameUrl(event) || 'unknown frame'}`);
  throw new Error('不受信任的 IPC 调用来源。');
};

const isFloatingBellSender = event => Boolean(
  event?.senderFrame
  && floatingNotificationBellWindow
  && !floatingNotificationBellWindow.isDestroyed()
  && event.sender?.id === floatingNotificationBellWindow.webContents.id
  && String(getSenderFrameUrl(event) || '').startsWith('data:text/html'),
);

// ipcMain wrappers that enforce the trusted-sender check before the handler.
const handleTrusted = (channel, handler) => {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event);
    return handler(event, ...args);
  });
};

const onTrusted = (channel, listener) => {
  ipcMain.on(channel, (event, ...args) => {
    if (!isTrustedSender(event)) {
      console.warn(`[Security] Ignored '${channel}' from untrusted sender: ${getSenderFrameUrl(event) || 'unknown frame'}`);
      return;
    }
    listener(event, ...args);
  });
};

const onFromFloatingBell = (channel, listener) => {
  ipcMain.on(channel, (event, ...args) => {
    if (!isFloatingBellSender(event)) {
      console.warn(`[Security] Ignored '${channel}' from non floating-bell sender.`);
      return;
    }
    listener(event, ...args);
  });
};

const openExternalSafely = (targetUrl, reason = 'link') => {
  if (!isSafeExternalUrl(targetUrl)) {
    console.warn(`[Security] Refused to open ${reason} externally: ${String(targetUrl).slice(0, 200)}`);
    return false;
  }
  shell.openExternal(targetUrl).catch(error => console.warn(`[Security] openExternal failed: ${error.message}`));
  return true;
};

// Restricts top-level navigation/redirects of a webContents to `isAllowedUrl`.
// Blocked http(s) navigations are handed to the system browser instead.
const lockDownNavigation = (contents, isAllowedUrl, { onBlocked } = {}) => {
  contents.on('will-navigate', (event, legacyUrl) => {
    const navigationUrl = event?.url || legacyUrl;
    if (isAllowedUrl(navigationUrl)) return;
    event.preventDefault();
    if (onBlocked?.(navigationUrl)) return;
    console.warn(`[Security] Blocked navigation to ${String(navigationUrl).slice(0, 200)}`);
    openExternalSafely(navigationUrl, 'navigation');
  });
  contents.on('will-redirect', (event, legacyUrl) => {
    const redirectUrl = event?.url || legacyUrl;
    if (isAllowedUrl(redirectUrl)) return;
    event.preventDefault();
    console.warn(`[Security] Blocked redirect to ${String(redirectUrl).slice(0, 200)}`);
  });
};

// Applies to every webContents the app ever creates (windows, devtools, …).
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', event => {
    event.preventDefault();
    console.warn('[Security] Blocked <webview> attachment.');
  });
  contents.setWindowOpenHandler(({ url: targetUrl }) => {
    openExternalSafely(targetUrl, 'window.open');
    return { action: 'deny' };
  });
  // Main-frame navigation is handled per window by lockDownNavigation (will-navigate);
  // this guards iframes, which will-navigate does not cover.
  contents.on('will-frame-navigate', event => {
    if (event.isMainFrame) return;
    if (isAllowedSubframeNavigation(event.url, getTrustedFrontendOrigins())) return;
    event.preventDefault();
    console.warn(`[Security] Blocked sub-frame navigation to ${String(event.url).slice(0, 200)}`);
  });
});

// Deny every permission by default; allow only the few the trusted frontend
// actually needs (clipboard for terminal paste, notifications, fullscreen).
// 'openExternal' and everything else is refused.
const installSessionPermissionPolicy = targetSession => {
  if (!targetSession) return;
  targetSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl = details?.requestingUrl || webContents?.getURL?.() || '';
    const allowed = isRendererPermissionAllowed(permission, requestingUrl, getTrustedFrontendOrigins());
    if (!allowed) console.warn(`[Security] Denied permission request '${permission}' from ${String(requestingUrl).slice(0, 200)}`);
    callback(allowed);
  });
  targetSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const requestingUrl = requestingOrigin || details?.requestingUrl || webContents?.getURL?.() || '';
    return isRendererPermissionAllowed(permission, requestingUrl, getTrustedFrontendOrigins());
  });
  targetSession.setDevicePermissionHandler?.(() => false);
};

// No default application menu on Windows/Linux (it exposes DevTools / reload
// accelerators). macOS keeps a minimal menu so Cmd+C/V/X/A/Z and Cmd+Q work.
const installApplicationMenu = () => {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ]));
};

if (isUpdatePublicKeyConfigured(UPDATE_PUBLIC_KEY_PEM)) {
  try {
    loadEd25519PublicKey(UPDATE_PUBLIC_KEY_PEM);
  } catch (error) {
    console.error(`[Updater] UPDATE_PUBLIC_KEY_PEM is invalid, all updates will be refused: ${error.message}`);
  }
} else {
  console.warn('[Updater] UPDATE_PUBLIC_KEY_PEM is not configured: update manifests are NOT signature-verified (SHA-256 only).');
}

// Silent update check once, ~10 s after the frontend is loaded. Only an
// available update is surfaced (native notification); downloading and
// installing stay in Settings > About with checksum/signature verification.
let startupUpdateCheckScheduled = false;
const scheduleStartupUpdateCheck = () => {
  if (startupUpdateCheckScheduled || isDev) return;
  startupUpdateCheckScheduled = true;
  setTimeout(async () => {
    if (isQuitting) return;
    const currentVersion = require('./package.json').releaseVersion || app.getVersion();
    const update = await checkForStartupUpdate({
      fetchImpl: (target, options) => net.fetch(target, options),
      currentVersion,
    });
    if (!update || isQuitting) return;
    console.log(`[Updater] Startup check: ${update.version} is available (current ${currentVersion}).`);
    try {
      if (!Notification.isSupported()) return;
      const notification = new Notification({
        title: tMain('updateAvailableTitle'),
        body: tMain('updateAvailableBody', { version: update.version, current: currentVersion }),
        silent: false,
      });
      notification.on('click', () => showMainWindow());
      notification.show();
    } catch (error) {
      console.warn(`[Updater] Unable to show update notification: ${error.message}`);
    }
  }, STARTUP_UPDATE_CHECK_DELAY_MS).unref?.();
};

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setSkipTaskbar(false);
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function openTaskNotificationCenter() {
  showMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const navigate = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('open-task-notification-center');
    }
  };
  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', navigate);
  } else {
    navigate();
  }
}

const getFloatingNotificationBellBounds = () => {
  const width = 72;
  const height = 82;
  const savedBounds = appStore?.get('floatingNotificationBellBounds');
  if (savedBounds && Number.isFinite(savedBounds.x) && Number.isFinite(savedBounds.y)) {
    const isVisible = screen.getAllDisplays().some(({ workArea }) => (
      savedBounds.x < workArea.x + workArea.width
      && savedBounds.x + width > workArea.x
      && savedBounds.y < workArea.y + workArea.height
      && savedBounds.y + height > workArea.y
    ));
    if (isVisible) return { x: savedBounds.x, y: savedBounds.y, width, height };
  }
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - width - 20,
    y: workArea.y + workArea.height - height - 20,
    width,
    height,
  };
};

const updateFloatingNotificationBell = ({ unreadCount, pulse = false, status } = {}) => {
  if (Number.isFinite(unreadCount)) {
    floatingNotificationUnreadCount = Math.max(0, Math.min(999, Math.trunc(unreadCount)));
  }
  if (['default', 'running', 'success', 'error'].includes(status)) floatingNotificationBellStatus = status;
  if (!floatingNotificationBellWindow || floatingNotificationBellWindow.isDestroyed()) return;
  const payload = JSON.stringify({
    unreadCount: floatingNotificationUnreadCount,
    pulse: Boolean(pulse),
    status: floatingNotificationBellStatus,
    theme: floatingNotificationBellTheme,
  });
  void floatingNotificationBellWindow.webContents.executeJavaScript(`window.updateFloatingBell?.(${payload})`).catch(() => undefined);
};

const updateFloatingNotificationBellTheme = theme => {
  if (!theme || typeof theme !== 'object') return;
  floatingNotificationBellTheme = Object.fromEntries(
    ['background', 'foreground', 'border', 'accent', 'accentHover', 'error'].map(key => [key, typeof theme[key] === 'string' ? theme[key] : '']),
  );
  updateFloatingNotificationBell();
};

function createFloatingNotificationBell() {
  if (!floatingNotificationBellEnabled || floatingNotificationBellWindow) return;
  floatingNotificationBellWindow = new BrowserWindow({
    ...getFloatingNotificationBellBounds(),
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      devTools: isDevToolsAllowed(),
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  floatingNotificationBellWindow.setAlwaysOnTop(true);
  const bellHtml = `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>
    html,body{width:100%;height:100%;margin:0;background:transparent;overflow:hidden;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
    body{display:grid;place-items:center;padding:4px;box-sizing:border-box;-webkit-user-select:none}
    .bell{position:relative;width:64px;height:64px;border:1px solid var(--bell-border,#94a3b8);border-radius:50%;display:grid;place-items:center;color:var(--bell-foreground,#f8fafc);background:var(--bell-background,#171b22);box-shadow:0 6px 18px rgba(0,0,0,.38);cursor:grab;text-decoration:none;box-sizing:border-box;touch-action:none;transition:background .18s ease,border-color .18s ease,box-shadow .18s ease}
    .bell:active{cursor:grabbing}.bell:hover{background:var(--bell-accent,#222833);border-color:var(--bell-accent-hover,#60a5fa)}.bell:focus-visible{outline:2px solid var(--bell-accent-hover,#60a5fa);outline-offset:2px}
    .bell.running{background:#2563eb;border-color:#60a5fa;box-shadow:0 0 0 4px rgba(37,99,235,.24),0 6px 18px rgba(0,0,0,.38)}.bell.success{background:#16a34a;border-color:#4ade80;box-shadow:0 0 0 4px rgba(22,163,74,.24),0 6px 18px rgba(0,0,0,.38)}.bell.error{background:#dc2626;border-color:#f87171;box-shadow:0 0 0 4px rgba(220,38,38,.25),0 6px 18px rgba(0,0,0,.38)}
    .bell svg{width:25px;height:25px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
    .badge{position:absolute;right:-3px;top:-3px;min-width:19px;height:19px;padding:0 5px;border-radius:10px;display:none;align-items:center;justify-content:center;background:var(--bell-error,#dc3545);color:#fff;font-size:11px;font-weight:700;line-height:19px;box-sizing:border-box;border:2px solid var(--bell-background,#171b22)}
    .badge.visible{display:flex}.bell.pulse{animation:pulse .65s ease-out 2}
    @keyframes pulse{0%{transform:scale(1)}45%{transform:scale(1.12);box-shadow:0 0 0 8px rgba(96,165,250,.2),0 6px 18px rgba(0,0,0,.38)}100%{transform:scale(1)}}
  </style></head><body><button class="bell" id="bell" type="button" title="打开任务中心" aria-label="打开任务中心"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 21h3.4"></path><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"></path></svg><span class="badge" id="badge"></span></button><script>
    var api=window.electronAPI;var bell=document.getElementById('bell');var dragState=null;var moved=false;
    function applyTheme(theme){if(!theme)return;var root=document.documentElement;var map={background:'--bell-background',foreground:'--bell-foreground',border:'--bell-border',accent:'--bell-accent',accentHover:'--bell-accent-hover',error:'--bell-error'};Object.keys(map).forEach(function(key){if(theme[key])root.style.setProperty(map[key],theme[key]);});}
    window.updateFloatingBell=function(payload){var count=Math.max(0,Number(payload.unreadCount)||0);var badge=document.getElementById('badge');badge.textContent=count>99?'99+':String(count);badge.classList.toggle('visible',count>0);applyTheme(payload.theme);bell.classList.remove('running','success','error');if(payload.status&&payload.status!=='default')bell.classList.add(payload.status);if(payload.pulse){bell.classList.remove('pulse');void bell.offsetWidth;bell.classList.add('pulse');}};
    bell.addEventListener('pointerdown',function(event){moved=false;dragState={pointerId:event.pointerId,x:event.screenX,y:event.screenY,windowX:screenX,windowY:screenY};bell.setPointerCapture(event.pointerId);});
    bell.addEventListener('pointermove',function(event){if(!dragState||dragState.pointerId!==event.pointerId)return;var dx=event.screenX-dragState.x,dy=event.screenY-dragState.y;if(!moved&&Math.hypot(dx,dy)<4)return;moved=true;api&&api.floatingNotificationBellDrag({x:dragState.windowX+dx,y:dragState.windowY+dy});});
    bell.addEventListener('pointerup',function(event){if(!dragState||dragState.pointerId!==event.pointerId)return;var wasMoved=moved;dragState=null;if(!wasMoved){event.preventDefault();api&&api.floatingNotificationBellClick();}});
    bell.addEventListener('pointercancel',function(){dragState=null;});
  </script></body></html>`;
  // The bell only ever shows its own data: URL; every navigation is refused.
  lockDownNavigation(floatingNotificationBellWindow.webContents, () => false, {
    onBlocked: navigationUrl => {
      if (navigationUrl === 'nexus-terminal://notifications') {
        openTaskNotificationCenter();
        return true;
      }
      return false;
    },
  });
  floatingNotificationBellWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  floatingNotificationBellWindow.webContents.once('did-finish-load', () => {
    updateFloatingNotificationBell({ unreadCount: floatingNotificationUnreadCount });
    floatingNotificationBellWindow?.showInactive();
  });
  floatingNotificationBellWindow.on('moved', () => {
    if (!floatingNotificationBellWindow || floatingNotificationBellWindow.isDestroyed()) return;
    const { x, y } = floatingNotificationBellWindow.getBounds();
    appStore?.set('floatingNotificationBellBounds', { x, y });
  });
  floatingNotificationBellWindow.on('closed', () => {
    floatingNotificationBellWindow = null;
  });
  void floatingNotificationBellWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(bellHtml)}`);
}

function setFloatingNotificationBellEnabled(enabled) {
  floatingNotificationBellEnabled = Boolean(enabled);
  appStore?.set('floatingNotificationBellEnabled', floatingNotificationBellEnabled);
  if (floatingNotificationBellEnabled) {
    createFloatingNotificationBell();
  } else if (floatingNotificationBellWindow && !floatingNotificationBellWindow.isDestroyed()) {
    floatingNotificationBellWindow.destroy();
  }
  return floatingNotificationBellEnabled;
}

function createTray() {
  if (tray) return;

  const trayIconName = process.platform === 'darwin' ? 'icon.png' : 'icon.ico';
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, trayIconName)
    : path.join(__dirname, 'build', trayIconName);
  const trayImage = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  if (trayImage.isEmpty()) {
    console.warn(`[Main Process] Tray icon not found or invalid: ${iconPath}`);
  }
  tray = new Tray(trayImage);
  tray.setToolTip('Nexus Terminal');
  tray.setContextMenu(trayMenu = Menu.buildFromTemplate([
    {
      label: tMain('trayShow'),
      click: showMainWindow,
    },
    ...(gpuMode ? [{
      label: tMain('trayHardwareAcceleration'),
      submenu: HARDWARE_ACCELERATION_MODES.map(mode => ({
        id: `hardware-acceleration-${mode}`,
        label: tMain(`trayHardwareAcceleration_${mode}`),
        type: 'radio',
        checked: gpuMode.savedMode() === mode,
        click: () => {
          try {
            if (gpuMode.setMode(mode).restartRequired) relaunchApp();
          } catch (error) {
            console.warn(`[GPU] ${error.message}`);
          }
        },
      })),
    }] : []),
    {
      label: tMain('trayQuit'),
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
  tray.on('click', showMainWindow);
}

function hideMainWindowToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  createTray();
  mainWindow.setSkipTaskbar(true);
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }
  }, 0);
}

async function createWindow() {
  const appExeDir = path.dirname(app.getPath('exe'));
  const portableMarkerPath = path.join(appExeDir, '.Portable');
  const isPortable = fs.existsSync(portableMarkerPath); // 确定是否为便携模式

  if (isPortable) {
    const portableUserDataPath = path.join(appExeDir, 'userData'); // 定义便携模式下的用户数据路径
    app.setPath('userData', portableUserDataPath);
    console.log(`[Main Process] [Portable Mode Active] '.Portable' file found. Set userData path to: ${portableUserDataPath}`);
    
    // 确保新的 userData 路径存在
    if (!fs.existsSync(portableUserDataPath)) {
      try {
        fs.mkdirSync(portableUserDataPath, { recursive: true });
        console.log(`[Main Process] [Portable Mode Active] Created userData directory: ${portableUserDataPath}`);
      } catch (err) {
        console.error(`[Main Process] [Portable Mode Active] Failed to create userData directory at ${portableUserDataPath}:`, err);
        // 考虑添加更强的错误处理，例如弹窗提示用户
      }
    }
  } else {
    console.log(`[Main Process] '.Portable' file not found at ${portableMarkerPath}. Using default userData path.`);
    // 当 .Portable 文件不存在时，不调用 app.setPath('userData', ...)，Electron 将使用其默认的用户数据路径。
  }

  const Store = (await import('electron-store')).default;
  const store = new Store();
  appStore = store;
  floatingNotificationBellEnabled = store.get('floatingNotificationBellEnabled', true) !== false;

  try {
    const { parse } = require('path-to-regexp');
    console.log('[Direct Test] Attempting to parse a simple path with path-to-regexp...');
    const tokens = parse('/test/:id');
    console.log('[Direct Test] path-to-regexp parse successful, tokens:', JSON.stringify(tokens));
  } catch (e) {
    console.error('[Direct Test] path-to-regexp direct test FAILED:', e);
    app.quit();
    return; 
  }


  // 创建浏览器窗口。
  const defaultBounds = { width: 1200, height: 800 };
  // Restore the last normal bounds only if they are still on a connected
  // display; otherwise center on the primary display.
  const lastWindowState = resolveWindowState(
    store.get('windowBounds', defaultBounds),
    screen.getAllDisplays().map(display => display.workArea),
    screen.getPrimaryDisplay().workArea,
    defaultBounds,
  );

  mainWindow = new BrowserWindow({
    width: lastWindowState.width,
    height: lastWindowState.height,
    x: lastWindowState.x,
    y: lastWindowState.y,
    frame: false,
    show: false, // 创建时不显示窗口
    backgroundColor: '#0b1220',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true, // 启用上下文隔离
      sandbox: true, // preload 只使用 contextBridge/ipcRenderer
      webviewTag: false,
      devTools: isDevToolsAllowed(),
    },
  });
  // Only the startup screen and the trusted local frontend may be shown here.
  lockDownNavigation(mainWindow.webContents, navigationUrl => (
    (mainWindowStartupUrl && navigationUrl === mainWindowStartupUrl)
    || isTrustedOrigin(navigationUrl, getTrustedFrontendOrigins())
  ));
  mainWindow.setAlwaysOnTop(isAlwaysOnTop);
  gpuMode?.attachWindow(mainWindow);
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const hasSelection = Boolean(params.selectionText);
    const isEditable = Boolean(params.isEditable);
    const hasLink = Boolean(params.linkURL);
    if (!hasSelection && !isEditable && !hasLink) return;

    const menuItems = [];
    if (hasSelection) menuItems.push({ role: 'copy' });
    if (isEditable) {
      menuItems.push(
        { role: 'cut' },
        { role: 'paste' },
        { role: 'selectAll' },
      );
    }
    if (hasLink) menuItems.push({ role: 'copyLink' });
    if (menuItems.length > 0 && !mainWindow.isDestroyed()) {
      Menu.buildFromTemplate(menuItems).popup({ window: mainWindow });
    }
  });
  createTray();
  createFloatingNotificationBell();

  // 先显示轻量启动画面，避免在正式页面加载前初始化一整套 Vue 应用。
  // 样式与默认的 Glass Dark 主题一致；不使用 backdrop-filter（背后只有渐变，模糊无意义，且 GPU 关闭时更省）。
  let startupLogo = '';
  try {
    const logoPath = app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(__dirname, 'build', 'icon.png');
    const logoImage = nativeImage.createFromPath(logoPath);
    if (!logoImage.isEmpty()) startupLogo = logoImage.resize({ width: 144, height: 144, quality: 'best' }).toDataURL();
  } catch { /* 没有图标时只显示文字 */ }
  const startupHtml = `<!doctype html><html><head><meta charset="UTF-8"><style>
    html,body{height:100%;margin:0}
    body{display:grid;place-items:center;color:#e8edf6;font:14px/1.4 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background-color: #0b1220; background-image: radial-gradient(1200px 800px at 8% 6%, rgba(56, 116, 255, 0.40), transparent 60%), radial-gradient(900px 700px at 92% 16%, rgba(168, 85, 247, 0.30), transparent 62%), radial-gradient(1000px 800px at 70% 100%, rgba(20, 184, 166, 0.26), transparent 60%), radial-gradient(700px 520px at 16% 94%, rgba(236, 72, 153, 0.16), transparent 65%), linear-gradient(160deg, #0b1220 0%, #0d1526 45%, #0a0f1c 100%);}
    .card{display:grid;justify-items:center;gap:10px;padding:32px 44px 28px;border-radius:20px;background:rgba(18,24,38,.55);border:1px solid rgba(255,255,255,.10);box-shadow:inset 0 1px 0 rgba(255,255,255,.07),0 24px 60px rgba(0,0,0,.35)}
    .logo{width:72px;height:72px;border-radius:18px;box-shadow:0 8px 28px rgba(56,116,255,.35)}
    .name{font-size:16px;font-weight:600;letter-spacing:.02em}
    .status{color:#9aa7bd;font-size:13px}
    .bar{width:160px;height:3px;margin-top:6px;border-radius:3px;background:rgba(255,255,255,.08);overflow:hidden}
    .bar::after{content:"";display:block;width:40%;height:100%;border-radius:3px;background:linear-gradient(90deg,#3874ff,#a855f7);animation:slide 1.2s ease-in-out infinite}
    @keyframes slide{from{transform:translateX(-100%)}to{transform:translateX(250%)}}
  </style></head><body><div class="card">${startupLogo ? `<img class="logo" src="${startupLogo}" alt="">` : ''}<div class="name">Nexus Terminal</div><div class="status">正在启动客户端...</div><div class="bar"></div></div></body></html>`;
  mainWindowStartupUrl = `data:text/html;charset=UTF-8,${encodeURIComponent(startupHtml)}`;
  mainWindow.loadURL(mainWindowStartupUrl).catch((error) => {
    console.warn(`[Startup] Failed to load startup screen: ${error.message}`);
  });
  if (lastWindowState.isMaximized) mainWindow.maximize();
  mainWindow.show();

  let frontendUrl;

  if (isDev) {
    frontendUrl = 'http://localhost:22457';
    frontendUrlForDownloads = frontendUrl;
    actualBackendUrlForFileDownloads = frontendUrl; // 开发模式下，假定Vite代理API请求
    console.log(`[Dev Mode] Loading frontend from: ${frontendUrl}`);
    console.log(`[Dev Mode] actualBackendUrlForFileDownloads set to: ${actualBackendUrlForFileDownloads}`);
    // 开发模式下: 立即加载 URL，不等待任何后端信号
    console.log(`[Dev Mode] Attempting to load URL: ${frontendUrl}`);
    mainWindow.loadURL(frontendUrl);
    // 开发模式下加载URL后立即显示窗口
    mainWindow.show();
    // 如果需要，可以在页面加载完成后再显示，例如监听 'ready-to-show' 事件
    // mainWindow.once('ready-to-show', () => {
    //   mainWindow.show();
    // });
  } else {
    // 生产模式：启动 express 服务器托管前端静态文件并启动后端服务
    const appExeDir = path.dirname(app.getPath('exe'));
    
    // 用于 customDataPathFile 不存在时 (便携版)
    const portableModeDataPath = path.join(appExeDir, 'data', 'backend-data');

    // 用于 customDataPathFile 存在但无效时 (安装版回退)
    const appNameForPath = (app.getName() || 'nexus-terminal')
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/gi, '');
    // 使用真正的 appData (Roaming) 作为安装版回退的基础
    const installerFallbackBaseDir = app.getPath('appData');
    const installerModeFallbackDataPath = path.join(installerFallbackBaseDir, appNameForPath, 'backend-data');

    // custom-data-path.txt 文件的位置
    const baseAppDataDirForConfig = app.getPath('appData'); // C:\Users\YourUser\AppData\Roaming
    const configSubdirName = 'nexus-terminal';
    const actualConfigDirPath = path.join(baseAppDataDirForConfig, configSubdirName);
    const customDataPathFile = path.join(actualConfigDirPath, 'custom-data-path.txt');
    
    let chosenBackendDataPath = '';

    if (isPortable) {
      console.log(`[Main Process] Portable mode active. Backend data path will be: ${portableModeDataPath}`);
      chosenBackendDataPath = portableModeDataPath;
    } else {
      // 非便携模式，执行原有安装版逻辑
      if (fs.existsSync(customDataPathFile)) {
        console.log(`[Main Process] Found custom data path file: ${customDataPathFile}. Assuming installer mode (not portable).`);
        try {
          const rawBuffer = fs.readFileSync(customDataPathFile);
          const customPathFromInstaller = iconv.decode(rawBuffer, 'gbk').trim();
          console.log(`[Main Process] Reading custom data path file: ${customDataPathFile}`);
          console.log(`[Main Process] Raw buffer from file: <${rawBuffer.toString('hex')}>`);
          console.log(`[Main Process] Decoded path (GBK to UTF-8 via iconv-lite): "${customPathFromInstaller}"`);
          
          if (customPathFromInstaller) {
            chosenBackendDataPath = path.join(customPathFromInstaller, 'backend-data');
            console.log(`[Main Process] Using custom data path from configuration (installer): ${chosenBackendDataPath}`);
          } else {
            console.warn(`[Main Process] Custom data path file found, but content is empty. Falling back to installer default path: ${installerModeFallbackDataPath}`);
            chosenBackendDataPath = installerModeFallbackDataPath;
          }
        } catch (err) {
          console.error(`[Main Process] Error reading or processing custom data path file: ${err}. Falling back to installer default path: ${installerModeFallbackDataPath}`);
          chosenBackendDataPath = installerModeFallbackDataPath;
        }
      } else { // customDataPathFile 不存在 (并且非便携模式)
        console.log(`[Main Process] Custom data path file not found (and not in portable mode). Using installer fallback path: ${installerModeFallbackDataPath}`);
        chosenBackendDataPath = installerModeFallbackDataPath;
      }
    }
    
    const backendDataPath = chosenBackendDataPath; // 最终确定的后端数据路径
    console.log(`[Main Process] Final backend data path chosen: ${backendDataPath}`);

    // 确保后端数据目录存在
    if (fs.existsSync(backendDataPath)) {
      console.log(`[Main Process] Backend data directory already exists: ${backendDataPath}`);
    } else {
      console.log(`[Main Process] Backend data directory does not exist, attempting to create: ${backendDataPath}`);
      try {
        fs.mkdirSync(backendDataPath, { recursive: true });
        console.log(`[Main Process] Backend data directory successfully created/ensured: ${backendDataPath}`);
      } catch (err) {
        console.error(`[Main Process] Critical error: Failed to create backend data directory at ${backendDataPath}. Error: ${err}. The application might not function correctly without this directory.`);
        // 根据应用的重要性，这里可能需要更强硬的错误处理，例如通知用户并退出应用。
        // 例如，可以考虑在这里向用户显示一个错误对话框：
        // dialog.showErrorBox(
        //   "数据目录创建失败",
        //   `无法创建数据目录: ${backendDataPath}\n错误: ${err.message}\n应用可能无法正常工作。`
        // );
        // app.quit();
        // return; // 停止执行 createWindow
      }
    }

    // 提醒：后续步骤中，您需要在后端代码 (packages/backend) 中适配，
    // 读取并使用 APP_BACKEND_DATA_PATH 环境变量。
    // 此外，考虑实现一次性的数据迁移逻辑，将旧安装目录下的数据（如果存在）迁移到新的 backendDataPath。
    
    const getNodeJsExecutablePath = () => {
      const basePath = path.join(process.resourcesPath, 'nodejs-runtime');
      let nodeExecutable = 'node'; // Default or fallback

      if (process.platform === 'win32') {
        // Windows: 仅支持 x64
        if (process.arch === 'x64') {
          nodeExecutable = path.join(basePath, 'win-x64', 'node.exe');
        } else {
          // 对于其他 Windows 架构 (arm64, ia32)，不再提供特定路径，将导致错误或回退
          console.warn(`[Main Process] Unsupported Windows architecture: ${process.arch}. Backend might not start.`);
           // 可以选择抛出错误，或者让后续的 existsSync 检查来处理
        }
      } else if (process.platform === 'linux') {
        // Linux: 仅支持 x64
        if (process.arch === 'x64') {
          nodeExecutable = path.join(basePath, 'linux-x64', 'bin', 'node');
        } else {
          console.warn(`[Main Process] Unsupported Linux architecture: ${process.arch}. Backend might not start.`);
        }
      } else if (process.platform === 'darwin') {
        if (process.arch === 'arm64') {
          nodeExecutable = path.join(basePath, 'darwin-arm64', 'node');
        } else if (process.arch === 'x64') {
          nodeExecutable = path.join(basePath, 'darwin-x64', 'node');
        } else {
          console.warn(`[Main Process] Unsupported macOS architecture: ${process.arch}. Backend might not start.`);
        }
      } else {
         console.warn(`[Main Process] Unsupported platform: ${process.platform}. Backend might not start.`);
      }
      
      // 检查可执行文件是否存在，如果不存在则记录错误并可能回退或抛出
      if (!fs.existsSync(nodeExecutable)) {
        throw new Error(`Bundled Node.js executable not found: ${nodeExecutable}`);
      }
      if (process.platform === 'darwin') {
        try {
          fs.chmodSync(nodeExecutable, 0o755);
        } catch (error) {
          console.warn(`[Main Process] Failed to ensure bundled Node.js executable bit: ${error.message}`);
        }
      }
      console.log(`[Main Process] Using bundled Node.js executable: ${nodeExecutable}`);
      return nodeExecutable;
    };

    const backendResourcesPath = path.join(process.resourcesPath, 'packages/backend');
    let nodeExecutablePath;
    try {
      nodeExecutablePath = getNodeJsExecutablePath();
    } catch (error) {
      console.error('[Main Process] Critical error determining Node.js executable path:', error);
      dialog.showErrorBox("Node.js 运行时缺失", `无法找到应用内置 Node.js 运行时，后端服务不能启动。\n\n${error.message}`);
      app.quit();
      return; // 停止执行 createWindow
    }
    
    const backendEntryCandidates = [
      path.join(backendResourcesPath, 'dist', 'index.js'),
      path.join(backendResourcesPath, 'index.js'),
      path.join(backendResourcesPath, 'dist', 'dist', 'index.js'),
    ];
    const backendEntryPath = backendEntryCandidates.find(candidate => fs.existsSync(candidate));
    if (!backendEntryPath) {
      const checkedPaths = backendEntryCandidates.join('\n');
      console.error(`[Main Process] Backend entry not found. Checked:\n${checkedPaths}`);
      dialog.showErrorBox("后端入口缺失", `找不到后端入口文件，应用无法启动。\n\n已检查:\n${checkedPaths}`);
      app.quit();
      return;
    }

    let backendRestartAttempts = 0;
    const maxBackendRestartAttempts = 3;

    const startBackendProcess = (isRestart = false) => new Promise((resolveBackend, rejectBackend) => {
      console.log(`[Prod Mode] ${isRestart ? 'Restarting' : 'Starting'} backend service from ${backendEntryPath} using Node.js at ${nodeExecutablePath}...`);
      const child = spawn(nodeExecutablePath, [backendEntryPath], {
        cwd: path.dirname(backendEntryPath),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          APP_BACKEND_DATA_PATH: backendDataPath,
          PORT: String(PROD_BACKEND_PORT),
          // 仅监听本机回环，局域网无法直接访问后端
          HOST: LOCAL_BIND_ADDRESS,
          BIND_ADDRESS: LOCAL_BIND_ADDRESS,
          // 桌面端用户不便查看后端日志：仅携带本次启动随机令牌 (由本地代理注入) 的请求可免设置令牌创建管理员
          NEXUS_DESKTOP_PROXY_TOKEN: DESKTOP_PROXY_TOKEN,
          SETUP_ALLOW_LOOPBACK_WITHOUT_TOKEN: '',
        },
      });
      backendProcess = child;

      const backendReadyString = "BACKEND_READY_SIGNAL"; // 重要提示: 请确保您的后端服务在就绪时打印此确切字符串!
      let backendLogs = ""; // 用于在超时或错误时记录日志
      const appendBackendLog = (text) => {
        backendLogs = (backendLogs + text).slice(-65536);
      };
      let backendReadyResolved = false;
      let startupFailureHandled = false;
      const readyTimeoutDuration = 60000; // 后端启动超时时间 (毫秒)，例如 60 秒

      console.log(`[Prod Mode] Backend service process initiated (PID: ${child.pid}). Waiting for '${backendReadyString}' signal (max ${readyTimeoutDuration / 1000}s)...`);

      const scheduleRestart = () => {
        if (isQuitting || backendRestartTimer) return;
        backendRestartAttempts += 1;
        if (backendRestartAttempts > maxBackendRestartAttempts) {
          dialog.showErrorBox('后端服务已停止', '后端服务连续重启失败，请重新启动 Nexus Terminal。');
          return;
        }
        const delay = backendRestartAttempts * 1000;
        console.warn(`[Backend Watcher] Backend stopped unexpectedly. Restart attempt ${backendRestartAttempts}/${maxBackendRestartAttempts} in ${delay}ms.`);
        backendRestartTimer = setTimeout(() => {
          backendRestartTimer = null;
          startBackendProcess(true)
            .then(() => {
              backendRestartAttempts = 0;
              console.log('[Backend Watcher] Backend service restarted successfully.');
            })
            .catch(error => {
              console.error('[Backend Watcher] Backend restart failed:', error);
            });
        }, delay);
      };

      const readyTimeout = setTimeout(() => {
        startupFailureHandled = true;
        const timeoutMessage = `[Backend Watcher] Timeout after ${readyTimeoutDuration / 1000}s waiting for backend ready signal ('${backendReadyString}').`;
        console.error(timeoutMessage + ` Review backend logs. Last logs captured by main process:\n${backendLogs}`);
        if (!isRestart) {
          dialog.showErrorBox("后端启动超时", `后端服务在 ${readyTimeoutDuration / 1000} 秒内未能启动。请检查应用日志。\n\n捕获到的日志片段:\n${backendLogs.substring(0, 500)}${backendLogs.length > 500 ? '...' : ''}`);
        }
        rejectBackend(new Error(`Timeout waiting for backend. Last logs: ${backendLogs.substring(0, 200)}...`));
        if (!child.killed) child.kill();
        if (isRestart) scheduleRestart();
      }, readyTimeoutDuration);

      child.stdout.on('data', (data) => {
        const output = data.toString();
        console.log(`[Backend STDOUT]: ${output.trim()}`);
        appendBackendLog(output);
        if (output.includes(backendReadyString)) {
          clearTimeout(readyTimeout);
          backendReadyResolved = true;
          console.log('[Backend Watcher] Backend ready signal received!');
          resolveBackend();
        }
      });

      child.stderr.on('data', (data) => {
        const errorOutput = data.toString();
        console.error(`[Backend STDERR]: ${errorOutput.trim()}`);
        appendBackendLog(`[STDERR] ${errorOutput}`);
      });

      child.on('close', (code) => {
        console.log(`[Backend Process] exited with code ${code}`);
        if (backendProcess === child) backendProcess = null;
        if (isQuitting) {
          return;
        }
        if (backendReadyResolved) {
          scheduleRestart();
          return;
        }
        if (startupFailureHandled) return;
        startupFailureHandled = true;
        clearTimeout(readyTimeout);
        const errorMessage = `后端进程在发出就绪信号前意外退出，退出码: ${code}。`;
        console.error(`[Backend Watcher] ${errorMessage}`);
        appendBackendLog(`\n[SYSTEM] Backend process exited with code ${code}.\n`);
        if (!isRestart) {
          dialog.showErrorBox("后端错误", `${errorMessage}\n\n捕获到的日志片段:\n${backendLogs.substring(0, 500)}${backendLogs.length > 500 ? '...' : ''}`);
        }
        rejectBackend(new Error(errorMessage + ` Last logs: ${backendLogs.substring(0,200)}...`));
        if (isRestart) scheduleRestart();
      });
      
      child.on('error', (err) => {
        if (startupFailureHandled) return;
        startupFailureHandled = true;
        clearTimeout(readyTimeout); // 确保超时被清除
        console.error('[Backend Process] Failed to start:', err);
        if (!isRestart) {
          dialog.showErrorBox("后端启动失败", `启动后端进程失败: ${err.message}`);
        }
        rejectBackend(err);
        if (isRestart) scheduleRestart();
      });
    });

    const backendReadyPromise = startBackendProcess();

    // 启动 express 前端服务器
    expressApp = express();
    // DNS rebinding guard: only answer requests addressed to localhost/127.0.0.1:PORT.
    expressApp.use((req, res, next) => {
      if (!isAllowedLocalHostHeader(req.headers.host, PROD_FRONTEND_PORT)) {
        console.warn(`[Security] Rejected request with unexpected Host header: ${String(req.headers.host).slice(0, 200)}`);
        res.status(403).type('text/plain').send('Forbidden');
        return;
      }
      next();
    });
    expressApp.use((req, res, next) => {
      res.setHeader('Content-Security-Policy', FRONTEND_CSP);
      next();
    });
    // Mark proxied requests as coming from this desktop app (overwrites any client-supplied value).
    expressApp.use((req, _res, next) => {
      req.headers[DESKTOP_PROXY_TOKEN_HEADER] = DESKTOP_PROXY_TOKEN;
      next();
    });
    const backendTarget = `http://127.0.0.1:${PROD_BACKEND_PORT}`;
    const backendProxy = createProxyMiddleware({
      pathFilter: ['/api', '/uploads', '/ws'],
      target: backendTarget,
      ws: true,
      changeOrigin: true,
    });
    expressApp.use(backendProxy);

    // 恢复静态文件服务和 SPA fallback
    const staticPath = path.join(process.resourcesPath, 'packages/frontend/dist'); 
    console.log('[Prod Mode] Calculated staticPath for express.static:', staticPath);
    
    expressApp.use(express.static(staticPath));
    
   
    expressApp.get(/^(?!\/api\/).*$/, (req, res) => {
      res.sendFile(path.join(staticPath, 'index.html'));
    });

    httpServer = http.createServer(expressApp);
    httpServer.on('upgrade', (req, socket, head) => {
      if (!isAllowedLocalHostHeader(req.headers.host, PROD_FRONTEND_PORT)) {
        console.warn(`[Security] Rejected websocket upgrade with unexpected Host header: ${String(req.headers.host).slice(0, 200)}`);
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      req.headers[DESKTOP_PROXY_TOKEN_HEADER] = DESKTOP_PROXY_TOKEN;
      backendProxy.upgrade(req, socket, head);
    });

    const frontendServerReadyPromise = new Promise((resolveFrontend, rejectFrontend) => {
      httpServer.listen(PROD_FRONTEND_PORT, LOCAL_BIND_ADDRESS, () => {
        frontendUrl = `http://localhost:${PROD_FRONTEND_PORT}`;
        frontendUrlForDownloads = frontendUrl;
        actualBackendUrlForFileDownloads = `http://localhost:${PROD_BACKEND_PORT}`; // 生产模式下，直接指向后端服务
        console.log(`[Prod Mode] Frontend server started at ${frontendUrl}, serving from ${staticPath}`);
        console.log(`[Prod Mode] actualBackendUrlForFileDownloads set to: ${actualBackendUrlForFileDownloads}`);
        resolveFrontend();
      }).on('error', (err) => {
        console.error('Failed to start frontend server:', err);
        dialog.showErrorBox("前端服务器错误", `启动前端服务器失败: ${err.message}`);
        rejectFrontend(err);
        app.quit();
      });
    });

    // 等待后端和前端服务器都准备就绪
    try {
      console.log('[Main Process] Waiting for backend and frontend server to be ready...');
      await Promise.all([backendReadyPromise, frontendServerReadyPromise]);
      console.log('[Main Process] Backend and frontend server are ready. Proceeding to load URL.');
      // 生产模式下: 确保 frontendUrl 在服务就绪后已设置，然后加载
      if (!frontendUrl) {
        console.error("[Prod Mode] Critical: Frontend URL was not set even after services supposedly started. Quitting.");
        dialog.showErrorBox("应用启动关键错误", "前端URL未能设置，应用无法继续。");
        app.quit();
        return; // 确保在 createWindow 内部返回，避免进一步执行
      }
      console.log(`[Prod Mode] Attempting to load URL: ${frontendUrl}`);
      mainWindow.loadURL(frontendUrl);
      mainWindow.show();
      mainWindow.focus();
      scheduleStartupUpdateCheck();
    } catch (error) {
      console.error('[Main Process] Error waiting for services to start:', error);
      dialog.showErrorBox("应用启动错误", `一个或多个服务启动失败: ${error.message}。请检查日志获取详细信息。`);
      app.quit();
      return; // 停止 createWindow 的执行
    }
  }


  // 文件下载处理
  mainWindow.webContents.session.on('will-download', (event, item, webContents) => {
    const fileURL = item.getURL(); // 应该是绝对 URL 了
    const originalItemFilename = item.getFilename();
    console.log(`[Main Process] 'will-download' event triggered. URL: ${fileURL}, Original Item Filename: ${originalItemFilename}`);

    // 移除 hasItemCompletedProcessing 标志位
    // 不再调用 event.preventDefault()，让 Electron 处理默认流程，我们仅定制对话框

    const downloadInfo = pendingDownloadsInfo.get(fileURL);
    if (downloadInfo) {
        console.log(`[Main Process] Found pending download info for ${fileURL}:`, downloadInfo);
        pendingDownloadsInfo.delete(fileURL); // 用后清理
    } else {
        console.warn(`[Main Process] No pending download info for ${fileURL}. This might happen if download wasn't initiated via IPC or map cleanup failed.`);
    }

    const filenameFromIPC = downloadInfo?.filename;
    const sanitizeFilename = (name) => {
        if (!name || typeof name !== 'string') return 'download';
        return name.replace(/[<>:"/\\|?*]/g, '_').trim() || 'download';
    };

    let finalSuggestedName = sanitizeFilename(originalItemFilename);
    if (filenameFromIPC && filenameFromIPC.toLowerCase() !== 'download' && filenameFromIPC.trim() !== '') {
        const sanitizedIPCName = sanitizeFilename(filenameFromIPC);
        if (sanitizedIPCName !== 'download') {
            finalSuggestedName = sanitizedIPCName;
            console.log(`[Main Process] Using filename from IPC for save dialog: ${finalSuggestedName}`);
        } else {
            console.log(`[Main Process] IPC filename '${filenameFromIPC}' sanitized to 'download', using item's filename: ${finalSuggestedName}`);
        }
    } else {
         console.log(`[Main Process] No valid/preferred IPC filename, or IPC filename was 'download'. Using item's filename sanitized: ${finalSuggestedName}`);
    }

    // 设置 Electron 原生保存对话框的选项
    item.setSaveDialogOptions({
        title: '保存文件',
        defaultPath: finalSuggestedName,
        buttonLabel: '保存',
        // 可根据需要添加 filters 等其他 SaveDialogOptions
    });
    console.log(`[Main Process] Set save dialog options for ${finalSuggestedName}. Electron will now show the dialog.`);

    // 仍然监听 updated 和 done 事件以跟踪进度和结果
    item.on('updated', (evt, state) => {
        const receivedBytes = item.getReceivedBytes();
        const totalBytes = item.getTotalBytes();
        const currentSavePath = item.getSavePath(); // Electron 会在用户选择后设置此路径
        console.log(`[Main Process] Item Updated. State: ${state}, Received: ${receivedBytes}/${totalBytes}. Item Filename: ${item.getFilename()}, Save Path: ${currentSavePath || 'Not set by Electron yet'}`);
        if (state === 'progressing' && currentSavePath && totalBytes > 0) {
            const progress = Math.round((receivedBytes / totalBytes) * 100);
            if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send('download-progress', {
                    filename: path.basename(currentSavePath),
                    savePath: currentSavePath,
                    receivedBytes,
                    totalBytes,
                    progress,
                    url: fileURL
                });
            }
        }
    });

    item.once('done', (evt, state) => {
        const savedPath = item.getSavePath(); // 这是最终的保存路径
        console.log(`[Main Process] Item Done. State: ${state}. Item Filename: ${item.getFilename()}, Final Saved Path: ${savedPath || 'Not saved or path unavailable'}.`);
        
        const resultFilename = savedPath ? path.basename(savedPath) : finalSuggestedName; // 使用实际保存的文件名或建议名

        if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            if (state === 'completed') {
                console.log(`[Main Process] Download COMPLETED: ${resultFilename} at ${savedPath}`);
                mainWindow.webContents.send('download-reply', {
                    type: 'completed',
                    filename: resultFilename,
                    path: savedPath,
                    url: fileURL
                });
            } else if (state === 'cancelled') {
                console.log(`[Main Process] Download CANCELLED for ${resultFilename}. URL: ${fileURL}`);
                mainWindow.webContents.send('download-reply', {
                    type: 'cancelled',
                    filename: resultFilename,
                    url: fileURL
                });
            } else { // interrupted, failed, etc.
                console.error(`[Main Process] Download FAILED for ${resultFilename}. State: ${state}. URL: ${fileURL}.`);
                mainWindow.webContents.send('download-reply', {
                    type: 'failed',
                    filename: resultFilename,
                    error: `Download failed with state: ${state}.`,
                    url: fileURL
                });
            }
        }
    });
    // 移除了手动的 dialog.showSaveDialog() 及其 .then() 和 .catch() 块
    // Electron 现在会处理对话框的显示和 item.setSavePath() 的调用
  });

  // 保存窗口状态（未最大化时的位置大小 + 是否最大化）
  mainWindow.on('close', (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      store.set('windowBounds', captureWindowState(mainWindow));
    }
    if (!isQuitting) {
      event.preventDefault();
      hideMainWindowToTray();
    }
  });

  // Minimize is a normal taskbar minimize (there is no "minimize to tray"
  // setting); closing the window still hides it to the tray.

  // 打开开发者工具。
  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  // 当 window 被关闭，这个事件会被触发。
  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

// Electron 会在初始化后并准备
// 创建浏览器窗口时，调用这个函数。
// 部分 API 在 ready 事件触发后才能使用。
app.on('ready', () => {
  if (!hasSingleInstanceLock) return;
  installSessionPermissionPolicy(session.defaultSession);
  installApplicationMenu();
  // Same id as the NSIS shortcut (build.appId) so Windows toasts (startup update
  // notification) are attributed to the app, including the portable build.
  if (process.platform === 'win32') app.setAppUserModelId('com.caichengle666.nexus-terminal');
  createWindow().catch(err => {
    console.error('Error during createWindow:', err);
    // 发生严重错误，可能需要退出应用
    app.quit();
  });
  const updaterDir = path.join(app.getPath('temp'), 'nexus-terminal-updater');
  const portableUpdateResult = consumePortableUpdateResult(updaterDir);
  if (portableUpdateResult?.status === 'rolled-back' || portableUpdateResult?.status === 'failed') {
    setTimeout(() => {
      const options = {
        type: 'error',
        title: 'Nexus Terminal 更新未完成',
        message: portableUpdateResult.status === 'rolled-back' ? '新版本安装失败，已恢复旧版本。' : '新版本安装失败，且自动恢复未完成。',
        detail: portableUpdateResult.message || '请重新下载更新或手动安装。',
        buttons: ['确定'],
      };
      const resultDialog = mainWindow
        ? dialog.showMessageBox(mainWindow, options)
        : dialog.showMessageBox(options);
      resultDialog.catch(error => console.error('[Updater] Failed to show portable update result:', error));
    }, 1000);
  }
});

// 当全部窗口关闭时退出。
app.on('window-all-closed', function () {
  // 在 macOS 上，除非用户用 Cmd + Q 确定地退出，
  // 否则绝大部分应用及其菜单栏会保持激活。
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 在应用退出前关闭 express 服务器 (如果已启动)
app.on('before-quit', () => {
  isQuitting = true;
  gpuMode?.beforeQuit();
  console.log('Application is quitting...');
  for (const { terminal } of localTerminalSessions.values()) {
    try {
      terminal.kill();
    } catch (error) {
      console.warn('Failed to close local terminal:', error);
    }
  }
  localTerminalSessions.clear();
  if (backendRestartTimer) {
    clearTimeout(backendRestartTimer);
    backendRestartTimer = null;
  }
  // 1. 关闭前端 HTTP 服务器
  if (httpServer) {
    console.log('Closing frontend server...');
    httpServer.close(() => {
      console.log('Frontend server closed.');
    });
  }
  // 2. 关闭后端子进程
  if (backendProcess) {
    console.log('Stopping backend process...');
    backendProcess.kill('SIGINT'); // 发送 SIGINT 信号，给后端一个优雅关闭的机会
    // 可以设置一个超时，如果后端没有在规定时间内退出，则强制kill
    setTimeout(() => {
        if (backendProcess && !backendProcess.killed) {
            console.warn('Backend process did not exit gracefully, forcing kill.');
            backendProcess.kill('SIGKILL');
        }
    }, 5000); // 5秒超时
  }
});

app.on('activate', function () {
  // 在macOS上，当单击dock图标并且没有其他窗口打开时，
  // 通常在应用程序中重新创建一个窗口。
  if (mainWindow === null) {
    createWindow();
  }
});



// 预留 IPC 通信示例
onTrusted('toMain', (event, args) => {
  console.log('Message from renderer:', args);
  // mainWindow.webContents.send('fromMain', { message: 'Hello from main process!' });
});

// IPC handlers for window controls
onTrusted('minimize-window', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.minimize();
  }
});

handleTrusted('get-app-version', () => require('./package.json').releaseVersion || app.getVersion());
handleTrusted('get-platform', () => process.platform);
// 渲染进程据此决定毛玻璃是否走 lite 渲染 (无 GPU 合成时 backdrop-filter 软件渲染很慢)。调用时读取，反映当前实际状态。
handleTrusted('get-gpu-compositing', () => readGpuCompositing());
handleTrusted('get-gpu-settings', () => gpuMode?.getStatus() ?? null);
handleTrusted('set-gpu-settings', (_event, payload) => {
  const mode = payload && typeof payload === 'object' ? payload.hardwareAcceleration : undefined;
  if (!HARDWARE_ACCELERATION_MODES.includes(mode) || !gpuMode) throw new Error('Invalid hardwareAcceleration value.');
  const status = gpuMode.setMode(mode);
  const trayItem = trayMenu?.getMenuItemById(`hardware-acceleration-${mode}`);
  if (trayItem && tray && !tray.isDestroyed()) {
    trayItem.checked = true;
    tray.setContextMenu(trayMenu);
  }
  return status;
});
handleTrusted('relaunch-app', () => {
  setTimeout(relaunchApp, 100);
  return true;
});
onTrusted('app-rendered', event => {
  if (mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents) gpuMode?.onRendered(mainWindow);
});
handleTrusted('get-architecture', () => process.arch);
const getInstallationKind = () => {
  if (process.platform !== 'win32') return 'system';
  const markerPath = path.join(path.dirname(app.getPath('exe')), '.Portable');
  return fs.existsSync(markerPath) ? 'portable' : 'system';
};
handleTrusted('get-installation-kind', () => getInstallationKind());

// The renderer (Chromium) checks for updates through the system proxy, but the
// main-process downloader uses Node's https, which ignores it. Without this the
// check succeeded while every download timed out for users who only reach
// GitHub through a system proxy (Clash/V2Ray "set system proxy", PAC, ...).
const resolveSystemUpdateProxy = async targetUrl => {
  try {
    const rule = await session.defaultSession.resolveProxy(targetUrl);
    return updateNetwork.parseSystemProxyRule(rule);
  } catch (error) {
    console.warn(`[Updater] Unable to resolve system proxy: ${error.message}`);
    return null;
  }
};

handleTrusted('download-update', async (event, payload = {}) => {
  if (updateDownloadState) return { ok: false, message: '已有更新正在下载。' };
  if (!payload.url || typeof payload.url !== 'string') return { ok: false, message: '更新下载地址无效。' };
  if (!payload.checksumUrl || typeof payload.checksumUrl !== 'string') {
    return { ok: false, message: '此版本缺少官方 SHA-256 校验文件，已拒绝自动更新。' };
  }

  let parsedUrl;
  try {
    parsedUrl = validateUpdateUrl(payload.url);
  } catch (error) {
    return { ok: false, message: error.message };
  }
  let manifestUrls;
  try {
    manifestUrls = deriveManifestUrls(payload.checksumUrl);
    validateUpdateUrl(manifestUrls.manifestUrl);
  } catch {
    return { ok: false, message: '更新校验文件地址无效。' };
  }
  const requireManifestSignature = isUpdatePublicKeyConfigured(UPDATE_PUBLIC_KEY_PEM);

  let safeFilename;
  try {
    safeFilename = getSafeUpdateFilename(parsedUrl);
  } catch (error) {
    return { ok: false, message: error.message };
  }
  // A ZIP is the portable build: it may only replace a portable copy (which has
  // the .Portable marker). Never extract it over / next to an installed copy.
  const isZipUpdate = /\.zip$/i.test(safeFilename);
  if (isZipUpdate && (process.platform !== 'win32' || getInstallationKind() !== 'portable')) {
    return { ok: false, message: '便携版更新包只能用于便携版，请下载安装包进行更新。' };
  }
  const updaterDir = path.join(app.getPath('temp'), 'nexus-terminal-updater');
  const targetPath = path.join(updaterDir, safeFilename);
  try {
    fs.mkdirSync(updaterDir, { recursive: true });
  } catch (error) {
    return { ok: false, message: `无法准备更新目录：${error.message}` };
  }
  updateDownloadState = {
    request: null,
    file: null,
    requests: [],
    cancelled: false,
    sender: event.sender,
    requestId: typeof payload.requestId === 'string' ? payload.requestId : null,
    completionPromise: null,
  };
  updateDownloadState.completionPromise = new Promise(resolve => { updateDownloadState.completionResolve = resolve; });
  completedUpdatePath = null;
  completedUpdateKind = null;
  completedUpdateSha256 = null;
  completedUpdateManifestSignatureVerified = false;
  if (isZipUpdate) completedUpdateKind = 'portable';
  try {
    const explicitProxy = payload.proxy && payload.proxy.host && payload.proxy.port ? payload.proxy : null;
    const proxy = explicitProxy || await resolveSystemUpdateProxy(payload.url);
    updateProxyAgent = await buildUpdateProxyAgent(proxy);
    if (proxy) {
      console.log(`[Updater] Using ${explicitProxy ? 'selected' : 'system'} ${proxy.type} proxy ${proxy.host}:${proxy.port}${updateProxyAgent ? '' : ' (proxy agent unavailable, connecting directly)'}`);
    }
  } catch (error) {
    updateDownloadState?.completionResolve?.();
    updateDownloadState = null;
    updateProxyAgent = null;
    return { ok: false, message: `无法准备更新网络：${error.message}` };
  }
  const sendProgress = (status, extra = {}) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send('update-progress', { status, requestId: updateDownloadState?.requestId || null, ...extra });
    }
  };
  let fallbackPath = null;

  try {
    const downloadContext = {
      agent: updateProxyAgent,
      isCancelled: () => updateDownloadState?.cancelled,
      onStage: (stage, extra = {}) => sendProgress(stage, extra),
      registerRequest: request => updateDownloadState?.requests.push(request),
      unregisterRequest: request => {
        if (updateDownloadState) updateDownloadState.requests = updateDownloadState.requests.filter(item => item !== request);
      },
      registerFile: file => { if (updateDownloadState) updateDownloadState.file = file; },
      abortRequests: () => {
        updateDownloadState?.requests?.forEach(request => request.destroy());
      },
    };
    sendProgress('downloading', { receivedBytes: 0, totalBytes: 0, progress: 0 });
    let result;
    let updatePath = targetPath;
    let fallbackUsed = false;
    sendProgress('fetching-checksum', { message: '正在从官方源获取校验文件…' });
    const checksumText = await updateDownloadService.fetchTextAsset(manifestUrls.manifestUrl, downloadContext, {
      allowMirrors: false,
      mirrorUrls: [],
    });
    if (updateDownloadState.cancelled) throw new Error('更新下载已取消。');
    // Authenticity: the SHA-256 manifest must carry a valid Ed25519 signature
    // from the maintainer key once one is configured (update-public-key.js).
    let manifestSignatureVerified = false;
    if (requireManifestSignature) {
      sendProgress('fetching-checksum', { message: '正在验证校验文件签名…' });
      let signatureText;
      try {
        signatureText = await updateDownloadService.fetchTextAsset(manifestUrls.signatureUrl, downloadContext, {
          allowMirrors: false,
          mirrorUrls: [],
        });
      } catch (error) {
        if (updateDownloadState.cancelled) throw error;
        throw new Error(`此版本缺少校验文件签名，已拒绝自动更新：${error.message}`);
      }
      if (updateDownloadState.cancelled) throw new Error('更新下载已取消。');
      if (!verifyManifestSignature(checksumText, signatureText, UPDATE_PUBLIC_KEY_PEM)) {
        throw new Error('更新校验文件签名无效，已拒绝自动更新。');
      }
      manifestSignatureVerified = true;
    } else {
      console.warn('[Updater] No update public key configured; checksum manifest authenticity is NOT verified.');
    }
    const getExpectedChecksum = filePath => checksumText
      ? extractExpectedChecksum(checksumText, path.basename(filePath))
      : null;
    const expectedPrimaryChecksum = getExpectedChecksum(targetPath);
    if (!expectedPrimaryChecksum) {
      throw new Error(`官方校验文件中没有找到 ${path.basename(targetPath)} 的 SHA-256。`);
    }
    try {
      result = await updateDownloadService.downloadAsset(payload.url, targetPath, downloadContext, (receivedBytes, totalBytes) => {
        sendProgress('downloading', {
          receivedBytes,
          totalBytes,
          progress: totalBytes > 0 ? Math.floor((receivedBytes / totalBytes) * 100) : null,
        });
      }, { allowMirrors: Boolean(expectedPrimaryChecksum), mirrorUrls: payload.mirrorUrls });
    } catch (primaryError) {
      if (updateDownloadState.cancelled || !shouldUsePortableFallback({
        platform: process.platform,
        installationKind: getInstallationKind(),
        primaryFilename: safeFilename,
        fallbackUrl: payload.fallbackUrl,
      })) {
        throw primaryError;
      }
      sendProgress('trying-fallback', { message: '安装包下载失败，正在尝试便携版…' });
      const fallbackUrl = validateUpdateUrl(payload.fallbackUrl);
      fallbackPath = path.join(updaterDir, getSafeUpdateFilename(fallbackUrl));
      const expectedFallbackChecksum = getExpectedChecksum(fallbackPath);
      if (!expectedFallbackChecksum) {
        throw new Error(`官方校验文件中没有找到 ${path.basename(fallbackPath)} 的 SHA-256。`);
      }
      sendProgress('downloading', { receivedBytes: 0, totalBytes: 0, progress: 0, fallback: true });
      result = await updateDownloadService.downloadAsset(payload.fallbackUrl, fallbackPath, downloadContext, (receivedBytes, totalBytes) => {
        sendProgress('downloading', {
          receivedBytes,
          totalBytes,
          progress: totalBytes > 0 ? Math.floor((receivedBytes / totalBytes) * 100) : null,
          fallback: true,
        });
      }, { allowMirrors: Boolean(expectedFallbackChecksum), mirrorUrls: payload.mirrorUrls });
      updatePath = fallbackPath;
      fallbackUsed = true;
      completedUpdateKind = 'portable';
      console.warn(`[Updater] Installer download failed, portable ZIP fallback selected: ${primaryError.message}`);
    }
    if (updateDownloadState.cancelled) throw new Error('更新下载已取消。');

    const expectedChecksum = getExpectedChecksum(updatePath);
    if (!expectedChecksum) {
      throw new Error(`校验文件中没有找到 ${path.basename(updatePath)} 的 SHA-256。`);
    }
    if (expectedChecksum && expectedChecksum !== result.sha256.toLowerCase()) {
      throw new Error('更新文件 SHA-256 校验失败。');
    }
    const checksumVerified = Boolean(expectedChecksum);

    sendProgress('verifying', { message: '下载完成，正在校验安装包…', sha256: result.sha256, checksumVerified, fallback: fallbackUsed });
    const signature = await verifyUpdateSignature(updatePath);
    if (signature.status === 'invalid') {
      fs.rmSync(updatePath, { force: true });
      throw new Error(`安装包签名无效：${signature.detail}`);
    }
    completedUpdatePath = updatePath;
    completedUpdateSha256 = result.sha256.toLowerCase();
    completedUpdateManifestSignatureVerified = manifestSignatureVerified;
    if (fallbackUsed && process.platform === 'win32') {
      const folderError = await shell.openPath(path.dirname(updatePath));
      if (folderError) console.warn(`[Updater] 无法打开便携版下载目录：${folderError}`);
    }
    sendProgress('ready', { sha256: result.sha256, checksumVerified, manifestSignatureVerified, signature: signature.status, fallback: fallbackUsed });
    return { ok: true, path: updatePath, sha256: result.sha256, checksumVerified, manifestSignatureVerified, signature: signature.status, fallback: fallbackUsed };
  } catch (error) {
    if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { force: true });
    const shouldDiscardPartial = updateDownloadState.cancelled && !updateDownloadState.networkError;
    if (shouldDiscardPartial) {
      cleanupUpdatePartial(targetPath);
      if (fallbackPath && fallbackPath !== targetPath) cleanupUpdatePartial(fallbackPath);
    } else if (fallbackPath && fallbackPath !== targetPath && fs.existsSync(fallbackPath)) {
      fs.rmSync(fallbackPath, { force: true });
    }
    sendProgress(updateDownloadState.networkError ? 'failed' : (updateDownloadState.cancelled ? 'cancelled' : 'failed'), { message: error.message || '更新下载失败。' });
    return { ok: false, message: error.message };
  } finally {
    updateDownloadState?.completionResolve?.();
    updateDownloadState = null;
    updateProxyAgent = null;
  }
});

handleTrusted('cancel-update', async () => {
  if (!updateDownloadState) return { ok: false, message: '没有正在进行的更新下载。' };
  const state = updateDownloadState;
  updateDownloadState.cancelled = true;
  updateDownloadState.request?.destroy();
  updateDownloadState.file?.destroy();
  updateDownloadState.requests?.forEach(request => request.destroy());
  await Promise.race([
    state.completionPromise,
    new Promise(resolve => setTimeout(resolve, 5000)),
  ]);
  return { ok: true };
});

handleTrusted('install-update', async () => {
  if (updateInstallInProgress) {
    return { ok: false, message: '更新正在准备安装。' };
  }
  if (!completedUpdatePath || !fs.existsSync(completedUpdatePath)) {
    return { ok: false, message: '没有可安装的更新文件。' };
  }
  if (isUpdatePublicKeyConfigured(UPDATE_PUBLIC_KEY_PEM) && !completedUpdateManifestSignatureVerified) {
    return { ok: false, message: '更新文件未通过签名校验，已拒绝安装。' };
  }
  updateInstallInProgress = true;
  try {
    const updatePath = completedUpdatePath;
    const expectedSha256 = completedUpdateSha256;
    const actualSha256 = await updateDownloadService.hashFile(updatePath);
    if (!expectedSha256 || actualSha256.toLowerCase() !== expectedSha256) {
      fs.rmSync(updatePath, { force: true });
      completedUpdatePath = null;
      completedUpdateKind = null;
      completedUpdateSha256 = null;
      return { ok: false, message: '更新文件在安装前发生变化，已取消安装。' };
    }
    const signature = await verifyUpdateSignature(updatePath);
    if (signature.status === 'invalid') {
      fs.rmSync(updatePath, { force: true });
      completedUpdatePath = null;
      completedUpdateKind = null;
      completedUpdateSha256 = null;
      return { ok: false, message: `安装包签名无效：${signature.detail}` };
    }
    const isPortable = completedUpdateKind === 'portable' || /\.zip$/i.test(updatePath);
    if (isPortable && (process.platform !== 'win32' || getInstallationKind() !== 'portable')) {
      return { ok: false, message: '便携版更新包只能用于便携版，请下载安装包进行更新。' };
    }
    const isDiskImage = /\.dmg$/i.test(updatePath);
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: tMain('updateTitle'),
      message: tMain('updateMessage', { file: path.basename(updatePath) }),
      detail: isPortable ? tMain('updateDetailPortable') : tMain(isDiskImage ? 'updateDetailDmg' : 'updateDetailInstaller'),
      buttons: [isPortable ? tMain('updateButtonPortable') : tMain(isDiskImage ? 'updateButtonDmg' : 'updateButtonInstaller'), tMain('cancel')],
      defaultId: 0,
      cancelId: 1,
    });
    if (confirmation.response !== 0) return { ok: false, cancelled: true, message: tMain('updateCancelled') };
    if (isPortable && process.platform === 'win32') {
      // getInstallationKind() === 'portable' was checked above, so the marker exists here.
      const targetDirectory = path.dirname(app.getPath('exe'));
      const result = await installPortableUpdate({
        archivePath: updatePath,
        updaterDir: path.dirname(updatePath),
        targetDirectory,
        currentProcessId: process.pid,
      });
      if (!result.ok) return result;
      completedUpdatePath = null;
      completedUpdateKind = null;
      completedUpdateSha256 = null;
      setTimeout(() => app.quit(), 150);
      return result;
    }
    if (process.platform === 'linux') {
      try { fs.chmodSync(updatePath, 0o755); } catch { /* shell.openPath will report failures */ }
    }
    const error = await shell.openPath(updatePath);
    if (error) return { ok: false, message: error };
    completedUpdatePath = null;
    completedUpdateKind = null;
    completedUpdateSha256 = null;
    setTimeout(() => app.quit(), 150);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '打开更新程序失败。' };
  } finally {
    updateInstallInProgress = false;
  }
});

handleTrusted('get-floating-notification-bell-settings', () => ({ enabled: floatingNotificationBellEnabled }));
handleTrusted('set-floating-notification-bell-enabled', (_event, enabled) => ({
  ok: true,
  enabled: setFloatingNotificationBellEnabled(enabled),
}));
onTrusted('update-floating-notification-bell', (_event, payload = {}) => {
  updateFloatingNotificationBell(payload);
});
onFromFloatingBell('floating-notification-bell-drag', (event, payload = {}) => {
  if (!floatingNotificationBellWindow || event.sender !== floatingNotificationBellWindow.webContents) return;
  if (!Number.isFinite(payload.x) || !Number.isFinite(payload.y)) return;
  floatingNotificationBellWindow.setPosition(Math.round(payload.x), Math.round(payload.y));
});
onFromFloatingBell('floating-notification-bell-click', event => {
  if (floatingNotificationBellWindow && event.sender === floatingNotificationBellWindow.webContents) openTaskNotificationCenter();
});
onTrusted('update-floating-notification-bell-theme', (_event, theme) => {
  updateFloatingNotificationBellTheme(theme);
});

handleTrusted('open-external', async (_event, url) => {
  if (!isSafeExternalUrl(url)) return { ok: false, message: '无效的外部链接。' };
  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
});

const getOwnedLocalTerminal = (event, terminalId) => {
  const session = localTerminalSessions.get(terminalId);
  if (!session || session.webContents.id !== event.sender.id) {
    throw new Error('本地终端会话不存在或不可访问。');
  }
  return session.terminal;
};

handleTrusted('local-terminal-create', (event, options = {}) => {
  let pty;
  try {
    pty = require('node-pty');
  } catch (error) {
    throw new Error(`本地终端依赖不可用: ${error.message}`);
  }

  const cols = Math.max(20, Math.min(Number(options.cols) || 80, 500));
  const rows = Math.max(5, Math.min(Number(options.rows) || 24, 200));
  const shell = process.platform === 'win32'
    ? process.env.COMSPEC || 'cmd.exe'
    : process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  const terminalId = randomUUID();
  const terminal = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  localTerminalSessions.set(terminalId, { terminal, webContents: event.sender });
  terminal.onData((data) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send('local-terminal-output', { terminalId, data });
    }
  });
  terminal.onExit(({ exitCode }) => {
    localTerminalSessions.delete(terminalId);
    if (!event.sender.isDestroyed()) {
      event.sender.send('local-terminal-exit', { terminalId, exitCode });
    }
  });

  return { terminalId };
});

handleTrusted('local-terminal-write', (event, { terminalId, data }) => {
  if (typeof data !== 'string' || data.length > 64 * 1024) {
    throw new Error('本地终端输入无效。');
  }
  getOwnedLocalTerminal(event, terminalId).write(data);
});

handleTrusted('local-terminal-resize', (event, { terminalId, cols, rows }) => {
  const safeCols = Math.max(20, Math.min(Number(cols) || 80, 500));
  const safeRows = Math.max(5, Math.min(Number(rows) || 24, 200));
  getOwnedLocalTerminal(event, terminalId).resize(safeCols, safeRows);
});

handleTrusted('local-terminal-close', (event, terminalId) => {
  const terminal = getOwnedLocalTerminal(event, terminalId);
  localTerminalSessions.delete(terminalId);
  terminal.kill();
});

const getCpuTimes = () => os.cpus().reduce((total, cpu) => {
  const times = cpu.times;
  return {
    idle: total.idle + times.idle,
    total: total.total + times.user + times.nice + times.sys + times.idle + times.irq,
  };
}, { idle: 0, total: 0 });

const getLocalSystemStatus = () => {
  const currentCpuTimes = getCpuTimes();
  const previous = previousCpuTimes;
  previousCpuTimes = currentCpuTimes;
  const totalCpuDelta = previous ? currentCpuTimes.total - previous.total : 0;
  const idleCpuDelta = previous ? currentCpuTimes.idle - previous.idle : 0;
  const cpuPercent = totalCpuDelta > 0 ? Math.round((1 - idleCpuDelta / totalCpuDelta) * 1000) / 10 : 0;
  const totalMemory = os.totalmem();

  return {
    platform: process.platform,
    hostname: os.hostname(),
    cpuModel: os.cpus()[0]?.model || 'Unknown CPU',
    cpuPercent,
    memoryTotal: totalMemory,
    memoryUsed: totalMemory - os.freemem(),
    uptimeSeconds: os.uptime(),
  };
};

const runSystemCommand = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const timeout = setTimeout(() => {
    child.kill();
    reject(new Error('本机系统信息查询超时。'));
  }, 5000);

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.on('error', (error) => {
    clearTimeout(timeout);
    reject(error);
  });
  child.on('close', (code) => {
    clearTimeout(timeout);
    if (code === 0) {
      resolve(stdout);
      return;
    }
    reject(new Error(stderr.trim() || `系统命令退出，状态码 ${code}。`));
  });
});

const getLocalProcesses = async () => {
  if (process.platform === 'win32') {
    const output = await runSystemCommand('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-Process | Select-Object -First 200 Id,ProcessName,CPU,WorkingSet64 | ConvertTo-Json -Compress',
    ]);
    const rows = JSON.parse(output || '[]');
    return (Array.isArray(rows) ? rows : [rows]).map((row) => ({
      pid: Number(row.Id),
      name: String(row.ProcessName || ''),
      cpu: Number(row.CPU || 0),
      memory: Number(row.WorkingSet64 || 0),
    }));
  }

  const output = await runSystemCommand('ps', ['-axo', 'pid=,comm=,pcpu=,rss=']);
  return output.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+?)\s+(\d+(?:\.\d+)?)\s+(\d+)$/);
    if (!match) return [];
    return [{
      pid: Number(match[1]),
      name: match[2],
      cpu: Number(match[3]),
      memory: Number(match[4]) * 1024,
    }];
  });
};

handleTrusted('get-local-system-status', () => getLocalSystemStatus());
handleTrusted('get-local-processes', () => getLocalProcesses());

const commandExists = (command) => new Promise((resolve) => {
  const checker = process.platform === 'win32'
    ? spawn('where.exe', [command], { stdio: 'ignore' })
    : spawn('sh', ['-lc', `command -v ${command}`], { stdio: 'ignore' });
  checker.on('close', (code) => resolve(code === 0));
  checker.on('error', () => resolve(false));
});

const getExternalRdpClients = async () => {
  if (process.platform === 'darwin') {
    const apps = [
      { id: 'windows-app', name: 'Windows App', path: '/Applications/Windows App.app' },
      { id: 'microsoft-remote-desktop', name: 'Microsoft Remote Desktop', path: '/Applications/Microsoft Remote Desktop.app' },
      { id: 'parallels-client', name: 'Parallels Client', path: '/Applications/Parallels Client.app' },
    ];
    return apps.filter((client) => fs.existsSync(client.path));
  }

  if (process.platform === 'linux') {
    const candidates = [
      { id: 'xfreerdp', name: 'FreeRDP', command: 'xfreerdp' },
      { id: 'wlfreerdp', name: 'FreeRDP Wayland', command: 'wlfreerdp' },
      { id: 'remmina', name: 'Remmina', command: 'remmina' },
    ];
    const clients = [];
    for (const client of candidates) {
      if (await commandExists(client.command)) {
        clients.push(client);
      }
    }
    return clients;
  }

  return [];
};

handleTrusted('get-rdp-client-status', async () => {
  const clients = await getExternalRdpClients();
  return {
    platform: process.platform,
    available: clients.length > 0,
    clients,
  };
});

handleTrusted('open-external-rdp-connection', async (_event, connectionDetails = {}) => {
  const rdpTarget = sanitizeRdpConnection(connectionDetails);
  if (!rdpTarget.ok) {
    return { ok: false, message: rdpTarget.error };
  }
  const { host, username, server } = rdpTarget;

  if (process.platform === 'darwin') {
    const clients = await getExternalRdpClients();
    if (clients.length === 0) {
      return { ok: false, message: '未检测到 macOS 外部 RDP 客户端。请安装 Windows App 或 Microsoft Remote Desktop。' };
    }

    const safeName = String(host).replace(/[^a-z0-9.-]/gi, '_');
    const rdpFilePath = path.join(app.getPath('temp'), `nexus-terminal-${safeName}.rdp`);
    const rdpContent = buildRdpFileContent({ server, username });
    fs.writeFileSync(rdpFilePath, rdpContent, 'utf8');
    const openResult = await shell.openPath(rdpFilePath);
    return openResult
      ? { ok: false, message: `打开外部 RDP 客户端失败: ${openResult}` }
      : { ok: true, message: `已尝试使用外部 RDP 客户端打开 ${server}。` };
  }

  if (process.platform === 'linux') {
    const clients = await getExternalRdpClients();
    const freeRdp = clients.find((client) => client.id === 'xfreerdp' || client.id === 'wlfreerdp');
    if (freeRdp) {
      const args = [`/v:${server}`];
      if (username) args.push(`/u:${username}`);
      args.push('/cert:ignore');
      const child = spawn(freeRdp.command, args, { detached: true, stdio: 'ignore' });
      child.unref();
      return { ok: true, message: `已尝试使用 ${freeRdp.name} 打开 ${server}。` };
    }

    const remmina = clients.find((client) => client.id === 'remmina');
    if (remmina) {
      const target = username ? `rdp://${username}@${server}` : `rdp://${server}`;
      const child = spawn(remmina.command, ['-c', target], { detached: true, stdio: 'ignore' });
      child.unref();
      return { ok: true, message: `已尝试使用 Remmina 打开 ${server}。` };
    }

    return { ok: false, message: '未检测到 Linux 外部 RDP 客户端。请安装 FreeRDP 或 Remmina。' };
  }

  return { ok: false, message: '当前系统不支持外部 RDP 自动调用。' };
});

handleTrusted('select-directory', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? { canceled: true } : { canceled: false, path: result.filePaths[0] };
});

handleTrusted('open-path', async (_event, targetPath) => {
  // Only existing local folders may be revealed; executables/launchers are
  // refused so shell.openPath cannot be used to start programs.
  const validation = validateOpenPathRequest(targetPath);
  if (!validation.ok) {
    console.warn(`[Security] open-path refused: ${validation.error}`);
    return { ok: false, error: validation.error };
  }
  const error = await shell.openPath(validation.path);
  return error ? { ok: false, error } : { ok: true };
});

onTrusted('close-window', () => {
  if (mainWindow) {
    mainWindow.close();
  }
});

onTrusted('toggle-maximize-window', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

onTrusted('toggle-always-on-top', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  isAlwaysOnTop = !mainWindow.isAlwaysOnTop();
  mainWindow.setAlwaysOnTop(isAlwaysOnTop);
  mainWindow.webContents.send('always-on-top-changed', isAlwaysOnTop);
});

// IPC handler for opening RDP connection
onTrusted('open-rdp-connection', async (event, connectionDetails = {}) => {
  const password = typeof connectionDetails?.password === 'string' ? connectionDetails.password : '';
  if (process.platform !== 'win32') {
    console.warn(`[Main Process] RDP: Native mstsc is only available on Windows. Current platform: ${process.platform}`);
    dialog.showErrorBox('RDP 不可用', '系统远程桌面 mstsc 只支持 Windows。macOS/Linux 请使用 Web/Docker 远程桌面网关模式，或安装第三方 RDP 客户端手动连接。');
    return;
  }

  const rdpTarget = sanitizeRdpConnection(connectionDetails);
  if (!rdpTarget.ok) {
    console.error(`[Main Process] RDP: Rejected connection details: ${rdpTarget.error}`);
    dialog.showErrorBox('RDP 参数无效', rdpTarget.error);
    return;
  }
  const { host, username } = rdpTarget;
  if (/[\u0000-\u001f\u007f]/.test(password)) {
    console.error('[Main Process] RDP: Rejected password containing control characters.');
    dialog.showErrorBox('RDP 参数无效', 'RDP 密码包含非法控制字符。');
    return;
  }

  const serverAddressForMstsc = rdpTarget.server; // 用于 mstsc.exe /v:
  const cmdkeyTarget = `TERMSRV/${host}`; // cmdkey 的目标通常不包含端口

  const executeCommand = (command, args, operationDesc) => {
    return new Promise((resolve, reject) => {
      const loggedArgs = args.map(arg => (/^\/pass:/i.test(arg) ? '/pass:***' : arg));
      console.log(`[Main Process] RDP: Executing ${operationDesc}: ${command} ${loggedArgs.join(' ')}`);
      // 直接启动程序而不经过 cmd.exe，避免主机名/用户名/密码中的 & | ^ 等字符被 cmd 解释执行。
      const child = spawn(command, args, { stdio: 'pipe', windowsHide: true });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data) => stdout += data.toString());
      child.stderr.on('data', (data) => stderr += data.toString());

      child.on('close', (code) => {
        if (code === 0) {
          console.log(`[Main Process] RDP: ${operationDesc} successful.`);
          resolve(stdout);
        } else {
          console.error(`[Main Process] RDP: ${operationDesc} failed with code ${code}. Stderr: [${stderr.trim()}]. Stdout: [${stdout.trim()}]`);
          reject(new Error(`${operationDesc} failed. Code: ${code}. Stderr: ${stderr.trim()}. Stdout: ${stdout.trim()}`));
        }
      });
      child.on('error', (err) => {
        console.error(`[Main Process] RDP: Failed to start ${operationDesc}:`, err);
        reject(err);
      });
    });
  };

  try {
    // 步骤 1: 如果提供了用户名和密码，则存储凭据
    if (username && password) {
      // 重要: 确保参数被正确引用，特别是密码中可能包含特殊字符
      const cmdkeyAddArgs = ['/generic:' + cmdkeyTarget, '/user:' + username, '/pass:' + password];
      console.log('[Main Process] RDP: Preparing to add credentials with cmdkey. Target:', cmdkeyTarget, 'User:', username);
      await executeCommand('cmdkey.exe', cmdkeyAddArgs, 'add credentials');
    } else {
      console.log('[Main Process] RDP: Username or password not provided, skipping credential storage.');
    }

    // 步骤 2: 启动 mstsc.exe
    const mstscArgs = [`/v:${serverAddressForMstsc}`]; // 使用包含端口的地址给 mstsc
    console.log(`[Main Process] RDP: Launching mstsc.exe with args: mstsc.exe ${mstscArgs.join(' ')}`);
    const mstscProcess = spawn('mstsc.exe', mstscArgs, {
      detached: true,
      stdio: 'ignore',
    });

    mstscProcess.on('error', (err) => {
      console.error('[Main Process] RDP: Failed to start mstsc.exe:', err);
      // event.reply('open-rdp-connection-error', `Failed to start mstsc.exe: ${err.message}`);
      // 即使 mstsc 启动失败，也尝试清理凭据（如果已设置）
      if (username && password) { // 只有在尝试添加凭据后才尝试删除
        console.log('[Main Process] RDP: Attempting to delete credentials after mstsc error. Target:', cmdkeyTarget);
        executeCommand('cmdkey.exe', ['/delete:' + cmdkeyTarget], 'delete credentials (after mstsc error)')
          .catch(cleanupErr => console.error('[Main Process] RDP: Error during post-mstsc-error credential cleanup:', cleanupErr.message));
      }
    });
    mstscProcess.unref(); // 允许主进程独立于 mstsc 退出

    // 步骤 3: 在 mstsc 启动后（不需要等待其关闭），如果之前存储了凭据，则删除它们
    // 稍作延迟以确保 mstsc 有时间读取凭据，但这是一个猜测性的延迟。
    if (username && password) {
      setTimeout(async () => {
        try {
          console.log('[Main Process] RDP: Attempting to delete credentials after mstsc launch. Target:', cmdkeyTarget);
          await executeCommand('cmdkey.exe', ['/delete:' + cmdkeyTarget], 'delete credentials (after mstsc launch)');
        } catch (cleanupErr) {
          console.error('[Main Process] RDP: Error during post-mstsc-launch credential cleanup:', cleanupErr.message);
        }
      }, 3000); // 增加到3秒延迟，可以根据需要调整
    }

    // event.reply('open-rdp-connection-success', `RDP process for ${serverAddress} initiated.`);

  } catch (error) {
    console.error('[Main Process] RDP: Overall error in open-rdp-connection handler:', error);
    // event.reply('open-rdp-connection-error', `Error processing RDP connection: ${error.message}`);
    // 确保在主处理流程出错时也尝试清理凭据
    if (username && password) {
        console.log('[Main Process] RDP: Attempting credential cleanup due to main handler error. Target:', cmdkeyTarget);
        executeCommand('cmdkey.exe', ['/delete:' + cmdkeyTarget], 'delete credentials (after main error)')
            .catch(cleanupErr => console.error('[Main Process] RDP: Error during post-main-error credential cleanup:', cleanupErr.message));
    }
  }
});

// IPC handler for initiating a download from renderer
onTrusted('download-file-request', (event, { url: relativeUrl, encodedFilename }) => {
  const decodedFilename = encodedFilename ? Buffer.from(encodedFilename, 'base64').toString('utf-8') : null;
  console.log(`[Main Process] Received download request. Relative URL: ${relativeUrl}, Decoded Filename: ${decodedFilename || 'unknown (was not provided or failed to decode)'}`);

  if (!actualBackendUrlForFileDownloads) {
    console.error('[Main Process] Cannot start download: actualBackendUrlForFileDownloads is not set. Backend URL for downloads is missing.');
    event.sender.send('download-reply', {
      type: 'failed',
      filename: decodedFilename || 'unknown',
      error: 'Critical: Backend URL for downloads is not available in main process.'
    });
    return;
  }

  let absoluteUrl;
  try {
    // 确保 relativeUrl 是一个有效的相对路径或绝对路径字符串
    if (typeof relativeUrl !== 'string' || relativeUrl.trim() === '') {
        throw new Error('Relative URL is empty or not a string.');
    }
    // 使用 actualBackendUrlForFileDownloads 来构造绝对 URL
    absoluteUrl = new URL(relativeUrl, actualBackendUrlForFileDownloads).href;
    if (!isTrustedOrigin(absoluteUrl, [new URL(actualBackendUrlForFileDownloads).origin, ...getTrustedFrontendOrigins()])) {
      throw new Error('Download URL must point to the local Nexus Terminal backend.');
    }
    console.log(`[Main Process] Constructed absolute download URL using actualBackendUrlForFileDownloads: ${absoluteUrl}`);
  } catch (e) {
    console.error(`[Main Process] Error constructing absolute URL from relative: "${relativeUrl}" and base: "${actualBackendUrlForFileDownloads}". Error: ${e.message}`);
    event.sender.send('download-reply', {
      type: 'failed',
      filename: decodedFilename || 'unknown',
      error: `Invalid URL format or construction error: ${relativeUrl}. Details: ${e.message}`
    });
    return;
  }

  if (mainWindow && absoluteUrl) {
    // 将解码后的文件名和绝对URL一起存储，以便 will-download 事件可以检索
    pendingDownloadsInfo.set(absoluteUrl, { filename: decodedFilename });
    console.log(`[Main Process] Stored in pendingDownloadsInfo - Key: ${absoluteUrl}, Value: { filename: ${decodedFilename} }`);
    mainWindow.webContents.downloadURL(absoluteUrl); // 使用绝对 URL 启动下载
  } else {
    console.error('[Main Process] Cannot start download: mainWindow not available or absolute URL construction failed.');
    event.sender.send('download-reply', {
      type: 'failed',
      filename: decodedFilename || 'unknown',
      error: 'Main window not available or absolute URL missing/invalid to start download.'
    });
  }
});
