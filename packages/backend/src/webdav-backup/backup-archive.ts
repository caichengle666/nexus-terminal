import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';

const archiver = require('archiver');

export const FULL_BACKUP_MAGIC = Buffer.from('NEXUS-FULL-BACKUP-V2\n', 'utf8');
export const MIN_BACKUP_PASSPHRASE_LENGTH = 8;

const ARCHIVE_VERSION = 2;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };

export interface FullBackupManifest {
  format: 'nexus-terminal-full-backup';
  version: number;
  createdAt: string;
  root: 'data';
  fileCount: number;
}

export interface FullBackupArchive {
  buffer: Buffer;
  fileCount: number;
}

export interface ExtractedFullBackup {
  dataPath: string;
  manifest: FullBackupManifest;
}

function validatePassphrase(passphrase: string): void {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_BACKUP_PASSPHRASE_LENGTH) {
    throw new Error(`备份密码至少需要 ${MIN_BACKUP_PASSPHRASE_LENGTH} 个字符。`);
  }
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  validatePassphrase(passphrase);
  return crypto.scryptSync(passphrase, salt, KEY_LENGTH, SCRYPT_OPTIONS);
}

function encryptArchive(archiveBuffer: Buffer, passphrase: string): Buffer {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(archiveBuffer), cipher.final()]);
  const header = Buffer.from(`${JSON.stringify({
    version: ARCHIVE_VERSION,
    algorithm: 'aes-256-gcm',
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  })}\n`, 'utf8');

  return Buffer.concat([FULL_BACKUP_MAGIC, header, ciphertext]);
}

function decryptArchive(buffer: Buffer, passphrase: string): Buffer {
  if (!buffer.subarray(0, FULL_BACKUP_MAGIC.length).equals(FULL_BACKUP_MAGIC)) {
    throw new Error('不是受支持的完整备份文件。');
  }
  validatePassphrase(passphrase);

  const headerEnd = buffer.indexOf(0x0a, FULL_BACKUP_MAGIC.length);
  if (headerEnd < 0) throw new Error('完整备份文件头损坏。');

  let header: any;
  try {
    header = JSON.parse(buffer.subarray(FULL_BACKUP_MAGIC.length, headerEnd).toString('utf8'));
  } catch {
    throw new Error('完整备份文件头无效。');
  }

  if (header.version !== ARCHIVE_VERSION || header.algorithm !== 'aes-256-gcm' || header.kdf !== 'scrypt') {
    throw new Error('完整备份文件版本不受支持。');
  }

  const salt = Buffer.from(header.salt || '', 'base64');
  const iv = Buffer.from(header.iv || '', 'base64');
  const authTag = Buffer.from(header.authTag || '', 'base64');
  if (salt.length !== SALT_LENGTH || iv.length !== IV_LENGTH || authTag.length !== 16) {
    throw new Error('完整备份文件加密参数无效。');
  }

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(buffer.subarray(headerEnd + 1)),
      decipher.final(),
    ]);
  } catch {
    throw new Error('备份密码错误，或备份文件已损坏。');
  }
}

function collectFiles(rootPath: string): string[] {
  const files: string[] = [];
  const visit = (currentPath: string): void => {
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  };

  if (!fs.existsSync(rootPath)) throw new Error('应用数据目录不存在。');
  visit(rootPath);
  return files;
}

export async function createFullBackup(dataPath: string, passphrase: string): Promise<FullBackupArchive> {
  validatePassphrase(passphrase);
  const files = collectFiles(dataPath);
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-full-backup-'));
  const zipPath = path.join(temporaryDirectory, 'nexus-full-backup.zip');
  const manifest: FullBackupManifest = {
    format: 'nexus-terminal-full-backup',
    version: ARCHIVE_VERSION,
    createdAt: new Date().toISOString(),
    root: 'data',
    fileCount: files.length,
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);
      archive.pipe(output);
      archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
      for (const filePath of files) {
        const relativePath = path.relative(dataPath, filePath).split(path.sep).join('/');
        archive.file(filePath, { name: `data/${relativePath}` });
      }
      archive.finalize();
    });

    return { buffer: encryptArchive(fs.readFileSync(zipPath), passphrase), fileCount: files.length };
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function ensureSafeArchivePath(rootPath: string, archivePath: string): string {
  const normalizedPath = archivePath.replace(/\\/g, '/');
  if (!normalizedPath || normalizedPath.startsWith('/') || /^[A-Za-z]:/.test(normalizedPath)) {
    throw new Error('备份文件包含不安全的路径。');
  }
  const destination = path.resolve(rootPath, ...normalizedPath.split('/'));
  const relativePath = path.relative(rootPath, destination);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('备份文件包含越界路径。');
  }
  return destination;
}

export function extractFullBackup(buffer: Buffer, passphrase: string, extractRoot: string): ExtractedFullBackup {
  const archive = new AdmZip(decryptArchive(buffer, passphrase));
  const manifestEntry = archive.getEntry('manifest.json');
  if (!manifestEntry) throw new Error('完整备份中缺少 manifest.json。');

  let manifest: FullBackupManifest;
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf8')) as FullBackupManifest;
  } catch {
    throw new Error('完整备份清单无效。');
  }
  if (manifest.format !== 'nexus-terminal-full-backup' || manifest.version !== ARCHIVE_VERSION || manifest.root !== 'data') {
    throw new Error('完整备份格式或版本不受支持。');
  }

  fs.mkdirSync(extractRoot, { recursive: true });
  let extractedFileCount = 0;
  for (const entry of archive.getEntries()) {
    const entryPath = entry.entryName.replace(/\\/g, '/');
    if (entryPath === 'manifest.json') continue;
    if (!entryPath.startsWith('data/')) throw new Error('完整备份包含未知顶层路径。');

    const destination = ensureSafeArchivePath(extractRoot, entryPath);
    if (entry.isDirectory) {
      fs.mkdirSync(destination, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, entry.getData());
    extractedFileCount += 1;
  }

  if (extractedFileCount !== manifest.fileCount) {
    throw new Error('完整备份文件数量与清单不一致。');
  }

  const dataPath = path.join(extractRoot, 'data');
  if (!fs.existsSync(dataPath)) throw new Error('完整备份中缺少 data 目录。');
  return { dataPath, manifest };
}

export function isFullBackupBuffer(buffer: Buffer): boolean {
  return buffer.subarray(0, FULL_BACKUP_MAGIC.length).equals(FULL_BACKUP_MAGIC);
}
