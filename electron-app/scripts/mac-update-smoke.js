#!/usr/bin/env node
// macOS smoke test of the in-app updater's DMG path, against a real GitHub
// release. Uses the same modules main.js uses: fetch SHA256SUMS.txt, download
// the DMG, hard-check SHA-256, run the (advisory) Gatekeeper check, then mount
// the image and check the .app inside. Usage: node mac-update-smoke.js <tag> <arm64|x64>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { downloadAsset, fetchTextAsset, hashFile } = require('../update-download-service');
const { extractExpectedChecksum, verifyUpdateSignature } = require('../update-verification');

const [tag, arch] = process.argv.slice(2);
if (!tag || !['arm64', 'x64'].includes(arch)) {
  console.error('usage: mac-update-smoke.js <tag> <arm64|x64>');
  process.exit(2);
}
const version = tag.replace(/^v/, '');
const base = `https://github.com/caichengle666/nexus-terminal/releases/download/${tag}/`;
const filename = `Nexus.Terminal-${version}-macOS-${arch}.dmg`;
const annotate = (level, message) => {
  if (process.env.GITHUB_ACTIONS) console.log(`::${level}::${String(message).replace(/\r?\n/g, ' | ')}`);
};
const context = {
  agent: null,
  isCancelled: () => false,
  onStage: (stage, extra) => console.log(`[stage] ${stage}`, extra?.source || extra?.message || ''),
  registerRequest() {}, unregisterRequest() {}, registerFile() {}, abortRequests() {},
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-update-'));
  const target = path.join(dir, filename);

  const sums = await fetchTextAsset(`${base}SHA256SUMS.txt`, context, { allowMirrors: false, mirrorUrls: [] });
  const expected = extractExpectedChecksum(sums, filename);
  if (!expected) throw new Error(`SHA256SUMS.txt has no entry for ${filename}`);
  console.log(`expected sha256 ${expected}`);

  let last = 0;
  const started = Date.now();
  await downloadAsset(`${base}${filename}`, target, context, (received, total) => {
    const pct = total ? Math.floor((received / total) * 100) : 0;
    if (pct >= last + 10) { last = pct; console.log(`downloaded ${pct}% (${received}/${total})`); }
  }, { allowMirrors: false, mirrorUrls: [] });
  const size = fs.statSync(target).size;
  console.log(`download done: ${size} bytes in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const actual = await hashFile(target);
  if (actual !== expected) throw new Error(`SHA-256 mismatch: got ${actual}`);
  console.log('SHA-256 OK');

  const signature = await verifyUpdateSignature(target, 'darwin');
  console.log(`Gatekeeper: ${signature.status} — ${signature.detail}`);
  annotate('notice', `${arch} SHA-256 OK; Gatekeeper ${signature.status}: ${signature.detail}`);
  if (signature.status === 'invalid') throw new Error('updater would refuse this DMG (invalid signature)');

  const mount = path.join(dir, 'mnt');
  fs.mkdirSync(mount);
  try {
    execFileSync('hdiutil', ['attach', target, '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount], { stdio: 'pipe' });
  } catch (error) {
    throw new Error(`hdiutil attach failed: ${(error.stderr || error.stdout || error.message).toString().trim()}`);
  }
  try {
    const apps = fs.readdirSync(mount).filter(name => name.endsWith('.app'));
    console.log(`DMG contents: ${fs.readdirSync(mount).join(', ')}`);
    if (apps.length !== 1) throw new Error(`expected one .app in the DMG, found ${apps.length}`);
    const app = path.join(mount, apps[0]);
    const plist = path.join(app, 'Contents', 'Info.plist');
    const read = key => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist]).toString().trim();
    const shortVersion = read('CFBundleShortVersionString');
    const executable = read('CFBundleExecutable');
    console.log(`app ${apps[0]} version ${shortVersion}, executable ${executable}`);
    annotate('notice', `${arch} DMG has ${apps[0]} version ${shortVersion}`);
    if (!version.startsWith(shortVersion) && shortVersion !== version) {
      throw new Error(`app version ${shortVersion} does not match release ${version}`);
    }
    const binary = path.join(app, 'Contents', 'MacOS', executable);
    const fileInfo = execFileSync('file', [binary]).toString().trim();
    console.log(fileInfo);
    const wantArch = arch === 'arm64' ? 'arm64' : 'x86_64';
    if (!fileInfo.includes(wantArch)) throw new Error(`binary is not ${wantArch}`);
    if (!fs.existsSync(path.join(mount, 'Applications'))) console.warn('warning: DMG has no Applications shortcut');
    try {
      execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
      console.log('codesign: valid');
    } catch (error) {
      console.log(`codesign (advisory): ${(error.stderr || '').toString().trim()}`);
    }
  } finally {
    execFileSync('hdiutil', ['detach', mount, '-force'], { stdio: 'inherit' });
  }
  console.log('macOS update smoke test passed');
  annotate('notice', `${arch} macOS update smoke test passed`);
})().catch(error => {
  console.error(`FAILED: ${error.message}`);
  annotate('error', `${arch}: ${error.message}`);
  process.exit(1);
});
