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

const extractPortableUpdate = (archivePath, destinationPath) => new Promise(resolve => {
  const escapedArchive = archivePath.replace(/'/g, "''");
  const escapedDestination = destinationPath.replace(/'/g, "''");
  const command = `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedDestination}' -Force`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true });
  let output = '';
  child.stderr.on('data', data => { output += data.toString(); });
  child.on('close', code => resolve(code === 0 ? null : (output.trim() || '解压便携版失败。')));
  child.on('error', error => resolve(error.message));
});

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

const installPortableUpdate = async ({ archivePath, updaterDir, targetDirectory = null, currentProcessId = process.pid }) => {
  cleanupStalePortableUpdates(updaterDir);
  const extractPath = path.join(updaterDir, `portable-${Date.now()}`);
  const backupPath = path.join(updaterDir, `backup-${Date.now()}`);
  const resultPath = path.join(updaterDir, 'portable-update-result.json');
  const extraction = await extractPortableUpdate(archivePath, extractPath);
  if (extraction) {
    fs.rmSync(extractPath, { recursive: true, force: true });
    return { ok: false, message: extraction };
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
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
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
      resolve({ ok: true, fallback: !targetDirectory });
    });
  });
};

module.exports = { buildPortableLaunchScript, consumePortableUpdateResult, installPortableUpdate };
