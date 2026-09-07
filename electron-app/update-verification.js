const { spawn } = require('child_process');

const normalizeReleaseFilename = value => value.trim().toLowerCase().replace(/[.\s]+/g, '.');

const extractExpectedChecksum = (text, filename) => {
  const normalizedFilename = normalizeReleaseFilename(filename);
  const matches = text.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+?)\s*$/i);
    if (!match || normalizeReleaseFilename(match[2]) !== normalizedFilename) return [];
    return [match[1].toLowerCase()];
  });
  return matches.length === 1 ? matches[0] : null;
};

const verifyUpdateSignature = (filePath, platform = process.platform) => new Promise(resolve => {
  if (platform === 'win32') {
    const escapedPath = filePath.replace(/'/g, "''");
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-AuthenticodeSignature -LiteralPath '${escapedPath}').Status.ToString()`], { windowsHide: true });
    let output = '';
    child.stdout.on('data', data => { output += data.toString(); });
    child.on('close', code => {
      const status = output.trim();
      if (status === 'Valid') return resolve({ status: 'valid', detail: status });
      if (status === 'NotSigned' || code !== 0) return resolve({ status: 'unavailable', detail: status || '无法读取签名状态' });
      return resolve({ status: 'invalid', detail: status || '签名校验失败' });
    });
    child.on('error', error => resolve({ status: 'unavailable', detail: error.message }));
    return;
  }
  if (platform === 'darwin') {
    const child = spawn('spctl', ['--assess', '--type', 'install', '--verbose', filePath], { windowsHide: true });
    let output = '';
    child.stdout.on('data', data => { output += data.toString(); });
    child.stderr.on('data', data => { output += data.toString(); });
    child.on('close', code => {
      const accepted = code === 0;
      resolve({ status: accepted ? 'valid' : 'invalid', detail: accepted ? 'Gatekeeper 验证通过' : '系统未能验证安装包签名' });
    });
    child.on('error', error => resolve({ status: 'unavailable', detail: error.message }));
    return;
  }
  resolve({ status: 'unavailable', detail: 'Linux AppImage 当前没有统一签名接口' });
});

module.exports = { extractExpectedChecksum, verifyUpdateSignature };
