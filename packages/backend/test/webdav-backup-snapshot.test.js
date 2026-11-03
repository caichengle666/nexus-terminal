const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const crypto = require('node:crypto');
const sqlite3 = require('sqlite3');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-webdav-snapshot-test-'));
process.env.APP_BACKEND_DATA_PATH = dataDir;
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

const { getDbInstance, runDb, getDb, closeDbInstance, withTransaction } = require('../dist/database/connection.js');
const { createFullBackupWithDbSnapshot, withWebDavTimeouts, webDavTransferTimeoutMs } = require('../dist/webdav-backup/webdav-backup.service.js');
const { extractFullBackup } = require('../dist/webdav-backup/backup-archive.js');

test.after(async () => {
  await closeDbInstance().catch(() => {});
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('full backup packs a VACUUM INTO snapshot taken outside any open transaction', async () => {
  const db = await getDbInstance();
  await runDb(db, "INSERT OR REPLACE INTO settings (key, value) VALUES ('snapshot-test', 'committed')");
  fs.mkdirSync(path.join(dataDir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'sessions', 's.json'), '{}');

  // 备份和一个尚未提交、最终回滚的事务重叠：快照里不能出现未提交的数据
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const tx = withTransaction(db, async () => {
    await runDb(db, "INSERT OR REPLACE INTO settings (key, value) VALUES ('snapshot-test', 'uncommitted')");
    await gate;
    throw new Error('abort tx');
  }).catch(() => {});
  const backup = createFullBackupWithDbSnapshot(dataDir, 'correct-passphrase');
  setTimeout(release, 30);
  const [archive] = await Promise.all([backup, tx]);

  const extractRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-webdav-snapshot-extract-'));
  try {
    const extracted = extractFullBackup(archive.buffer, 'correct-passphrase', extractRoot);
    assert.equal(fs.existsSync(path.join(extracted.dataPath, 'sessions')), false);
    const snap = new sqlite3.Database(path.join(extracted.dataPath, 'nexus-terminal.db'));
    const row = await getDb(snap, "SELECT value FROM settings WHERE key = 'snapshot-test'");
    await new Promise(resolve => snap.close(resolve));
    assert.equal(row.value, 'committed');
  } finally {
    fs.rmSync(extractRoot, { recursive: true, force: true });
  }
  // 临时快照目录已清理
  assert.equal(fs.readdirSync(os.tmpdir()).some(name => name.startsWith('nexus-db-snapshot-') && fs.existsSync(path.join(os.tmpdir(), name, 'nexus-terminal.db'))), false);
});

test('snapshot succeeds while other requests keep reading and writing (no "SQL statements in progress")', async () => {
  const db = await getDbInstance();
  let stop = false;
  const traffic = (async () => {
    let i = 0;
    while (!stop) {
      await Promise.all([
        runDb(db, 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [`traffic-${i % 5}`, String(i)]),
        getDb(db, 'SELECT COUNT(*) AS c FROM settings'),
        getDb(db, 'SELECT value FROM settings WHERE key = ?', ['snapshot-test']),
      ]);
      i++;
    }
  })();
  try {
    for (let round = 0; round < 3; round++) {
      const archive = await createFullBackupWithDbSnapshot(dataDir, 'correct-passphrase');
      assert.ok(archive.fileCount >= 1);
    }
  } finally {
    stop = true;
    await traffic;
  }
});

test('WebDAV client requests time out instead of hanging', async () => {
  const hanging = {
    stat: (_path, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason));
    }),
    getDirectoryContents: async () => ['ok'],
  };
  const client = withWebDavTimeouts(hanging);
  // AbortSignal.timeout 的定时器是 unref 的；真实请求有 socket 保活，这里手动保活事件循环
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    await assert.rejects(client.stat('/x', { timeoutMs: 50 }), /超时/);
  } finally {
    clearTimeout(keepAlive);
  }
  assert.deepEqual(await client.getDirectoryContents('/'), ['ok']);
  assert.equal(webDavTransferTimeoutMs(0), 5 * 60_000);
  assert.ok(webDavTransferTimeoutMs(1024 * 1024 * 1024) > 60 * 60_000);
});
