const { contextBridge, ipcRenderer } = require('electron');

// 将选择的 API 暴露给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  getRdpClientStatus: () => ipcRenderer.invoke('get-rdp-client-status'),
  openExternalRdp: (connectionDetails) => ipcRenderer.invoke('open-external-rdp-connection', connectionDetails),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  openPath: (targetPath) => ipcRenderer.invoke('open-path', targetPath),
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
    const validChannels = ['fromMain', 'download-progress', 'download-reply', 'always-on-top-changed'];
    if (validChannels.includes(channel)) {
      // 确保 func 是一个函数
      if (typeof func === 'function') {
        const listener = (event, ...args) => func(...args);
        ipcRenderer.on(channel, listener);
        // 返回一个取消订阅的函数
        return () => ipcRenderer.removeListener(channel, listener);
      } else {
        console.warn(`[Preload] receiveMessage: Provided callback for channel ${channel} is not a function.`);
        return () => {}; // 返回一个空函数
      }
    } else {
      console.warn(`[Preload] receiveMessage: Invalid channel: ${channel}. Valid channels are: ${validChannels.join(', ')}`);
      return () => {}; // 返回一个空函数
    }
  },
  // 移除监听器，防止内存泄漏
  removeListener: (channel, func) => {
    ipcRenderer.removeListener(channel, func);
  },
  // 移除所有特定频道的监听器
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
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
      const encodedFilename = filename ? Buffer.from(filename).toString('base64') : null;
      console.log(`[Preload] Sending 'download-file-request' for URL: ${url}, Original Filename: ${filename}, Encoded Filename: ${encodedFilename}`);
      ipcRenderer.send('download-file-request', { url, encodedFilename });
    } else {
      console.warn('[Preload] requestDownload called without URL.');
    }
  }
});

console.log('Preload script loaded, electronAPI exposed.');
