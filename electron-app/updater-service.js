const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const findPortableExecutable = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
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

const installPortableUpdate = async ({ archivePath, updaterDir, shell }) => {
  const extractPath = path.join(updaterDir, `portable-${Date.now()}`);
  const extraction = await extractPortableUpdate(archivePath, extractPath);
  if (extraction) return { ok: false, message: extraction };
  const executable = findPortableExecutable(extractPath);
  if (!executable) return { ok: false, message: '便携版解压成功，但找不到 Nexus Terminal.exe。' };
  const error = await shell.openPath(executable);
  if (error) return { ok: false, message: error };
  return { ok: true, fallback: true };
};

module.exports = { installPortableUpdate };
