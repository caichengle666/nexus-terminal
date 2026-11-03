import { createClient, WebDAVClient, WebDAVClientOptions } from 'webdav';
import path from 'path';
import fs from 'fs';
import os from 'os';
import AdmZip from 'adm-zip';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { allDb, getDbInstance, runDb, runExclusive, withTransaction } from '../database/connection';
import { settingsRepository } from '../settings/settings.repository';
import * as ProxyRepository from '../proxies/proxy.repository';
import { decrypt } from '../utils/crypto';
import { isLegacyPlaintextSecret, openSecret, sealSecret } from '../utils/secret-field';
import { assertUrlHostAllowed, safeHttpAgent, safeHttpsAgent } from '../utils/safe-http';
import { getBackendDataPath } from '../utils/paths';
import {
  createFullBackup,
  DATABASE_FILE_NAME,
  extractFullBackup,
  isFullBackupBuffer,
  MIN_BACKUP_PASSPHRASE_LENGTH,
} from './backup-archive';
import { getRestoreStagingRoot, readPendingRestoreMarker } from './pending-restore';

const WEBDAV_CONFIG_KEY = 'webdavBackupConfig';
const BACKUP_DIR = '/nexus-terminal-backups';
const LEGACY_BACKUP_FILE_NAME_PATTERN = /^nexus-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.zip$/;
const FULL_BACKUP_FILE_NAME_PATTERN = /^nexus-full-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.zip\.enc$/;
const BACKUP_FILE_NAME_PATTERN = new RegExp(`(?:${LEGACY_BACKUP_FILE_NAME_PATTERN.source})|(?:${FULL_BACKUP_FILE_NAME_PATTERN.source})`);
const BACKUP_TABLES = [
  'settings', 'connections', 'proxies', 'ssh_keys',
  'tags', 'connection_tags', 'quick_commands', 'quick_command_tags',
  'quick_command_tag_associations', 'command_history', 'path_history',
  'favorite_paths', 'appearance_settings', 'terminal_themes',
  'notification_settings', 'users',
] as const;
const RESTORE_DELETE_ORDER = [
  'connection_tags', 'quick_command_tag_associations', 'connections',
  'tags', 'quick_commands', 'quick_command_tags', 'proxies', 'ssh_keys',
  'command_history', 'path_history', 'favorite_paths', 'appearance_settings',
  'terminal_themes', 'notification_settings', 'settings',
] as const;
const RESTORE_INSERT_ORDER = [
  'settings', 'proxies', 'ssh_keys', 'connections', 'tags', 'connection_tags',
  'quick_commands', 'quick_command_tags', 'quick_command_tag_associations',
  'command_history', 'path_history', 'favorite_paths', 'appearance_settings',
  'terminal_themes', 'notification_settings',
] as const;

export interface WebDavBackupConfig {
  url: string;
  username: string;
  password: string;
  proxyId?: number | null;
}

export interface BackupFileInfo {
  name: string;
  size: number;
  lastModified: string;
  format: 'full' | 'legacy';
  encrypted: boolean;
}

// ---------- Config helpers ----------

export async function getWebDavConfig(): Promise<WebDavBackupConfig | null> {
  const json = await settingsRepository.getSetting(WEBDAV_CONFIG_KEY);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (parsed && parsed.url && parsed.username && parsed.password) {
      if (isLegacyPlaintextSecret(parsed.password)) {
        // 历史明文密码：透明加密回写
        await settingsRepository.setSetting(WEBDAV_CONFIG_KEY, JSON.stringify({ ...parsed, password: sealSecret(parsed.password) }))
          .catch(err => console.error('[WebDAV] 加密历史 WebDAV 密码失败:', err));
      }
      const password = openSecret(parsed.password);
      if (!password) return null;
      return { ...parsed, password } as WebDavBackupConfig;
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveWebDavConfig(config: WebDavBackupConfig): Promise<void> {
  if (!config.url || !config.username || !config.password) {
    throw new Error('WebDAV 配置不完整，需要 url / username / password');
  }
  await settingsRepository.setSetting(WEBDAV_CONFIG_KEY, JSON.stringify({ ...config, password: sealSecret(config.password) }));
}

export async function deleteWebDavConfig(): Promise<void> {
  await settingsRepository.deleteSetting(WEBDAV_CONFIG_KEY);
}

async function getWebDavProxyAgents(proxyId?: number | null): Promise<Pick<WebDAVClientOptions, 'httpAgent' | 'httpsAgent'>> {
  // 无代理时使用带 SSRF 防护的 agent (拒绝链路本地 / 云元数据地址)
  if (!proxyId) return { httpAgent: safeHttpAgent, httpsAgent: safeHttpsAgent };

  const proxy = await ProxyRepository.findProxyById(proxyId);
  if (!proxy) {
    throw new Error('所选 WebDAV 代理不存在，请重新选择。');
  }
  if (proxy.auth_method === 'key') {
    throw new Error('WebDAV 代理不支持密钥认证，请使用无认证或密码认证的 HTTP/SOCKS5 代理。');
  }

  const protocol = proxy.type === 'SOCKS5' ? 'socks5h:' : 'http:';
  const host = proxy.host.includes(':') && !proxy.host.startsWith('[')
    ? `[${proxy.host}]`
    : proxy.host;
  const proxyUrl = new URL(`${protocol}//${host}:${proxy.port}`);

  if (proxy.auth_method === 'password') {
    if (!proxy.username || !proxy.encrypted_password) {
      throw new Error('所选 WebDAV 代理缺少用户名或密码。');
    }
    proxyUrl.username = proxy.username;
    proxyUrl.password = decrypt(proxy.encrypted_password);
  }

  if (proxy.type === 'SOCKS5') {
    const agent = new SocksProxyAgent(proxyUrl.toString());
    return { httpAgent: agent, httpsAgent: agent };
  }

  return {
    httpAgent: new HttpProxyAgent(proxyUrl.toString()),
    httpsAgent: new HttpsProxyAgent(proxyUrl.toString()),
  };
}

/** 目录列表、stat、删除等元数据请求的超时。 */
export const WEBDAV_REQUEST_TIMEOUT_MS = 30_000;
/** 上传/下载的最短超时；更大的文件按 256 KB/s 的保底速度延长。 */
const WEBDAV_MIN_TRANSFER_TIMEOUT_MS = 5 * 60_000;
const WEBDAV_MIN_TRANSFER_BYTES_PER_SECOND = 256 * 1024;
const WEBDAV_DEFAULT_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

export function webDavTransferTimeoutMs(bytes: number): number {
  const scaled = Math.ceil(Math.max(0, bytes) / WEBDAV_MIN_TRANSFER_BYTES_PER_SECOND) * 1000;
  return Math.max(WEBDAV_MIN_TRANSFER_TIMEOUT_MS, scaled);
}

/** 每个方法的 options 参数位置（用于注入超时 signal）。 */
const WEBDAV_OPTIONS_ARG_INDEX: Record<string, number> = {
  getDirectoryContents: 1,
  createDirectory: 1,
  stat: 1,
  exists: 1,
  deleteFile: 1,
  getFileContents: 1,
  putFileContents: 2,
};

function defaultTimeoutFor(method: string, args: unknown[]): number {
  if (method === 'putFileContents') {
    const data = args[1] as { length?: number; byteLength?: number } | undefined;
    return webDavTransferTimeoutMs(Number(data?.byteLength ?? data?.length ?? 0));
  }
  if (method === 'getFileContents') return WEBDAV_DEFAULT_DOWNLOAD_TIMEOUT_MS;
  return WEBDAV_REQUEST_TIMEOUT_MS;
}

const isAbortError = (error: any): boolean => error?.name === 'TimeoutError' || error?.name === 'AbortError' || error?.code === 'ABORT_ERR';

/**
 * 给 WebDAV 客户端的每个请求加上超时（AbortSignal.timeout）。
 * 调用方已传入 signal 时保持不变；也可以在 options 里传 timeoutMs 覆盖默认值。
 * 服务器卡住时请求不会再一直挂着。
 */
export function withWebDavTimeouts(client: WebDAVClient): WebDAVClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || typeof value !== 'function' || !(prop in WEBDAV_OPTIONS_ARG_INDEX)) {
        return value;
      }
      const index = WEBDAV_OPTIONS_ARG_INDEX[prop];
      return async (...args: unknown[]) => {
        const callArgs = [...args];
        const { timeoutMs: requestedTimeout, ...existing } = (callArgs[index] ?? {}) as Record<string, unknown>;
        if (existing.signal) {
          callArgs[index] = existing;
          return value.apply(target, callArgs);
        }
        const timeoutMs = typeof requestedTimeout === 'number' && requestedTimeout > 0
          ? requestedTimeout
          : defaultTimeoutFor(prop, callArgs);
        callArgs[index] = { ...existing, signal: AbortSignal.timeout(timeoutMs) };
        try {
          return await value.apply(target, callArgs);
        } catch (error: any) {
          if (isAbortError(error)) {
            throw new Error(`WebDAV 服务器在 ${Math.round(timeoutMs / 1000)} 秒内没有完成请求 (${prop})，已超时。`);
          }
          throw error;
        }
      };
    },
  });
}

export async function createWebDavClient(config: WebDavBackupConfig): Promise<WebDAVClient> {
  const options: WebDAVClientOptions = {
    username: config.username,
    password: config.password,
    ...(await getWebDavProxyAgents(config.proxyId)),
  };
  assertUrlHostAllowed(config.url);
  return withWebDavTimeouts(createClient(config.url, options));
}

async function getWebDavConfigForRequest(proxyId?: number | null): Promise<WebDavBackupConfig> {
  const config = await getWebDavConfig();
  if (!config) throw new Error('WebDAV 备份未配置。');
  return proxyId === undefined ? config : { ...config, proxyId };
}

async function ensureBackupDir(client: WebDAVClient): Promise<void> {
  try {
    await client.getDirectoryContents(BACKUP_DIR);
  } catch {
    await client.createDirectory(BACKUP_DIR);
  }
}

const MAX_BACKUP_DOWNLOAD_BYTES = 1024 * 1024 * 1024;

function getBackupRemotePath(fileName: string): string {
  if (!BACKUP_FILE_NAME_PATTERN.test(fileName)) {
    throw new Error('无效的备份文件名。');
  }
  return path.posix.join(BACKUP_DIR, fileName);
}

/**
 * 用 VACUUM INTO 生成数据库的一致性快照（独占连接执行，不会和进行中的事务或其他语句交错），
 * 再用快照代替正在写入的实时数据库文件打包。临时文件总会被清理。
 */
export async function createFullBackupWithDbSnapshot(dataPath: string, passphrase: string) {
  const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-db-snapshot-'));
  const snapshotPath = path.join(snapshotDir, DATABASE_FILE_NAME);
  try {
    const db = await getDbInstance();
    // VACUUM 要求连接上没有其他语句在执行，也不能在事务内：独占连接执行（其他请求短暂排队）
    await runExclusive(db, () => new Promise<void>((resolve, reject) => {
      db.run('VACUUM INTO ?', [snapshotPath], (err: Error | null) => (err ? reject(err) : resolve()));
    }));
    return await createFullBackup(dataPath, passphrase, { databaseSnapshotPath: snapshotPath });
  } finally {
    fs.rmSync(snapshotDir, { recursive: true, force: true });
  }
}

export async function createBackup(passphrase: string, proxyId?: number | null): Promise<{ fileName: string; size: number; fileCount: number }> {
  const config = await getWebDavConfigForRequest(proxyId);
  const client = await createWebDavClient(config);
  await ensureBackupDir(client);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName = `nexus-full-backup-${timestamp}.zip.enc`;
  const archive = await createFullBackupWithDbSnapshot(getBackendDataPath(), passphrase);
  const remotePath = path.posix.join(BACKUP_DIR, fileName).replace(/\\/g, '/');
  await client.putFileContents(remotePath, archive.buffer, { overwrite: true });

  console.log(`[WebDAV Backup] 完整备份完成: ${fileName} (${(archive.buffer.length / 1024).toFixed(1)} KB, ${archive.fileCount} 个文件)`);
  return { fileName, size: archive.buffer.length, fileCount: archive.fileCount };
}

export async function listBackups(proxyId?: number | null): Promise<BackupFileInfo[]> {
  const config = await getWebDavConfigForRequest(proxyId);
  const client = await createWebDavClient(config);
  await ensureBackupDir(client);

  const items = await client.getDirectoryContents(BACKUP_DIR);
  const files: BackupFileInfo[] = items
    .filter((item: any) => item.type === 'file' && BACKUP_FILE_NAME_PATTERN.test(item.basename))
    .map((item: any) => ({
      name: item.basename,
      size: item.size || 0,
      lastModified: item.lastmod || '',
      format: FULL_BACKUP_FILE_NAME_PATTERN.test(item.basename) ? ('full' as const) : ('legacy' as const),
      encrypted: FULL_BACKUP_FILE_NAME_PATTERN.test(item.basename),
    }))
    .sort((a, b) => b.name.localeCompare(a.name));

  return files;
}

export async function downloadBackup(fileName: string, proxyId?: number | null): Promise<Buffer> {
  const config = await getWebDavConfigForRequest(proxyId);
  const client = await createWebDavClient(config);
  const remotePath = getBackupRemotePath(fileName);
  const stat = await client.stat(remotePath) as { size?: number };
  if (typeof stat.size === 'number' && stat.size > MAX_BACKUP_DOWNLOAD_BYTES) {
    throw new Error('备份文件超过 1GB 安全限制。');
  }
  const downloadTimeoutMs = typeof stat.size === 'number' ? webDavTransferTimeoutMs(stat.size) : undefined;
  const raw = await client.getFileContents(remotePath, { timeoutMs: downloadTimeoutMs } as any);
  const bufData: Buffer = Buffer.isBuffer(raw) ? raw : (typeof raw === 'string' ? Buffer.from(raw) : Buffer.from((raw as any).data || raw));
  if (bufData.length > MAX_BACKUP_DOWNLOAD_BYTES) {
    throw new Error('备份文件超过 1GB 安全限制。');
  }
  return bufData;
}

export async function deleteBackup(fileName: string, proxyId?: number | null): Promise<void> {
  const config = await getWebDavConfigForRequest(proxyId);
  const client = await createWebDavClient(config);
  const remotePath = getBackupRemotePath(fileName);
  await client.deleteFile(remotePath);
}

export interface ParsedLegacyBackup {
  data: Record<string, any>;
  restoreTables: string[];
}

/** 解析并校验旧版 (nexus-backup.json) 备份，不修改任何数据。 */
export function parseLegacyBackup(buffer: Buffer): ParsedLegacyBackup {
  let data: Record<string, any>;

  try {
    const archive = new AdmZip(buffer);
    const backupEntry = archive.getEntry('nexus-backup.json');
    if (!backupEntry) {
      throw new Error('备份文件中缺少 nexus-backup.json。');
    }
    data = JSON.parse(backupEntry.getData().toString('utf-8'));
  } catch (error: any) {
    if (error.message === '备份文件中缺少 nexus-backup.json。') {
      throw error;
    }
    throw new Error(`无法读取备份文件: ${error.message}`);
  }

  if (!data._meta || !data._meta.version) {
    throw new Error('无效的备份文件格式。');
  }

  const restoreTables = BACKUP_TABLES.filter(table => table !== 'users' && Object.prototype.hasOwnProperty.call(data, table));
  for (const table of restoreTables) {
    if (!Array.isArray(data[table])) {
      throw new Error(`备份中的 ${table} 数据格式无效。`);
    }
  }
  return { data, restoreTables };
}

/** 在单个事务中把旧版备份写入当前数据库 (不替换文件，因此无需重启时替换)。 */
export async function applyLegacyBackup({ data, restoreTables }: ParsedLegacyBackup): Promise<void> {
  const db = await getDbInstance();
  // 串行化的 IMMEDIATE 事务：恢复期间其他请求的写入排队，失败时整体回滚
  await withTransaction(db, async () => {
    for (const table of RESTORE_DELETE_ORDER) {
      if (restoreTables.includes(table)) {
        await runDb(db, `DELETE FROM "${table}"`);
      }
    }

    for (const table of RESTORE_INSERT_ORDER) {
      if (!restoreTables.includes(table)) continue;

      const rows = data[table] as Array<Record<string, unknown>>;
      if (rows.length === 0) continue;
      const columnInfo = await allDb<{ name: string }>(db, `PRAGMA table_info("${table}")`);
      const allowedColumns = new Set(columnInfo.map(column => column.name));

      for (const row of rows) {
        const columns = Object.keys(row).filter(column => allowedColumns.has(column) && row[column] !== undefined);
        if (columns.length === 0) {
          throw new Error(`备份中的 ${table} 包含无法恢复的记录。`);
        }
        const quotedColumns = columns.map(column => `"${column}"`).join(', ');
        const placeholders = columns.map(() => '?').join(', ');
        const values = columns.map(column => row[column]);
        await runDb(db, `INSERT INTO "${table}" (${quotedColumns}) VALUES (${placeholders})`, values);
      }
    }
  }, { mode: 'IMMEDIATE' });
}

/**
 * 把完整备份解密、校验并解压到 data 目录内的暂存区 (与 data 同卷)。
 * 密码错误或文件损坏会在这里直接失败，此时尚未创建安全快照、也未改动任何数据。
 */
export function stageFullBackup(buffer: Buffer, passphrase: string | undefined): { fileCount: number } {
  if (!passphrase || passphrase.length < MIN_BACKUP_PASSPHRASE_LENGTH) {
    throw new Error(`完整备份需要至少 ${MIN_BACKUP_PASSPHRASE_LENGTH} 个字符的备份密码。`);
  }
  const dataPath = getBackendDataPath();
  if (readPendingRestoreMarker(dataPath)) {
    throw new Error('已有一个待生效的恢复，请先重启服务使其生效。');
  }
  const stagingRoot = getRestoreStagingRoot(dataPath);
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  try {
    const extracted = extractFullBackup(buffer, passphrase, stagingRoot);
    return { fileCount: extracted.manifest.fileCount };
  } catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function testConnection(client?: WebDAVClient): Promise<boolean> {
  let cl: WebDAVClient;
  if (client) {
    cl = client;
  } else {
    const config = await getWebDavConfig();
    if (!config) throw new Error('WebDAV 备份未配置。');
    cl = await createWebDavClient(config);
  }

  try {
    await cl.getDirectoryContents('/');
    return true;
  } catch (err: any) {
    throw new Error(`无法连接到 WebDAV 服务器: ${err.message}`);
  }
}
