import { createClient, WebDAVClient, WebDAVClientOptions } from 'webdav';
import path from 'path';
import fs from 'fs';
import os from 'os';
import AdmZip from 'adm-zip';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
const archiver = require('archiver');
import { allDb, getDbInstance, runDb } from '../database/connection';
import { settingsRepository } from '../settings/settings.repository';
import * as ProxyRepository from '../proxies/proxy.repository';
import { decrypt } from '../utils/crypto';

const WEBDAV_CONFIG_KEY = 'webdavBackupConfig';
const BACKUP_DIR = '/nexus-terminal-backups';
const BACKUP_FILE_NAME_PATTERN = /^nexus-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.zip$/;
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
}

// ---------- Config helpers ----------

export async function getWebDavConfig(): Promise<WebDavBackupConfig | null> {
  const json = await settingsRepository.getSetting(WEBDAV_CONFIG_KEY);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (parsed && parsed.url && parsed.username && parsed.password) {
      return parsed as WebDavBackupConfig;
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
  await settingsRepository.setSetting(WEBDAV_CONFIG_KEY, JSON.stringify(config));
}

export async function deleteWebDavConfig(): Promise<void> {
  await settingsRepository.deleteSetting(WEBDAV_CONFIG_KEY);
}

async function getWebDavProxyAgents(proxyId?: number | null): Promise<Pick<WebDAVClientOptions, 'httpAgent' | 'httpsAgent'>> {
  if (!proxyId) return {};

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

export async function createWebDavClient(config: WebDavBackupConfig): Promise<WebDAVClient> {
  const options: WebDAVClientOptions = {
    username: config.username,
    password: config.password,
    ...(await getWebDavProxyAgents(config.proxyId)),
  };
  return createClient(config.url, options);
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

function getBackupRemotePath(fileName: string): string {
  if (!BACKUP_FILE_NAME_PATTERN.test(fileName)) {
    throw new Error('无效的备份文件名。');
  }
  return path.posix.join(BACKUP_DIR, fileName);
}

async function collectBackupData(): Promise<Record<string, any>> {
  const db = await getDbInstance();
  const backup: Record<string, any> = {};

  for (const table of BACKUP_TABLES) {
    try {
      const rows = await new Promise<any[]>((resolve, reject) => {
        db.all(`SELECT * FROM ${table}`, (err: any, rows: any[]) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });
      backup[table] = rows;
    } catch (err: any) {
      console.warn(`[WebDAV Backup] 无法读取表 ${table}: ${err.message}`);
      backup[table] = [];
    }
  }

  if (backup.users) {
    backup.users = backup.users.map((u: any) => ({
      ...u,
      hashed_password: undefined,
      two_factor_secret: undefined,
    }));
  }

  backup._meta = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    description: 'Nexus Terminal 完整数据备份',
  };

  return backup;
}

export async function createBackup(proxyId?: number | null): Promise<{ fileName: string; size: number }> {
  const config = await getWebDavConfigForRequest(proxyId);
  const client = await createWebDavClient(config);
  await ensureBackupDir(client);

  const data = await collectBackupData();
  const jsonContent = JSON.stringify(data, null, 2);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-backup-'));
  const jsonFile = path.join(tmpDir, 'nexus-backup.json');
  fs.writeFileSync(jsonFile, jsonContent, 'utf-8');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const zipName = `nexus-backup-${timestamp}.zip`;
  const zipPath = path.join(tmpDir, zipName);

  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const arch = require('archiver') as any;
    const archive = arch('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.file(jsonFile, { name: 'nexus-backup.json' });
    archive.finalize();
  });

  const fileBuffer = fs.readFileSync(zipPath);
  const remotePath = path.posix.join(BACKUP_DIR, zipName).replace(/\\/g, '/');
  await client.putFileContents(remotePath, fileBuffer, { overwrite: true });

  const stats = fs.statSync(zipPath);
  const size = stats.size;

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`[WebDAV Backup] 备份完成: ${zipName} (${(size / 1024).toFixed(1)} KB)`);
  return { fileName: zipName, size };
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
    }))
    .sort((a, b) => b.name.localeCompare(a.name));

  return files;
}

export async function downloadBackup(fileName: string, proxyId?: number | null): Promise<Buffer> {
  const config = await getWebDavConfigForRequest(proxyId);
  const client = await createWebDavClient(config);
  const remotePath = getBackupRemotePath(fileName);
  const raw = await client.getFileContents(remotePath);
  const bufData: Buffer = Buffer.isBuffer(raw) ? raw : (typeof raw === 'string' ? Buffer.from(raw) : Buffer.from((raw as any).data || raw));
  return bufData;
}

export async function deleteBackup(fileName: string, proxyId?: number | null): Promise<void> {
  const config = await getWebDavConfigForRequest(proxyId);
  const client = await createWebDavClient(config);
  const remotePath = getBackupRemotePath(fileName);
  await client.deleteFile(remotePath);
}

export async function restoreFromBackup(fileName: string, proxyId?: number | null): Promise<{ tables: string[]; message: string }> {
  const buffer = await downloadBackup(fileName, proxyId);
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

  const db = await getDbInstance();
  await runDb(db, 'BEGIN IMMEDIATE TRANSACTION');
  try {
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

    await runDb(db, 'COMMIT');
  } catch (error) {
    try {
      await runDb(db, 'ROLLBACK');
    } catch (rollbackError) {
      console.error('[WebDAV Restore] 回滚失败:', rollbackError);
    }
    throw error;
  }

  return { tables: restoreTables, message: `已从 ${fileName} 恢复 ${restoreTables.length} 个表的数据。` };
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
