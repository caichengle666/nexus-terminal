const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { TransfersService } = require('../dist/transfers/transfers.service.js');

const toLocalPath = (root, remotePath) => path.join(root, remotePath.replace(/^\/+/, ''));

const createMockSftp = root => ({
  createReadStream(remotePath, options) {
    return fs.createReadStream(toLocalPath(root, remotePath), options);
  },
  createWriteStream(remotePath, options) {
    return fs.createWriteStream(toLocalPath(root, remotePath), options);
  },
  lstat(remotePath, callback) {
    fs.lstat(toLocalPath(root, remotePath), callback);
  },
  unlink(remotePath, callback) {
    fs.unlink(toLocalPath(root, remotePath), callback);
  },
  rename(oldPath, newPath, callback) {
    fs.rename(toLocalPath(root, oldPath), toLocalPath(root, newPath), callback);
  },
  chmod(remotePath, mode, callback) {
    fs.chmod(toLocalPath(root, remotePath), mode, callback);
  },
});

const createEntry = (sourcePath, targetPath, content) => ({
  sourcePath,
  targetPath,
  type: 'file',
  size: content.length,
  mode: 0o100640,
  mtime: 1234567890,
});

test('SFTP relay transfers, resumes, replaces, and handles empty files', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-transfer-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source');
  const targetRoot = path.join(root, 'target');
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(path.join(targetRoot, 'dest'), { recursive: true });

  const service = new TransfersService();
  const sourceSftp = createMockSftp(sourceRoot);
  const targetSftp = createMockSftp(targetRoot);
  const content = Buffer.from('nexus-sftp-relay-content');
  fs.writeFileSync(path.join(sourceRoot, 'source.bin'), content);
  fs.writeFileSync(path.join(targetRoot, 'dest', 'file.bin'), 'old-content');
  const entry = createEntry('/source.bin', '/dest/file.bin', content);

  await service.transferFile(sourceSftp, targetSftp, entry, new AbortController().signal, () => {});
  assert.deepEqual(fs.readFileSync(path.join(targetRoot, 'dest', 'file.bin')), content);

  fs.unlinkSync(path.join(targetRoot, 'dest', 'file.bin'));
  const fingerprint = crypto.createHash('sha256')
    .update(`${entry.sourcePath}\0${entry.size}\0${entry.mtime}`)
    .digest('hex')
    .slice(0, 12);
  const partPath = path.join(targetRoot, 'dest', `file.bin.nexus-transfer.${fingerprint}.part`);
  fs.writeFileSync(partPath, content.subarray(0, 7));
  const progress = [];
  await service.transferFile(sourceSftp, targetSftp, entry, new AbortController().signal, (bytes, delta) => {
    progress.push({ bytes, delta });
  });
  assert.deepEqual(fs.readFileSync(path.join(targetRoot, 'dest', 'file.bin')), content);
  assert.deepEqual(progress[0], { bytes: 7, delta: 0 });

  fs.writeFileSync(path.join(sourceRoot, 'empty.bin'), Buffer.alloc(0));
  const emptyEntry = createEntry('/empty.bin', '/dest/empty.bin', Buffer.alloc(0));
  await service.transferFile(sourceSftp, targetSftp, emptyEntry, new AbortController().signal, () => {});
  assert.equal(fs.statSync(path.join(targetRoot, 'dest', 'empty.bin')).size, 0);
});

test('target path mapping cannot escape the selected directory', () => {
  const service = new TransfersService();
  assert.equal(service.safeJoinTargetPath('/uploads', 'folder/file.txt'), '/uploads/folder/file.txt');
  assert.throws(
    () => service.safeJoinTargetPath('/uploads', '../outside.txt'),
    /目标路径超出指定目录/,
  );
});
