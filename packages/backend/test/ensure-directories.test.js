const assert = require('node:assert/strict');
const test = require('node:test');

const { ensureRemoteDirectories, parentRemoteDir } = require('../dist/sftp/ensure-directories.js');

/** 内存里的假 SFTP：dirs/files 两个集合，mkdir 已存在时报错（与真实 SFTP 一致） */
const fakeSftp = (dirs = ['/'], files = []) => {
  const d = new Set(dirs);
  const f = new Set(files);
  const calls = [];
  return {
    d, f, calls,
    mkdir(path, cb) {
      calls.push(path);
      const parent = path.substring(0, path.lastIndexOf('/')) || '/';
      if (d.has(path) || f.has(path)) return cb(new Error('Failure'));
      if (!d.has(parent)) return cb(new Error('No such file'));
      d.add(path);
      cb();
    },
    stat(path, cb) {
      if (d.has(path)) return cb(null, { isDirectory: () => true });
      if (f.has(path)) return cb(null, { isDirectory: () => false });
      cb(new Error('No such file'));
    },
  };
};

test('逐级创建缺失的多层目录', async () => {
  const sftp = fakeSftp(['/', '/home']);
  await ensureRemoteDirectories(sftp, '/home/u/a/b');
  assert.ok(sftp.d.has('/home/u') && sftp.d.has('/home/u/a') && sftp.d.has('/home/u/a/b'));
});

test('已存在的目录直接跳过', async () => {
  const sftp = fakeSftp(['/', '/home', '/home/u']);
  await ensureRemoteDirectories(sftp, '/home/u');
  assert.deepEqual(sftp.calls, ['/home', '/home/u']);
});

test('中间被同名文件挡住时报错，不继续往下建', async () => {
  const sftp = fakeSftp(['/', '/home'], ['/home/u']);
  await assert.rejects(() => ensureRemoteDirectories(sftp, '/home/u/a'));
  assert.equal(sftp.d.has('/home/u/a'), false);
});

test('拒绝相对路径与 .. 片段', async () => {
  const sftp = fakeSftp();
  await assert.rejects(() => ensureRemoteDirectories(sftp, 'a/b'));
  await assert.rejects(() => ensureRemoteDirectories(sftp, '/a/../b'));
  assert.deepEqual(sftp.calls, []);
});

test('parentRemoteDir', () => {
  assert.equal(parentRemoteDir('/a/b'), '/a');
  assert.equal(parentRemoteDir('/a'), '/');
});
