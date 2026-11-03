const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createFullBackup,
  extractFullBackup,
} = require('../dist/webdav-backup/backup-archive.js');

test('full backup preserves data files and rejects an incorrect passphrase', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-backup-test-'));
  const dataPath = path.join(root, 'data');
  const extractPath = path.join(root, 'extract');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(path.join(dataPath, 'nested', 'empty'), { recursive: true });
  fs.writeFileSync(path.join(dataPath, '.env'), 'ENCRYPTION_KEY=test\n');
  fs.writeFileSync(path.join(dataPath, 'nested', 'record.json'), '{"ok":true}\n');
  fs.writeFileSync(path.join(dataPath, 'empty.txt'), '');

  const archive = await createFullBackup(dataPath, 'correct-passphrase');
  assert.equal(archive.fileCount, 3);
  assert.ok(archive.buffer.length > 0);
  assert.throws(
    () => extractFullBackup(archive.buffer, 'wrong-passphrase', extractPath),
    /备份密码错误|备份文件已损坏/,
  );

  const extracted = extractFullBackup(archive.buffer, 'correct-passphrase', extractPath);
  assert.equal(extracted.manifest.fileCount, 3);
  assert.equal(fs.readFileSync(path.join(extracted.dataPath, '.env'), 'utf8'), 'ENCRYPTION_KEY=test\n');
  assert.equal(fs.readFileSync(path.join(extracted.dataPath, 'nested', 'record.json'), 'utf8'), '{"ok":true}\n');
  assert.equal(fs.statSync(path.join(extracted.dataPath, 'empty.txt')).size, 0);
});

const crypto = require('node:crypto');
const AdmZip = require('adm-zip');
const { FULL_BACKUP_MAGIC, isTransientBackupPath } = require('../dist/webdav-backup/backup-archive.js');

// 按 v2 格式手工加密一个 zip（模拟旧版本生成的完整备份）。
const encryptLikeV2 = (zipBuffer, passphrase) => {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(zipBuffer), cipher.final()]);
  const header = Buffer.from(`${JSON.stringify({
    version: 2, algorithm: 'aes-256-gcm', kdf: 'scrypt',
    salt: salt.toString('base64'), iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'),
  })}\n`);
  return Buffer.concat([FULL_BACKUP_MAGIC, header, ciphertext]);
};

test('full backup skips transient dirs, sqlite side files and *.part, and uses the DB snapshot', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-backup-transient-'));
  const dataPath = path.join(root, 'data');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['sessions', 'temp_suspended_ssh_logs', 'temp-uploads', 'background', '.nexus-restore']) {
    fs.mkdirSync(path.join(dataPath, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(dataPath, '.env'), 'K=1\n');
  fs.writeFileSync(path.join(dataPath, 'nexus-terminal.db'), 'LIVE-DB');
  fs.writeFileSync(path.join(dataPath, 'nexus-terminal.db-journal'), 'j');
  fs.writeFileSync(path.join(dataPath, 'sessions', 'abc.json'), '{}');
  fs.writeFileSync(path.join(dataPath, 'temp_suspended_ssh_logs', 's.log'), 'log');
  fs.writeFileSync(path.join(dataPath, 'temp-uploads', 'x'), 'x');
  fs.writeFileSync(path.join(dataPath, 'background', 'bg.jpg'), 'img');
  fs.writeFileSync(path.join(dataPath, 'background', 'big.bin.part'), 'partial');
  fs.writeFileSync(path.join(dataPath, '.nexus-restore', 'marker.json'), '{}');
  const snapshot = path.join(root, 'snapshot.db');
  fs.writeFileSync(snapshot, 'SNAPSHOT-DB');

  const archive = await createFullBackup(dataPath, 'correct-passphrase', { databaseSnapshotPath: snapshot });
  assert.equal(archive.fileCount, 3);
  const extracted = extractFullBackup(archive.buffer, 'correct-passphrase', path.join(root, 'extract'));
  assert.equal(fs.readFileSync(path.join(extracted.dataPath, 'nexus-terminal.db'), 'utf8'), 'SNAPSHOT-DB');
  assert.equal(fs.readFileSync(path.join(extracted.dataPath, 'background', 'bg.jpg'), 'utf8'), 'img');
  assert.equal(fs.existsSync(path.join(extracted.dataPath, 'sessions')), false);
  assert.equal(fs.existsSync(path.join(extracted.dataPath, 'temp_suspended_ssh_logs')), false);
  assert.equal(fs.existsSync(path.join(extracted.dataPath, 'nexus-terminal.db-journal')), false);
  assert.equal(fs.existsSync(path.join(extracted.dataPath, 'background', 'big.bin.part')), false);

  assert.equal(isTransientBackupPath('sessions/a.json'), true);
  assert.equal(isTransientBackupPath('uploads/a.png'), false);
  assert.equal(isTransientBackupPath('nested/nexus-terminal.db-journal'), false);
});

test('full backup tolerates files deleted after they were listed', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-backup-vanish-'));
  const dataPath = path.join(root, 'data');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dataPath, 'files'), { recursive: true });
  const names = Array.from({ length: 20 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);
  for (const name of names) fs.writeFileSync(path.join(dataPath, 'files', name), name);

  // 文件列表在调用时同步生成；之后立即删掉排在后面的文件，模拟打包途中被清理
  const pending = createFullBackup(dataPath, 'correct-passphrase');
  for (const name of names.slice(-5)) fs.rmSync(path.join(dataPath, 'files', name));
  const archive = await pending;
  assert.equal(archive.fileCount, 15);
  const extracted = extractFullBackup(archive.buffer, 'correct-passphrase', path.join(root, 'extract'));
  assert.equal(fs.readdirSync(path.join(extracted.dataPath, 'files')).length, 15);
});

test('old full backups that still contain sessions/ are accepted; sessions are not restored', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-backup-old-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({ format: 'nexus-terminal-full-backup', version: 2, createdAt: new Date().toISOString(), root: 'data', fileCount: 3 })));
  zip.addFile('data/.env', Buffer.from('K=1\n'));
  zip.addFile('data/nexus-terminal.db', Buffer.from('DB'));
  zip.addFile('data/sessions/old.json', Buffer.from('{"cookie":{}}'));
  const buffer = encryptLikeV2(zip.toBuffer(), 'correct-passphrase');

  const extracted = extractFullBackup(buffer, 'correct-passphrase', path.join(root, 'extract'));
  assert.equal(extracted.manifest.fileCount, 3);
  assert.equal(fs.readFileSync(path.join(extracted.dataPath, '.env'), 'utf8'), 'K=1\n');
  assert.equal(fs.existsSync(path.join(extracted.dataPath, 'sessions')), false);
});
