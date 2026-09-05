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

const installPortableUpdate = async ({ archivePath, updaterDir, currentProcessId = process.pid }) => {
  const extractPath = path.join(updaterDir, `portable-${Date.now()}`);
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
    const launchScript = [
      '$ErrorActionPreference = "Stop"',
      `$currentProcess = Get-Process -Id ${Number(currentProcessId)} -ErrorAction SilentlyContinue`,
      'if ($currentProcess) { Wait-Process -Id $currentProcess.Id }',
      `Start-Process -FilePath ${escapePowerShellLiteral(executable)} -WorkingDirectory ${escapePowerShellLiteral(path.dirname(executable))}`,
    ].join('; ');
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
      resolve({ ok: true, fallback: true });
    });
  });
};

module.exports = { installPortableUpdate };
