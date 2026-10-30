'use strict';

// electron-builder afterPack hook (build time only, not packaged).
//
// Windows only: drop the DirectX Shader Compiler DLLs that Electron ships for
// WebGPU's D3D12 backend (dxcompiler.dll ~25.7 MB, dxil.dll ~1.5 MB). The app
// does not use WebGPU (no navigator.gpu, no xterm WebGL addon); compositing and
// WebGL go through ANGLE (D3D11), which needs d3dcompiler_47.dll, with
// vk_swiftshader as the software fallback — those are kept.
// macOS/Linux builds are left untouched.

const fs = require('fs');
const path = require('path');

const WINDOWS_WEBGPU_ONLY_FILES = ['dxcompiler.dll', 'dxil.dll'];
// ANGLE (libEGL/libGLESv2) is linked into the Electron 44 executable; these are the separate files it loads.
const WINDOWS_REQUIRED_GPU_FILES = ['d3dcompiler_47.dll', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json'];

const removeWindowsWebGpuFiles = (appOutDir, log = console.log) => {
  const removed = [];
  for (const name of WINDOWS_WEBGPU_ONLY_FILES) {
    const file = path.join(appOutDir, name);
    if (!fs.existsSync(file)) continue;
    const size = fs.statSync(file).size;
    fs.rmSync(file, { force: true });
    removed.push(name);
    log(`  • afterPack: removed ${name} (${(size / 1048576).toFixed(1)} MB, WebGPU only)`);
  }
  const missing = WINDOWS_REQUIRED_GPU_FILES.filter(name => !fs.existsSync(path.join(appOutDir, name)));
  if (missing.length) throw new Error(`afterPack: required GPU files missing from ${appOutDir}: ${missing.join(', ')}`);
  return removed;
};

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  removeWindowsWebGpuFiles(context.appOutDir);
};

module.exports.removeWindowsWebGpuFiles = removeWindowsWebGpuFiles;
module.exports.WINDOWS_WEBGPU_ONLY_FILES = WINDOWS_WEBGPU_ONLY_FILES;
module.exports.WINDOWS_REQUIRED_GPU_FILES = WINDOWS_REQUIRED_GPU_FILES;
