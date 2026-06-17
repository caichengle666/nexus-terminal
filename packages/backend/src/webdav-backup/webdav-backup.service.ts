import { createClient, WebDAVClient, WebDAVClientOptions } from 'webdav';
import path from 'path';
import fs from 'fs';
import os from 'os';
const archiver = require('archiver');
import { getDbInstance } from '../database/connection';
import { settingsRepository } from '../settings/settings.repository';

const WEBDAV_CONFIG_KEY = 'webdavBackupConfig';
const BACKUP_DIR = '/nexus-terminal-backups';

export interface WebDavBackupConfig {
  url: string;
  username: string;
  password: string;
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

function createWebDavClient(config: WebDavBackupConfig): WebDAVClient {
  const options: WebDAVClientOptions = {
    username: config.username,
    password: config.password,
  };
  return createClient(config.url, options);
}

async function ensureBackupDir(client: WebDAVClient): Promise<void> {
  try {
    await client.getDirectoryContents(BACKUP_DIR);
  } catch {
    await client.createDirectory(BACKUP_DIR);
  }
}

async function collectBackupData(): Promise<Record<string, any>> {
  const db = await getDbInstance();
  const backup: Record<string, any> = {};

  const tables = [
    'settings', 'connections', 'proxies', 'ssh_keys',
    'tags', 'connection_tags', 'quick_commands', 'quick_command_tags',
    'quick_command_tag_associations', 'command_history', 'path_history',
    'favorite_paths', 'appearance_settings', 'terminal_themes',
    'notification_settings', 'users',
  ];

  for (const table of tables) {
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

export async function createBackup(): Promise<{ fileName: string; size: number }> {
  const config = await getWebDavConfig();
  if (!config) throw new Error('WebDAV 备份未配置，请先保存 WebDAV 连接信息。');

  const client = createWebDavClient(config);
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

export async function listBackups(): Promise<BackupFileInfo[]> {
  const config = await getWebDavConfig();
  if (!config) throw new Error('WebDAV 备份未配置。');

  const client = createWebDavClient(config);
  await ensureBackupDir(client);

  const items = await client.getDirectoryContents(BACKUP_DIR);
  const files: BackupFileInfo[] = items
    .filter((item: any) => item.type === 'file' && item.basename.endsWith('.zip'))
    .map((item: any) => ({
      name: item.basename,
      size: item.size || 0,
      lastModified: item.lastmod || '',
    }))
    .sort((a, b) => b.name.localeCompare(a.name));

  return files;
}

export async function downloadBackup(fileName: string): Promise<Buffer> {
  const config = await getWebDavConfig();
  if (!config) throw new Error('WebDAV 备份未配置。');

  const client = createWebDavClient(config);
  const remotePath = path.posix.join(BACKUP_DIR, fileName).replace(/\\/g, '/');
  const raw = await client.getFileContents(remotePath);
  const bufData: Buffer = Buffer.isBuffer(raw) ? raw : (typeof raw === 'string' ? Buffer.from(raw) : Buffer.from((raw as any).data || raw));
  return bufData;
}

export async function deleteBackup(fileName: string): Promise<void> {
  const config = await getWebDavConfig();
  if (!config) throw new Error('WebDAV 备份未配置。');

  const client = createWebDavClient(config);
  const remotePath = path.posix.join(BACKUP_DIR, fileName).replace(/\\/g, '/');
  await client.deleteFile(remotePath);
}

export async function restoreFromBackup(fileName: string): Promise<{ tables: string[]; message: string }> {
  const buffer = await downloadBackup(fileName);
  const content = buffer.toString('utf-8');
  const data = JSON.parse(content);

  if (!data._meta || !data._meta.version) {
    throw new Error('无效的备份文件格式。');
  }

  const tableNames = Object.keys(data).filter(k => k !== '_meta');
  const db = await getDbInstance();

  await new Promise<void>((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      try {
        for (const table of tableNames) {
          const rows = data[table];
          if (!Array.isArray(rows) || rows.length === 0) continue;
          if (table !== 'users') {
            db.run(`DELETE FROM ${table}`);
          }

          if (table === 'settings') {
            const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)');
            for (const row of rows) {
              stmt.run(row.key, row.value, row.created_at || Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));
            }
            stmt.finalize();
          } else if (table === 'users') {
            console.log('[WebDAV Restore] 跳过 users 表恢复以保护现有帐户。');
          } else if (table === 'connections') {
            const stmt = db.prepare('INSERT INTO connections (name, type, host, port, username, auth_method, encrypted_password, encrypted_private_key, encrypted_passphrase, proxy_id, ssh_key_id, notes, jump_chain, proxy_type, created_at, updated_at, last_connected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
            for (const row of rows) {
              stmt.run(row.name, row.type, row.host, row.port, row.username, row.auth_method, row.encrypted_password, row.encrypted_private_key, row.encrypted_passphrase, row.proxy_id, row.ssh_key_id, row.notes, row.jump_chain, row.proxy_type, row.created_at, row.updated_at, row.last_connected_at);
            }
            stmt.finalize();
          } else {
            const columns = Object.keys(rows[0]).filter(c => c !== 'id');
            const placeholders = columns.map(() => '?').join(', ');
            const colNames = columns.join(', ');
            const stmt = db.prepare(`INSERT INTO ${table} (${colNames}) VALUES (${placeholders})`);
            for (const row of rows) {
              const values = columns.map(c => row[c] === undefined ? null : row[c]);
              stmt.run(...values);
            }
            stmt.finalize();
          }
        }
        db.run('COMMIT');
        resolve();
      } catch (err) {
        db.run('ROLLBACK');
        reject(err);
      }
    });
  });

  return { tables: tableNames, message: `已从 ${fileName} 恢复 ${tableNames.length} 个表的数据。` };
}

export async function testConnection(client?: WebDAVClient): Promise<boolean> {
  let cl: WebDAVClient;
  if (client) {
    cl = client;
  } else {
    const config = await getWebDavConfig();
    if (!config) throw new Error('WebDAV 备份未配置。');
    cl = createWebDavClient(config);
  }

  try {
    await cl.getDirectoryContents('/');
    return true;
  } catch (err: any) {
    throw new Error(`无法连接到 WebDAV 服务器: ${err.message}`);
  }
}
