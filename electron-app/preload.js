// This preload runs in a sandboxed renderer (sandbox: true): only `electron`
// (contextBridge/ipcRenderer), `events`, `timers` and `url` may be required, and
// Node globals such as Buffer must not be relied on.
const { contextBridge, ipcRenderer } = require('electron');

const encodeBase64Utf8 = (value) => {
  const bytes = new TextEncoder().encode(String(value));
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
};

// Channels the renderer may subscribe to through receiveMessage(). Listeners
// registered there are tracked so removeListener/removeAllListeners only ever
// touch those listeners (never preload-internal ones or other channels).
const RECEIVE_CHANNELS = ['fromMain', 'download-progress', 'download-reply', 'always-on-top-changed'];
const receiveSubscriptions = new Map(RECEIVE_CHANNELS.map(channel => [channel, new Set()]));

const unsubscribe = (channel, entry) => {
  const entries = receiveSubscriptions.get(channel);
  if (!entries || !entries.has(entry)) return;
  entries.delete(entry);
  ipcRenderer.removeListener(channel, entry.listener);
};

// 将选择的 API 暴露给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  getGpuCompositingEnabled: () => ipcRenderer.invoke('get-gpu-compositing'),
  getGpuSettings: () => ipcRenderer.invoke('get-gpu-settings'),
  setGpuSettings: (hardwareAcceleration) => ipcRenderer.invoke('set-gpu-settings', { hardwareAcceleration }),
  relaunchApp: () => ipcRenderer.invoke('relaunch-app'),
  notifyAppRendered: () => ipcRenderer.send('app-rendered'),
  onGpuCompositingChanged: (listener) => {
    const handler = (_event, payload) => listener(Boolean(payload?.enabled));
    ipcRenderer.on('gpu-compositing-changed', handler);
    return () => ipcRenderer.removeListener('gpu-compositing-changed', handler);
  },
  getArchitecture: () => ipcRenderer.invoke('get-architecture'),
  getInstallationKind: () => ipcRenderer.invoke('get-installation-kind'),
  checkLatestRelease: (payload) => ipcRenderer.invoke('check-latest-release', payload),
  downloadUpdate: (payload) => ipcRenderer.invoke('download-update', payload),
  cancelUpdate: () => ipcRenderer.invoke('cancel-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  showUpdateFile: () => ipcRenderer.invoke('show-update-file'),
  getFloatingNotificationBellSettings: () => ipcRenderer.invoke('get-floating-notification-bell-settings'),
  setFloatingNotificationBellEnabled: (enabled) => ipcRenderer.invoke('set-floating-notification-bell-enabled', enabled),
  updateFloatingNotificationBell: (payload) => ipcRenderer.send('update-floating-notification-bell', payload),
  floatingNotificationBellDrag: (payload) => ipcRenderer.send('floating-notification-bell-drag', payload),
  floatingNotificationBellClick: () => ipcRenderer.send('floating-notification-bell-click'),
  updateFloatingNotificationBellTheme: (theme) => ipcRenderer.send('update-floating-notification-bell-theme', theme),
  onOpenTaskNotificationCenter: (listener) => {
    const handler = () => listener();
    ipcRenderer.on('open-task-notification-center', handler);
    return () => ipcRenderer.removeListener('open-task-notification-center', handler);
  },
  onUpdateProgress: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('update-progress', handler);
    return () => ipcRenderer.removeListener('update-progress', handler);
  },
  createLocalTerminal: (options) => ipcRenderer.invoke('local-terminal-create', options),
  writeLocalTerminal: (payload) => ipcRenderer.invoke('local-terminal-write', payload),
  resizeLocalTerminal: (payload) => ipcRenderer.invoke('local-terminal-resize', payload),
  closeLocalTerminal: (terminalId) => ipcRenderer.invoke('local-terminal-close', terminalId),
  onLocalTerminalOutput: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('local-terminal-output', handler);
    return () => ipcRenderer.removeListener('local-terminal-output', handler);
  },
  onLocalTerminalExit: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('local-terminal-exit', handler);
    return () => ipcRenderer.removeListener('local-terminal-exit', handler);
  },
  getLocalSystemStatus: () => ipcRenderer.invoke('get-local-system-status'),
  getLocalProcesses: () => ipcRenderer.invoke('get-local-processes'),
  getRdpClientStatus: () => ipcRenderer.invoke('get-rdp-client-status'),
  openExternalRdp: (connectionDetails) => ipcRenderer.invoke('open-external-rdp-connection', connectionDetails),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  openPath: (targetPath) => ipcRenderer.invoke('open-path', targetPath),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  // 从渲染进程向主进程发送消息
  sendMessage: (channel, data) => {
    // 添加了 'download-file-request' 用于下载
    const validChannels = ['toMain', 'minimize-window', 'close-window', 'toggle-maximize-window', 'toggle-always-on-top', 'open-rdp-connection', 'download-file-request'];
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    } else {
      console.warn(`[Preload] sendMessage: Invalid channel: ${channel}. Valid channels are: ${validChannels.join(', ')}`);
    }
  },
  // 从主进程接收消息
  receiveMessage: (channel, func) => {
    // 添加了 'download-progress' 和 'download-reply' 用于下载状态
    const validChannels = RECEIVE_CHANNELS;
    if (validChannels.includes(channel)) {
      // 确保 func 是一个函数
      if (typeof func === 'function') {
        const entry = { func, listener: (_event, ...args) => func(...args) };
        receiveSubscriptions.get(channel).add(entry);
        ipcRenderer.on(channel, entry.listener);
        // 返回一个取消订阅的函数
        return () => unsubscribe(channel, entry);
      } else {
        console.warn(`[Preload] receiveMessage: Provided callback for channel ${channel} is not a function.`);
        return () => {}; // 返回一个空函数
      }
    } else {
      console.warn(`[Preload] receiveMessage: Invalid channel: ${channel}. Valid channels are: ${validChannels.join(', ')}`);
      return () => {}; // 返回一个空函数
    }
  },
  // 移除通过 receiveMessage 注册的监听器 (receiveMessage 返回的取消函数是首选方式)
  removeListener: (channel, func) => {
    const entries = receiveSubscriptions.get(channel);
    if (!entries) return;
    for (const entry of [...entries]) {
      if (entry.func === func) unsubscribe(channel, entry);
    }
  },
  // 移除某个允许频道上通过 receiveMessage 注册的全部监听器
  removeAllListeners: (channel) => {
    const entries = receiveSubscriptions.get(channel);
    if (!entries) return;
    for (const entry of [...entries]) unsubscribe(channel, entry);
  },
  // 窗口控制
  minimizeWindow: () => {
    ipcRenderer.send('minimize-window');
  },
  closeWindow: () => {
    ipcRenderer.send('close-window');
  },
  toggleMaximizeWindow: () => {
    ipcRenderer.send('toggle-maximize-window');
  },
  toggleAlwaysOnTop: () => {
    ipcRenderer.send('toggle-always-on-top');
  },
  // Function to trigger RDP connection
  openRdp: (connectionDetails) => { // e.g., { host, username, password }
    // Validate connectionDetails if necessary before sending
    if (connectionDetails && connectionDetails.host) {
      ipcRenderer.send('open-rdp-connection', connectionDetails);
    } else {
      console.warn('[Preload] openRdp called without necessary connection details (host).');
    }
  },
  // 用于文件下载的新方法
  requestDownload: (url, filename) => {
    if (url) {
      const encodedFilename = filename ? encodeBase64Utf8(filename) : null;
      console.log(`[Preload] Sending 'download-file-request' for URL: ${url}, Original Filename: ${filename}, Encoded Filename: ${encodedFilename}`);
      ipcRenderer.send('download-file-request', { url, encodedFilename });
    } else {
      console.warn('[Preload] requestDownload called without URL.');
    }
  }
});

console.log('Preload script loaded, electronAPI exposed.');
