const { app, BrowserWindow, ipcMain, dialog, session, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const url = require('url');
const express = require('express'); 
const http = require('http'); 
const { spawn } = require('child_process');
const fs = require('fs');
const iconv = require('iconv-lite');
const { createProxyMiddleware } = require('http-proxy-middleware');

let mainWindow;
let expressApp;
let httpServer;
let backendProcess;
let frontendUrlForDownloads; // 用于IPC处理器访问前端URL
let actualBackendUrlForFileDownloads; // 新增：用于文件下载的后端URL
let tray = null;
let isQuitting = false;
let isAlwaysOnTop = false;
const PROD_FRONTEND_PORT = 22457;
const PROD_BACKEND_PORT = 22458;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
    void dialog.showMessageBox({
      type: 'info',
      title: 'Nexus Terminal',
      message: '程序已启动',
      detail: 'Nexus Terminal 已经在运行，已为你显示主窗口。',
      buttons: ['确定'],
    });
  });
}

// Some Windows graphics drivers render Electron as a blank white window with GPU compositing enabled.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');

// 用于在 download-file-request 和 will-download 之间传递期望的文件名
const pendingDownloadsInfo = new Map();
const isDev = process.argv.includes('--dev'); // 确保 isDev 在此作用域可用

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setSkipTaskbar(false);
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
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
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: showMainWindow,
    },
    {
      label: '退出',
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
  const lastWindowState = store.get('windowBounds', defaultBounds);

  mainWindow = new BrowserWindow({
    width: lastWindowState.width,
    height: lastWindowState.height,
    x: lastWindowState.x, // 如果保存了 x，则恢复
    y: lastWindowState.y, // 如果保存了 y，则恢复
    frame: false,
    show: false, // 创建时不显示窗口
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true, // 启用上下文隔离
    },
  });
  mainWindow.setAlwaysOnTop(isAlwaysOnTop);
  createTray();

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

    console.log(`[Prod Mode] Starting backend service from ${backendEntryPath} using Node.js at ${nodeExecutablePath}...`);
    backendProcess = spawn(nodeExecutablePath, [backendEntryPath], {
      cwd: path.dirname(backendEntryPath),
      stdio: ['pipe', 'pipe', 'pipe'], // 'inherit' for debugging, or 'pipe'
      env: {
        ...process.env, // 继承当前进程的环境变量
        APP_BACKEND_DATA_PATH: backendDataPath,
        PORT: String(PROD_BACKEND_PORT)
      },
    });

    const backendReadyPromise = new Promise((resolveBackend, rejectBackend) => {
      const backendReadyString = "BACKEND_READY_SIGNAL"; // 重要提示: 请确保您的后端服务在就绪时打印此确切字符串!
      let backendLogs = ""; // 用于在超时或错误时记录日志
      let backendReadyResolved = false;
      const readyTimeoutDuration = 60000; // 后端启动超时时间 (毫秒)，例如 60 秒

      console.log(`[Prod Mode] Backend service process initiated (PID: ${backendProcess.pid}). Waiting for '${backendReadyString}' signal (max ${readyTimeoutDuration / 1000}s)...`);

      const readyTimeout = setTimeout(() => {
        const timeoutMessage = `[Backend Watcher] Timeout after ${readyTimeoutDuration / 1000}s waiting for backend ready signal ('${backendReadyString}').`;
        console.error(timeoutMessage + ` Review backend logs. Last logs captured by main process:\n${backendLogs}`);
        dialog.showErrorBox("后端启动超时", `后端服务在 ${readyTimeoutDuration / 1000} 秒内未能启动。请检查应用日志。\n\n捕获到的日志片段:\n${backendLogs.substring(0, 500)}${backendLogs.length > 500 ? '...' : ''}`);
        rejectBackend(new Error(`Timeout waiting for backend. Last logs: ${backendLogs.substring(0, 200)}...`));
        // 根据需要，如果后端至关重要，可以在此处考虑 app.quit();
      }, readyTimeoutDuration);

      backendProcess.stdout.on('data', (data) => {
        const output = data.toString();
        console.log(`[Backend STDOUT]: ${output.trim()}`);
        backendLogs += output; // 累积所有 stdout 日志
        if (output.includes(backendReadyString)) {
          clearTimeout(readyTimeout);
          backendReadyResolved = true;
          console.log('[Backend Watcher] Backend ready signal received!');
          resolveBackend();
        }
      });

      backendProcess.stderr.on('data', (data) => {
        const errorOutput = data.toString();
        console.error(`[Backend STDERR]: ${errorOutput.trim()}`);
        backendLogs += `[STDERR] ${errorOutput}`; // 累积所有 stderr 日志
      });

      backendProcess.on('close', (code) => {
        console.log(`[Backend Process] exited with code ${code}`);
        // backendProcess = null; // 在 'before-quit' 中处理 backendProcess 的状态
        if (isQuitting || backendReadyResolved) {
          return;
        }
        if (code !== 0) { // 如果后端在发出就绪信号前非正常退出
          clearTimeout(readyTimeout); // 确保超时被清除
          const errorMessage = `后端进程在发出就绪信号前意外退出，退出码: ${code}。`;
          console.error(`[Backend Watcher] ${errorMessage}`);
          backendLogs += `\n[SYSTEM] Backend process exited with code ${code}.\n`;
          dialog.showErrorBox("后端错误", `${errorMessage}\n\n捕获到的日志片段:\n${backendLogs.substring(0, 500)}${backendLogs.length > 500 ? '...' : ''}`);
          rejectBackend(new Error(errorMessage + ` Last logs: ${backendLogs.substring(0,200)}...`));
          // 根据需要，app.quit();
        }
        // 如果 'close' 在就绪信号之后发生，Promise 应该已经解决。
      });
      
      backendProcess.on('error', (err) => {
        clearTimeout(readyTimeout); // 确保超时被清除
        console.error('[Backend Process] Failed to start:', err);
        dialog.showErrorBox("后端启动失败", `启动后端进程失败: ${err.message}`);
        rejectBackend(err);
        app.quit(); // 关键错误，退出应用
      });
    });

    // 启动 express 前端服务器
    expressApp = express();
    const backendTarget = `http://127.0.0.1:${PROD_BACKEND_PORT}`;
    const backendProxy = createProxyMiddleware({
      pathFilter: ['/api', '/uploads', '/ws'],
      target: backendTarget,
      ws: true,
      changeOrigin: true,
      logLevel: 'warn',
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
    httpServer.on('upgrade', backendProxy.upgrade);

    const frontendServerReadyPromise = new Promise((resolveFrontend, rejectFrontend) => {
      httpServer.listen(PROD_FRONTEND_PORT, () => {
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
      // 生产启动后直接进入系统托盘，不占用任务栏；点击托盘图标再显示主窗口。
      hideMainWindowToTray();
      // 如果需要，可以在页面加载完成后再显示
      // mainWindow.once('ready-to-show', () => {
      //   mainWindow.show();
      // });
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

  // 保存窗口状态
  mainWindow.on('close', (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const bounds = mainWindow.getBounds();
      store.set('windowBounds', bounds);
    }
    if (!isQuitting) {
      event.preventDefault();
      hideMainWindowToTray();
    }
  });

  mainWindow.on('minimize', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      hideMainWindowToTray();
    }
  });

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
  createWindow().catch(err => {
    console.error('Error during createWindow:', err);
    // 发生严重错误，可能需要退出应用
    app.quit();
  });
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
  console.log('Application is quitting...');
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
ipcMain.on('toMain', (event, args) => {
  console.log('Message from renderer:', args);
  // mainWindow.webContents.send('fromMain', { message: 'Hello from main process!' });
});

// IPC handlers for window controls
ipcMain.on('minimize-window', () => {
  if (mainWindow) {
    hideMainWindowToTray();
  }
});

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? { canceled: true } : { canceled: false, path: result.filePaths[0] };
});

ipcMain.handle('open-path', async (_event, targetPath) => {
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    return { ok: false, error: '路径无效。' };
  }
  const error = await shell.openPath(targetPath);
  return error ? { ok: false, error } : { ok: true };
});

ipcMain.on('close-window', () => {
  if (mainWindow) {
    mainWindow.close();
  }
});

ipcMain.on('toggle-maximize-window', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('toggle-always-on-top', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  isAlwaysOnTop = !mainWindow.isAlwaysOnTop();
  mainWindow.setAlwaysOnTop(isAlwaysOnTop);
  mainWindow.webContents.send('always-on-top-changed', isAlwaysOnTop);
});

// IPC handler for opening RDP connection
ipcMain.on('open-rdp-connection', async (event, { host, port, username, password }) => {
  if (!host) {
    console.error('[Main Process] RDP: Received request without host.');
    // event.reply('open-rdp-connection-error', 'Host is required');
    return;
  }

  const serverAddressForMstsc = port ? `${host}:${port}` : host; // 用于 mstsc.exe /v:
  const cmdkeyTarget = `TERMSRV/${host}`; // cmdkey 的目标通常不包含端口

  const executeCommand = (command, args, operationDesc) => {
    return new Promise((resolve, reject) => {
      console.log(`[Main Process] RDP: Executing ${operationDesc}: cmd.exe /C ${command} ${args.join(' ')}`);
      // 使用 cmd.exe /C 来执行，这更接近 BAT 脚本的行为，并有助于处理路径和环境变量
      const process = spawn('cmd.exe', ['/C', command, ...args], { stdio: 'pipe' });

      let stdout = '';
      let stderr = '';
      process.stdout.on('data', (data) => stdout += data.toString());
      process.stderr.on('data', (data) => stderr += data.toString());

      process.on('close', (code) => {
        if (code === 0) {
          console.log(`[Main Process] RDP: ${operationDesc} successful.`);
          resolve(stdout);
        } else {
          console.error(`[Main Process] RDP: ${operationDesc} failed with code ${code}. Stderr: [${stderr.trim()}]. Stdout: [${stdout.trim()}]`);
          reject(new Error(`${operationDesc} failed. Code: ${code}. Stderr: ${stderr.trim()}. Stdout: ${stdout.trim()}`));
        }
      });
      process.on('error', (err) => {
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
ipcMain.on('download-file-request', (event, { url: relativeUrl, encodedFilename }) => {
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

// 为了允许 localhost 加载，如果前端和后端都通过 localhost 提供服务
app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors');
