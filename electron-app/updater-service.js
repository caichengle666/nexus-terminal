const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const escapePowerShellLiteral = value => `'${String(value).replace(/'/g, "''")}'`;

const findPortableExecutable = (directory) => {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === 'nexus terminal.exe') return entryPath;
    if (entry.isDirectory()) {
      const nested = findPortableExecutable(entryPath);
      if (nested) return nested;
    }
  }
  return null;
};

const cleanupStalePortableUpdates = updaterDir => {
  let entries;
  try { entries = fs.readdirSync(updaterDir, { withFileTypes: true }); } catch { return; }
  entries.filter(entry => entry.isDirectory() && entry.name.startsWith('portable-')).forEach(entry => {
    try { fs.rmSync(path.join(updaterDir, entry.name), { recursive: true, force: true }); } catch { /* best effort */ }
  });
};

// -ExecutionPolicy Bypass: the Archive module behind Expand-Archive is a script
// module (.psm1), which a Restricted / AllSigned policy refuses to load.
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
// Error text from PowerShell would otherwise come back in the OEM code page.
const POWERSHELL_UTF8 = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8';
const EXTRACTION_TIMEOUT_MS = 10 * 60 * 1000;

// Absolute path on purpose: a tar.exe from Git / MSYS earlier on PATH is GNU tar,
// which cannot read ZIP files.
const getWindowsTarPath = (env = process.env) => path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'tar.exe');

// Ordered fastest first. Expand-Archive used to be the only method: on Windows
// PowerShell 5.1 it needs minutes for the ~470 MB / thousands-of-files portable
// build, and the UI looked dead the whole time.
const buildExtractionCommands = ({ archivePath, destinationPath, env = process.env }) => {
  const archive = escapePowerShellLiteral(archivePath);
  const destination = escapePowerShellLiteral(destinationPath);
  return [
    // bsdtar, built into Windows 10 1803+ / Windows 11, reads ZIP natively.
    { method: 'tar', file: getWindowsTarPath(env), args: ['-xf', archivePath, '-C', destinationPath], requiresFile: true },
    {
      method: 'dotnet-zipfile',
      file: 'powershell.exe',
      args: [...POWERSHELL_ARGS, '-Command', [
        POWERSHELL_UTF8,
        '$ErrorActionPreference = "Stop"',
        'Add-Type -AssemblyName System.IO.Compression.FileSystem',
        `[System.IO.Compression.ZipFile]::ExtractToDirectory(${archive}, ${destination})`,
      ].join('; ')],
    },
    {
      method: 'expand-archive',
      file: 'powershell.exe',
      args: [...POWERSHELL_ARGS, '-Command', [
        POWERSHELL_UTF8,
        '$ErrorActionPreference = "Stop"',
        // The progress bar alone makes Expand-Archive several times slower.
        '$ProgressPreference = "SilentlyContinue"',
        `Expand-Archive -LiteralPath ${archive} -DestinationPath ${destination} -Force`,
      ].join('; ')],
    },
  ];
};

const runExtractionCommand = (command, { spawnImpl = spawn, timeoutMs = EXTRACTION_TIMEOUT_MS } = {}) => new Promise(resolve => {
  let child;
  try {
    child = spawnImpl(command.file, command.args, { windowsHide: true });
  } catch (error) {
    resolve(error.message);
    return;
  }
  let output = '';
  let settled = false;
  const finish = value => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(value);
  };
  const timer = setTimeout(() => {
    try { child.kill(); } catch { /* already gone */ }
    finish(`解压超时（${Math.round(timeoutMs / 60000)} 分钟）。`);
  }, timeoutMs);
  child.stderr?.on('data', data => { output += data.toString(); });
  child.on('close', code => finish(code === 0 ? null : (output.trim() || `退出码 ${code}`)));
  child.on('error', error => finish(error.message));
});

/**
 * Extracts the portable ZIP, trying tar.exe, then .NET ZipFile, then Expand-Archive.
 * Each attempt starts from an empty destination. Resolves { ok, method } or
 * { ok: false, message } with every attempt's error.
 */
const extractPortableUpdate = async (archivePath, destinationPath, {
  spawnImpl = spawn,
  existsImpl = fs.existsSync,
  env = process.env,
  timeoutMs = EXTRACTION_TIMEOUT_MS,
  onAttempt = null,
} = {}) => {
  const errors = [];
  for (const command of buildExtractionCommands({ archivePath, destinationPath, env })) {
    if (command.requiresFile && !existsImpl(command.file)) continue;
    try {
      fs.rmSync(destinationPath, { recursive: true, force: true });
      fs.mkdirSync(destinationPath, { recursive: true });
    } catch (error) {
      return { ok: false, message: `无法准备解压目录：${error.message}` };
    }
    onAttempt?.(command.method);
    const error = await runExtractionCommand(command, { spawnImpl, timeoutMs });
    if (!error) return { ok: true, method: command.method };
    console.warn(`[Updater] Portable extraction via ${command.method} failed: ${error}`);
    errors.push(`${command.method}: ${error}`);
  }
  return { ok: false, message: `解压便携版失败。${errors.join('；')}` };
};

const buildPortableLaunchScript = ({ currentProcessId, executable, extractPath, targetDirectory, backupPath, resultPath }) => {
  const sourceDirectory = path.dirname(executable);
  const targetExecutable = targetDirectory
    ? path.join(targetDirectory, path.basename(executable))
    : executable;
  const commands = [
    '$ErrorActionPreference = "Stop"',
    `$currentProcess = Get-Process -Id ${Number(currentProcessId)} -ErrorAction SilentlyContinue`,
    'if ($currentProcess) { Wait-Process -Id $currentProcess.Id }',
  ];
  if (targetDirectory) {
    // The main process exiting is not enough: the bundled backend node.exe,
    // Electron helper processes and the ConPTY host also run from this folder
    // and keep files locked for a moment, which made Remove-Item fail and the
    // update roll back. Wait (bounded) until nothing runs from it any more.
    const targetPrefix = `${String(targetDirectory).replace(/[\\/]+$/, '')}\\`;
    commands.push(
      `$targetPrefix = ${escapePowerShellLiteral(targetPrefix)}`,
      '$waitDeadline = (Get-Date).AddSeconds(30)',
      // Best effort: a process whose Path cannot be read must not abort the update.
      'try { while ((Get-Date) -lt $waitDeadline -and (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $PID -and $_.Path -and $_.Path.StartsWith($targetPrefix, [System.StringComparison]::OrdinalIgnoreCase) })) { Start-Sleep -Milliseconds 500 } } catch { }',
    );
    commands.push(
      `$preservedNames = @('userData', 'data', '.Portable')`,
      `try {`,
      `New-Item -ItemType Directory -Path ${escapePowerShellLiteral(backupPath)} -Force | Out-Null`,
      `$currentItems = Get-ChildItem -LiteralPath ${escapePowerShellLiteral(targetDirectory)} -Force | Where-Object { $_.Name -notin $preservedNames }`,
      `$currentItems | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination ${escapePowerShellLiteral(backupPath)} -Recurse -Force }`,
      `$currentItems | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }`,
      `$sourceItems = Get-ChildItem -LiteralPath ${escapePowerShellLiteral(sourceDirectory)} -Force | Where-Object { $_.Name -notin @('userData', 'data') }`,
      `$sourceItems | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination ${escapePowerShellLiteral(targetDirectory)} -Recurse -Force }`,
      `$result = @{ status = 'success'; message = '便携版更新成功'; backupPath = ${escapePowerShellLiteral(backupPath)}; extractPath = ${escapePowerShellLiteral(extractPath)} }`,
      `$result | ConvertTo-Json -Compress | Set-Content -LiteralPath ${escapePowerShellLiteral(resultPath)} -Encoding UTF8`,
      `$newProcess = Start-Process -FilePath ${escapePowerShellLiteral(targetExecutable)} -WorkingDirectory ${escapePowerShellLiteral(path.dirname(targetExecutable))} -PassThru`,
      `} catch {`,
      `$updateError = $_.Exception.Message`,
      `try {`,
      `Get-ChildItem -LiteralPath ${escapePowerShellLiteral(targetDirectory)} -Force | Where-Object { $_.Name -notin $preservedNames } | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }`,
      `Get-ChildItem -LiteralPath ${escapePowerShellLiteral(backupPath)} -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination ${escapePowerShellLiteral(targetDirectory)} -Recurse -Force }`,
      `$result = @{ status = 'rolled-back'; message = $updateError; backupPath = ${escapePowerShellLiteral(backupPath)}; extractPath = ${escapePowerShellLiteral(extractPath)} }`,
      `$result | ConvertTo-Json -Compress | Set-Content -LiteralPath ${escapePowerShellLiteral(resultPath)} -Encoding UTF8`,
      `Start-Process -FilePath ${escapePowerShellLiteral(targetExecutable)} -WorkingDirectory ${escapePowerShellLiteral(path.dirname(targetExecutable))} | Out-Null`,
      `} catch {`,
      `$result = @{ status = 'failed'; message = ($updateError + '; 回滚失败: ' + $_.Exception.Message); backupPath = ${escapePowerShellLiteral(backupPath)}; extractPath = ${escapePowerShellLiteral(extractPath)} }`,
      `}`,
      `if ($result.status -eq 'failed') { $result | ConvertTo-Json -Compress | Set-Content -LiteralPath ${escapePowerShellLiteral(resultPath)} -Encoding UTF8 }`,
      `}`,
    );
  } else {
    commands.push(
      `$newProcess = Start-Process -FilePath ${escapePowerShellLiteral(targetExecutable)} -WorkingDirectory ${escapePowerShellLiteral(path.dirname(targetExecutable))} -PassThru`,
      `$cleanupScript = 'Wait-Process -Id ' + $newProcess.Id + ' -ErrorAction SilentlyContinue; Remove-Item -LiteralPath ' + ${escapePowerShellLiteral(extractPath)} + ' -Recurse -Force -ErrorAction SilentlyContinue`,
      `Start-Process powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-WindowStyle','Hidden','-Command',$cleanupScript -WindowStyle Hidden`,
    );
  }
  return commands.join('; ');
};

// The portable ZIP may only replace a portable copy. For an installed (NSIS)
// copy, "falling back" to the ZIP used to start an unrelated portable instance
// from %TEMP% with its own, empty data folder (and delete it afterwards), which
// looked like the update had wiped the user's data.
const shouldUsePortableFallback = ({ platform, installationKind, primaryFilename, fallbackUrl }) => (
  platform === 'win32'
  && installationKind === 'portable'
  && typeof fallbackUrl === 'string'
  && fallbackUrl.length > 0
  && !/\.zip$/i.test(String(primaryFilename || ''))
);

const consumePortableUpdateResult = updaterDir => {
  const resultPath = path.join(updaterDir, 'portable-update-result.json');
  let result;
  try {
    result = JSON.parse(fs.readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
  try { fs.rmSync(resultPath, { force: true }); } catch { /* best effort */ }
  const updaterRoot = path.resolve(updaterDir);
  for (const candidate of [result.backupPath, result.extractPath]) {
    if (typeof candidate !== 'string') continue;
    const resolved = path.resolve(candidate);
    if (resolved !== updaterRoot && resolved.startsWith(`${updaterRoot}${path.sep}`)) {
      try { fs.rmSync(resolved, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
  return result;
};

const installPortableUpdate = async ({ archivePath, updaterDir, targetDirectory = null, currentProcessId = process.pid, onStage = null, spawnImpl = spawn }) => {
  cleanupStalePortableUpdates(updaterDir);
  const extractPath = path.join(updaterDir, `portable-${Date.now()}`);
  const backupPath = path.join(updaterDir, `backup-${Date.now()}`);
  const resultPath = path.join(updaterDir, 'portable-update-result.json');
  onStage?.('extracting');
  const extraction = await extractPortableUpdate(archivePath, extractPath, { spawnImpl });
  if (!extraction.ok) {
    fs.rmSync(extractPath, { recursive: true, force: true });
    return { ok: false, message: extraction.message };
  }
  const executable = findPortableExecutable(extractPath);
  if (!executable) {
    fs.rmSync(extractPath, { recursive: true, force: true });
    return { ok: false, message: '便携版解压成功，但找不到 Nexus Terminal.exe。' };
  }
  return new Promise(resolve => {
    const launchScript = buildPortableLaunchScript({
      currentProcessId,
      executable,
      extractPath,
      targetDirectory,
      backupPath,
      resultPath,
    });
    const child = spawnImpl('powershell.exe', [
      ...POWERSHELL_ARGS,
      '-WindowStyle',
      'Hidden',
      '-Command',
      launchScript,
    ], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.once('error', error => {
      fs.rmSync(extractPath, { recursive: true, force: true });
      resolve({ ok: false, message: `准备启动便携版失败：${error.message}` });
    });
    child.once('spawn', () => {
      child.unref();
      resolve({ ok: true, fallback: !targetDirectory, method: extraction.method });
    });
  });
};

module.exports = {
  buildExtractionCommands,
  buildPortableLaunchScript,
  consumePortableUpdateResult,
  extractPortableUpdate,
  getWindowsTarPath,
  installPortableUpdate,
  shouldUsePortableFallback,
};
