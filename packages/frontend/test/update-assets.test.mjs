import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const {
  getChecksumAsset,
  getPlatformDownloadAsset,
  getWindowsPortableAsset,
  isArm64Architecture,
  isVersionNewer,
} = await import(pathToFileURL(process.env.UPDATE_ASSETS_MODULE).href);

// Asset names exactly as published on the real v0.9.22.45 GitHub release
// (GitHub replaces spaces in uploaded file names with dots).
const base = 'https://github.com/caichengle666/nexus-terminal/releases/download/v0.9.22.45/';
const assets = [
  'Nexus.Terminal-0.9.22.45-macOS-arm64.dmg',
  'Nexus.Terminal-0.9.22.45-macOS-x64.dmg',
  'Nexus.Terminal.Portable.win-unpacked.zip',
  'Nexus.Terminal.Setup.0.9.22.45.exe',
  'SHA256SUMS.txt',
].map(name => ({ name, browser_download_url: `${base}${name}` }));

const setUserAgent = userAgent => {
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent }, configurable: true });
};
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) nexus-electron-app/0.9.22.45 Chrome/140.0.0.0 Electron/43.1.1 Safari/537.36';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) nexus-electron-app/0.9.22.45 Chrome/140.0.0.0 Electron/43.1.1 Safari/537.36';

test('Windows installed copy gets the NSIS installer', () => {
  setUserAgent(WINDOWS_UA);
  assert.equal(getPlatformDownloadAsset(assets, 'win32', 'x64')?.name, 'Nexus.Terminal.Setup.0.9.22.45.exe');
});

test('Windows portable copy gets the portable ZIP (x64 and arm64)', () => {
  assert.equal(getWindowsPortableAsset(assets, false)?.name, 'Nexus.Terminal.Portable.win-unpacked.zip');
  assert.equal(getWindowsPortableAsset(assets, true)?.name, 'Nexus.Terminal.Portable.win-unpacked.zip');
});

test('macOS gets the DMG of its own architecture', () => {
  setUserAgent(MAC_UA);
  assert.equal(getPlatformDownloadAsset(assets, 'darwin', 'arm64')?.name, 'Nexus.Terminal-0.9.22.45-macOS-arm64.dmg');
  assert.equal(getPlatformDownloadAsset(assets, 'darwin', 'x64')?.name, 'Nexus.Terminal-0.9.22.45-macOS-x64.dmg');
});

test('native architecture wins over the user agent', () => {
  setUserAgent(WINDOWS_UA);
  assert.equal(isArm64Architecture('arm64'), true);
  assert.equal(isArm64Architecture('x64'), false);
  setUserAgent('Mozilla/5.0 (X11; Linux aarch64)');
  assert.equal(isArm64Architecture(null), true);
});

test('checksum manifest is found', () => {
  assert.equal(getChecksumAsset(assets)?.name, 'SHA256SUMS.txt');
});

test('compares four-part versions numerically', () => {
  assert.equal(isVersionNewer('v0.9.22.45', '0.9.22.45'), false);
  assert.equal(isVersionNewer('v0.9.22.46', '0.9.22.45'), true);
  assert.equal(isVersionNewer('v0.9.22.100', '0.9.22.99'), true);
  assert.equal(isVersionNewer('v0.9.23', '0.9.22.45'), true);
  assert.equal(isVersionNewer('v0.9.22', '0.9.22.45'), false);
  assert.equal(isVersionNewer('v0.10.0', '0.9.99.99'), true);
  assert.equal(isVersionNewer('v0.9.22.44', '0.9.22.45'), false);
});
