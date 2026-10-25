const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  buildExtractionCommands,
  extractPortableUpdate,
  getWindowsTarPath,
  installPortableUpdate,
} = require('../updater-service');
const { MESSAGES } = require('../main-i18n');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-extract-test-'));

// Fake child_process.spawn: `behaviours` is consumed in call order; each one
// decides how that child ends ({ code, stderr } | { error } | 'hang' | 'spawn').
const createFakeSpawn = (behaviours, { onSpawn } = {}) => {
  const calls = [];
  const spawnImpl = (file, args, options) => {
    const behaviour = behaviours[calls.length] ?? { code: 0 };
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    child.unref = () => {};
    calls.push({ file, args, options, child });
    onSpawn?.(file, args, calls.length - 1);
    setImmediate(() => {
      if (behaviour === 'hang') return;
      if (behaviour === 'spawn') { child.emit('spawn'); return; }
      if (behaviour.error) { child.emit('error', new Error(behaviour.error)); return; }
      if (behaviour.stderr) child.stderr.emit('data', Buffer.from(behaviour.stderr));
      child.emit('close', behaviour.code ?? 0);
    });
    return child;
  };
  return { spawnImpl, calls };
};

test('tar.exe is resolved from System32, never from PATH (Git ships GNU tar without ZIP support)', () => {
  assert.equal(getWindowsTarPath({ SystemRoot: 'D:\\WINDOWS' }), 'D:\\WINDOWS\\System32\\tar.exe');
  assert.equal(getWindowsTarPath({ windir: 'E:\\Win' }), 'E:\\Win\\System32\\tar.exe');
  assert.equal(getWindowsTarPath({}), 'C:\\Windows\\System32\\tar.exe');
});

test('extraction prefers tar.exe, then .NET ZipFile, then Expand-Archive', () => {
  const commands = buildExtractionCommands({
    archivePath: "C:\\Temp\\it's\\update.zip",
    destinationPath: 'C:\\Temp\\portable-1',
    env: { SystemRoot: 'C:\\Windows' },
  });
  assert.deepEqual(commands.map(command => command.method), ['tar', 'dotnet-zipfile', 'expand-archive']);
  assert.equal(commands[0].file, 'C:\\Windows\\System32\\tar.exe');
  assert.deepEqual(commands[0].args, ['-xf', "C:\\Temp\\it's\\update.zip", '-C', 'C:\\Temp\\portable-1']);
  for (const command of commands.slice(1)) {
    assert.equal(command.file, 'powershell.exe');
    // Execution policy must not be able to block the Archive module / the command.
    assert.ok(command.args.includes('-ExecutionPolicy'));
    assert.equal(command.args[command.args.indexOf('-ExecutionPolicy') + 1], 'Bypass');
    const script = command.args[command.args.length - 1];
    // Single quotes in paths are doubled inside PowerShell literals.
    assert.match(script, /'C:\\Temp\\it''s\\update\.zip'/);
    assert.match(script, /\$ErrorActionPreference = "Stop"/);
  }
  assert.match(commands[1].args.at(-1), /\[System\.IO\.Compression\.ZipFile\]::ExtractToDirectory\(/);
  assert.match(commands[2].args.at(-1), /\$ProgressPreference = "SilentlyContinue"; Expand-Archive -LiteralPath/);
});

test('a working tar.exe is the only extraction attempt', async () => {
  const dir = tmpDir();
  const { spawnImpl, calls } = createFakeSpawn([{ code: 0 }]);
  const attempts = [];
  const result = await extractPortableUpdate(path.join(dir, 'u.zip'), path.join(dir, 'out'), {
    spawnImpl, existsImpl: () => true, env: { SystemRoot: 'C:\\Windows' }, onAttempt: method => attempts.push(method),
  });
  assert.deepEqual(result, { ok: true, method: 'tar' });
  assert.equal(calls.length, 1);
  assert.deepEqual(attempts, ['tar']);
  assert.ok(fs.existsSync(path.join(dir, 'out')), 'tar -C needs the destination to exist');
  assert.equal(calls[0].options.windowsHide, true);
});

test('without tar.exe (older Windows 10) the .NET ZipFile method runs first', async () => {
  const dir = tmpDir();
  const { spawnImpl, calls } = createFakeSpawn([{ code: 0 }]);
  const result = await extractPortableUpdate(path.join(dir, 'u.zip'), path.join(dir, 'out'), { spawnImpl, existsImpl: () => false });
  assert.deepEqual(result, { ok: true, method: 'dotnet-zipfile' });
  assert.equal(calls[0].file, 'powershell.exe');
});

test('failed attempts fall through and each one starts from an empty destination', async () => {
  const dir = tmpDir();
  const destination = path.join(dir, 'out');
  const leftovers = [];
  const { spawnImpl, calls } = createFakeSpawn([
    { code: 1, stderr: 'tar: Unrecognized archive format' },
    { error: 'spawn powershell.exe ENOENT' },
    { code: 0 },
  ], {
    onSpawn: (_file, _args, index) => {
      leftovers.push(fs.readdirSync(destination));
      fs.writeFileSync(path.join(destination, `partial-${index}`), 'x');
    },
  });
  const result = await extractPortableUpdate(path.join(dir, 'u.zip'), destination, { spawnImpl, existsImpl: () => true });
  assert.deepEqual(result, { ok: true, method: 'expand-archive' });
  assert.equal(calls.length, 3);
  assert.deepEqual(leftovers, [[], [], []]);
});

test('when every method fails the error names all of them', async () => {
  const dir = tmpDir();
  const { spawnImpl } = createFakeSpawn([
    { code: 1, stderr: 'tar broke' },
    { code: 1, stderr: 'zipfile broke' },
    { code: 1 },
  ]);
  const result = await extractPortableUpdate(path.join(dir, 'u.zip'), path.join(dir, 'out'), { spawnImpl, existsImpl: () => true });
  assert.equal(result.ok, false);
  assert.match(result.message, /tar: tar broke/);
  assert.match(result.message, /dotnet-zipfile: zipfile broke/);
  assert.match(result.message, /expand-archive: 退出码 1/);
});

test('a hung extraction is killed after the timeout instead of waiting forever', async () => {
  const dir = tmpDir();
  const { spawnImpl, calls } = createFakeSpawn(['hang', 'hang', 'hang']);
  const result = await extractPortableUpdate(path.join(dir, 'u.zip'), path.join(dir, 'out'), { spawnImpl, existsImpl: () => true, timeoutMs: 20 });
  assert.equal(result.ok, false);
  assert.match(result.message, /解压超时/);
  assert.ok(calls.every(call => call.child.killed));
});

test('installPortableUpdate reports the extracting stage and starts the swap script with Bypass, detached', async () => {
  const dir = tmpDir();
  const stages = [];
  const { spawnImpl, calls } = createFakeSpawn([{ code: 0 }, 'spawn'], {
    onSpawn: (_file, args, index) => {
      if (index !== 0) return;
      // Simulate the extracted portable build (electron-builder's win-unpacked layout).
      const destination = args[args.indexOf('-C') + 1];
      fs.mkdirSync(path.join(destination, 'win-unpacked'), { recursive: true });
      fs.writeFileSync(path.join(destination, 'win-unpacked', 'Nexus Terminal.exe'), '');
    },
  });
  const originalExists = fs.existsSync;
  fs.existsSync = file => (/tar\.exe$/i.test(String(file)) ? true : originalExists(file));
  try {
    const result = await installPortableUpdate({
      archivePath: path.join(dir, 'Nexus.Terminal.Portable.win-unpacked.zip'),
      updaterDir: dir,
      targetDirectory: 'D:\\Apps\\Nexus Terminal',
      currentProcessId: 4242,
      onStage: stage => stages.push(stage),
      spawnImpl,
    });
    assert.deepEqual(result, { ok: true, fallback: false, method: 'tar' });
  } finally {
    fs.existsSync = originalExists;
  }
  assert.deepEqual(stages, ['extracting']);
  assert.equal(calls.length, 2);
  const launch = calls[1];
  assert.equal(launch.file, 'powershell.exe');
  assert.equal(launch.args[launch.args.indexOf('-ExecutionPolicy') + 1], 'Bypass');
  assert.equal(launch.options.detached, true);
  assert.match(launch.args.at(-1), /Get-Process -Id 4242/);
});

test('installPortableUpdate returns a readable failure when the ZIP has no Nexus Terminal.exe', async () => {
  const dir = tmpDir();
  const { spawnImpl, calls } = createFakeSpawn([{ code: 0 }]);
  const originalExists = fs.existsSync;
  fs.existsSync = file => (/tar\.exe$/i.test(String(file)) ? true : originalExists(file));
  let result;
  try {
    result = await installPortableUpdate({ archivePath: path.join(dir, 'u.zip'), updaterDir: dir, targetDirectory: 'D:\\x', spawnImpl });
  } finally {
    fs.existsSync = originalExists;
  }
  assert.equal(result.ok, false);
  assert.match(result.message, /找不到 Nexus Terminal\.exe/);
  assert.equal(calls.length, 1, 'no swap script without an executable');
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.startsWith('portable-')), []);
});

test('install-update quits for real, shows failures natively and can reveal the download', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const quit = source.slice(source.indexOf('const quitForUpdate = () => {'), source.indexOf('const relaunchApp = () => {'));
  assert.ok(quit.indexOf('isQuitting = true') < quit.indexOf('app.quit()'), 'isQuitting must be set before app.quit (close-to-tray)');
  assert.match(quit, /app\.exit\(0\)/);
  const handler = source.slice(source.indexOf("handleTrusted('install-update'"), source.indexOf("handleTrusted('install-update'") + 6000);
  assert.doesNotMatch(handler, /setTimeout\(\(\) => app\.quit\(\)/);
  assert.match(handler, /setTimeout\(quitForUpdate/);
  assert.match(handler, /showUpdateInstallError\(result\.message/);
  assert.match(handler, /sendInstallStage\('extracting'/);
  assert.match(handler, /shell\.showItemInFolder\(updatePath\)/);
  assert.match(source, /handleTrusted\('show-update-file'/);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(preload, /showUpdateFile: \(\) => ipcRenderer\.invoke\('show-update-file'\)/);
});

test('new update dialog strings exist in every main-process language', () => {
  const keys = ['ok', 'updateShowFile', 'updateFileLocation', 'updateFileMissing', 'updateExtracting', 'updateRestarting', 'updateInstallFailedTitle', 'updateInstallFailedMessage'];
  for (const locale of Object.keys(MESSAGES)) {
    for (const key of keys) assert.ok(MESSAGES[locale][key], `${locale}.${key}`);
    assert.deepEqual(Object.keys(MESSAGES[locale]).sort(), Object.keys(MESSAGES.zh).sort(), locale);
  }
});
