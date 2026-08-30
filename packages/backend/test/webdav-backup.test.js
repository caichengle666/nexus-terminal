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
