import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';

import { ZipArchive } from 'archiver';
import { RESTORE_RESERVED_DIR } from './pending-restore';

export const FULL_BACKUP_MAGIC = Buffer.from('NEXUS-FULL-BACKUP-V2\n', 'utf8');
export const MIN_BACKUP_PASSPHRASE_LENGTH = 8;

const ARCHIVE_VERSION = 2;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };
const MAX_BACKUP_FILE_COUNT = 100_000;
const MAX_BACKUP_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_BACKUP_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;

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

/**
 * 不进入完整备份的顶层目录：都是运行期的临时数据，恢复它们没有意义甚至有害
 * （例如把旧的登录会话一起还原回来）；它们也会被定期清理，打包途中被删掉会让备份失败。
 */
export const TRANSIENT_TOP_LEVEL_DIRS: ReadonlySet<string> = new Set([
  RESTORE_RESERVED_DIR,
  'sessions',                 // express-session 文件
  'temp_suspended_ssh_logs',  // 挂起会话的临时日志
  'temp-uploads',             // 上传中转
]);

/** 实时数据库文件名（data 根目录下）。备份时用 VACUUM INTO 生成的快照代替。 */
export const DATABASE_FILE_NAME = 'nexus-terminal.db';

const TRANSIENT_FILE_PATTERN = /(?:\.part|\.tmp)$/i;
const DATABASE_SIDE_FILES = new Set([`${DATABASE_FILE_NAME}-journal`, `${DATABASE_FILE_NAME}-wal`, `${DATABASE_FILE_NAME}-shm`]);

/** 归档内的相对路径（data/ 之后的部分，用 / 分隔）是否属于临时数据。 */
export function isTransientBackupPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  const [top] = normalized.split('/');
  if (TRANSIENT_TOP_LEVEL_DIRS.has(top)) return true;
  if (!normalized.includes('/') && DATABASE_SIDE_FILES.has(normalized)) return true;
  return TRANSIENT_FILE_PATTERN.test(normalized);
}

const isMissingFileError = (error: any): boolean => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';

function collectFiles(rootPath: string): string[] {
  const files: string[] = [];
  const visit = (currentPath: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch (error) {
      if (isMissingFileError(error)) return; // 目录在遍历途中被删除
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (isTransientBackupPath(path.relative(rootPath, entryPath))) continue;
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

export interface CreateFullBackupOptions {
  /**
   * 数据库一致性快照（VACUUM INTO 生成）。提供时代替 data 根目录下正在写入的实时数据库文件。
   */
  databaseSnapshotPath?: string;
}

/** 打开文件；文件在列出之后被删除时返回 null。 */
function openIfExists(filePath: string): number | null {
  try {
    return fs.openSync(filePath, 'r');
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

export async function createFullBackup(dataPath: string, passphrase: string, options: CreateFullBackupOptions = {}): Promise<FullBackupArchive> {
  validatePassphrase(passphrase);
  const liveDatabasePath = path.join(dataPath, DATABASE_FILE_NAME);
  const files = collectFiles(dataPath).filter(filePath => !(options.databaseSnapshotPath && filePath === liveDatabasePath));
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-full-backup-'));
  const zipPath = path.join(temporaryDirectory, 'nexus-full-backup.zip');
  let fileCount = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let signalAborted: () => void = () => {};
      const aborted = new Promise<void>(resolveAbort => { signalAborted = resolveAbort; });
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        signalAborted();
        archive.abort();
        output.destroy();
        reject(error);
      };
      const output = fs.createWriteStream(zipPath);
      const archive = new ZipArchive({ zlib: { level: 9 } });
      output.on('close', () => { if (!settled) { settled = true; resolve(); } });
      output.on('error', fail);
      archive.on('error', fail);
      archive.on('warning', (warning: any) => {
        if (isMissingFileError(warning)) {
          console.warn(`[WebDAV Backup] 打包时文件已不存在，已跳过: ${warning?.path || warning?.message}`);
          return;
        }
        fail(warning);
      });
      archive.pipe(output);

      // 逐个追加：前一个条目写完才打开下一个文件，避免同时打开大量文件句柄；
      // 文件一旦打开，之后被删除也不影响读取（Windows 上打开的文件无法删除）。
      const appendSequentially = async () => {
        const sources: Array<{ filePath: string; name: string }> = files.map(filePath => ({
          filePath,
          name: `data/${path.relative(dataPath, filePath).split(path.sep).join('/')}`,
        }));
        if (options.databaseSnapshotPath) {
          sources.push({ filePath: options.databaseSnapshotPath, name: `data/${DATABASE_FILE_NAME}` });
        }
        for (const source of sources) {
          if (settled) return;
          const fd = openIfExists(source.filePath);
          if (fd === null) {
            console.warn(`[WebDAV Backup] 打包时文件已不存在，已跳过: ${source.filePath}`);
            continue;
          }
          const written = new Promise<void>(resolveEntry => {
            const onEntry = (entry: any) => {
              if (entry?.name === source.name) {
                archive.off('entry', onEntry);
                resolveEntry();
              }
            };
            archive.on('entry', onEntry);
          });
          archive.append(fs.createReadStream('', { fd, autoClose: true }), { name: source.name });
          await Promise.race([written, aborted]);
          fileCount += 1;
        }
        if (settled) return;
        const manifest: FullBackupManifest = {
          format: 'nexus-terminal-full-backup',
          version: ARCHIVE_VERSION,
          createdAt: new Date().toISOString(),
          root: 'data',
          fileCount,
        };
        archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
        await archive.finalize();
      };
      appendSequentially().catch(fail);
    });

    return { buffer: encryptArchive(fs.readFileSync(zipPath), passphrase), fileCount };
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
  if (!Number.isSafeInteger(manifest.fileCount) || manifest.fileCount < 0 || manifest.fileCount > MAX_BACKUP_FILE_COUNT) {
    throw new Error('完整备份文件数量无效或超过安全限制。');
  }

  fs.mkdirSync(extractRoot, { recursive: true });
  let extractedFileCount = 0;
  let extractedBytes = 0;
  const entries = archive.getEntries();
  if (entries.length > MAX_BACKUP_FILE_COUNT + 1) {
    throw new Error('完整备份条目数量超过安全限制。');
  }
  for (const entry of entries) {
    const entryPath = entry.entryName.replace(/\\/g, '/');
    if (entryPath === 'manifest.json') continue;
    if (!entryPath.startsWith('data/')) throw new Error('完整备份包含未知顶层路径。');

    const destination = ensureSafeArchivePath(extractRoot, entryPath);
    if (isTransientBackupPath(entryPath.slice('data/'.length))) {
      // 旧版本的备份可能包含登录会话、挂起日志等临时数据：照常校验、计数，但不还原
      if (!entry.isDirectory) extractedFileCount += 1;
      continue;
    }
    if (entry.isDirectory) {
      fs.mkdirSync(destination, { recursive: true });
      continue;
    }
    const entrySize = Number(entry.header.size);
    if (!Number.isSafeInteger(entrySize) || entrySize < 0 || entrySize > MAX_BACKUP_ENTRY_BYTES) {
      throw new Error(`完整备份中的文件 ${entryPath} 大小无效或超过安全限制。`);
    }
    extractedBytes += entrySize;
    if (extractedBytes > MAX_BACKUP_EXTRACTED_BYTES) {
      throw new Error('完整备份解压后的总大小超过安全限制。');
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
