const { spawn } = require('child_process');
const crypto = require('crypto');

const MANIFEST_SIGNATURE_SUFFIX = '.sig';
const ED25519_SIGNATURE_BYTES = 64;

const isUpdatePublicKeyConfigured = publicKeyPem => typeof publicKeyPem === 'string' && publicKeyPem.trim().length > 0;

const loadEd25519PublicKey = publicKeyPem => {
  const key = crypto.createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('更新公钥必须是 Ed25519 公钥。');
  return key;
};

const decodeSignature = signatureBase64 => {
  const text = String(signatureBase64 ?? '').replace(/\s+/g, '');
  if (!text || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  const signature = Buffer.from(text, 'base64');
  return signature.length === ED25519_SIGNATURE_BYTES ? signature : null;
};

// Verifies an Ed25519 signature (base64, raw 64 bytes) over the exact UTF-8
// bytes of the manifest text. Never throws: any malformed input is `false`.
const verifyManifestSignature = (manifestText, signatureBase64, publicKeyPem) => {
  if (typeof manifestText !== 'string' || !isUpdatePublicKeyConfigured(publicKeyPem)) return false;
  const signature = decodeSignature(signatureBase64);
  if (!signature) return false;
  try {
    const key = loadEd25519PublicKey(publicKeyPem);
    return crypto.verify(null, Buffer.from(manifestText, 'utf8'), key, signature);
  } catch {
    return false;
  }
};

// The renderer chooses the checksum asset by name; make sure we always fetch
// the manifest itself and derive its detached signature URL next to it.
const deriveManifestUrls = checksumUrl => {
  const parsed = new URL(checksumUrl);
  if (parsed.pathname.toLowerCase().endsWith(MANIFEST_SIGNATURE_SUFFIX)) {
    parsed.pathname = parsed.pathname.slice(0, -MANIFEST_SIGNATURE_SUFFIX.length);
  }
  parsed.hash = '';
  const manifestUrl = parsed.href;
  const signatureUrl = new URL(parsed.href);
  signatureUrl.pathname = `${signatureUrl.pathname}${MANIFEST_SIGNATURE_SUFFIX}`;
  return { manifestUrl, signatureUrl: signatureUrl.href };
};

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

const normalizeSignatureStatus = value => String(value || '').trim().toLowerCase();

// SHA-256 from the trusted update manifest is the hard integrity check. Windows
// Authenticode is advisory here because portable/unsigned builds and certificates
// that cannot be validated locally otherwise make valid updates unusable.
const classifyWindowsSignature = (status, exitCode) => {
  const normalized = normalizeSignatureStatus(status);
  if (normalized === 'valid') return { status: 'valid', detail: status };
  if (normalized === 'hashmismatch') return { status: 'invalid', detail: status || '签名哈希不匹配' };
  if (normalized === 'notsigned') return { status: 'unavailable', detail: '未签名' };
  return { status: 'unavailable', detail: status || (exitCode === 0 ? '无法验证签名' : '无法读取签名状态') };
};

const verifyUpdateSignature = (filePath, platform = process.platform) => new Promise(resolve => {
  if (platform === 'win32') {
    const escapedPath = filePath.replace(/'/g, "''");
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-AuthenticodeSignature -LiteralPath '${escapedPath}').Status.ToString()`], { windowsHide: true });
    let output = '';
    child.stdout.on('data', data => { output += data.toString(); });
    child.on('close', code => {
      resolve(classifyWindowsSignature(output, code));
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
  // Linux AppImage has no OS-level signature check; it is covered by the
  // SHA-256 from the (Ed25519-signed, when configured) release manifest.
  resolve({ status: 'unavailable', detail: 'Linux AppImage 当前没有统一签名接口' });
});

module.exports = {
  classifyWindowsSignature,
  deriveManifestUrls,
  extractExpectedChecksum,
  isUpdatePublicKeyConfigured,
  loadEd25519PublicKey,
  MANIFEST_SIGNATURE_SUFFIX,
  verifyManifestSignature,
  verifyUpdateSignature,
};
