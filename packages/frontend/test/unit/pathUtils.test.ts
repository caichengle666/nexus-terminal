import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isPathLikeInput, parentOfRemotePath, resolveRemotePath } from '../../src/utils/pathUtils';

test('resolveRemotePath：单个名字拼到当前目录', () => {
  assert.equal(resolveRemotePath('/home/u', '1.txt'), '/home/u/1.txt');
  assert.equal(resolveRemotePath('/', 'a'), '/a');
});

test('resolveRemotePath：./ 相对路径与多级目录', () => {
  assert.equal(resolveRemotePath('/home/u', './asd/222/1.txt'), '/home/u/asd/222/1.txt');
  assert.equal(resolveRemotePath('/home/u/', 'a//b/./c/'), '/home/u/a/b/c');
});

test('resolveRemotePath：.. 回退，到根就停在根', () => {
  assert.equal(resolveRemotePath('/home/u', '../x'), '/home/x');
  assert.equal(resolveRemotePath('/home/u', '../../y'), '/y');
  assert.equal(resolveRemotePath('/home/u', '../../../etc/passwd'), '/etc/passwd');
  assert.equal(resolveRemotePath('/', '..'), '/');
});

test('resolveRemotePath：绝对路径原样（规范化）', () => {
  assert.equal(resolveRemotePath('/home/u', '/etc/nginx/a.conf'), '/etc/nginx/a.conf');
  assert.equal(resolveRemotePath('/home/u', '  /tmp//x/  '), '/tmp/x');
});

test('parentOfRemotePath：父目录', () => {
  assert.equal(parentOfRemotePath('/a/b/c'), '/a/b');
  assert.equal(parentOfRemotePath('/a'), '/');
  assert.equal(parentOfRemotePath('/'), '/');
});

test('isPathLikeInput：带 / 或 . / .. 视为路径写法', () => {
  assert.equal(isPathLikeInput('a.txt'), false);
  assert.equal(isPathLikeInput('./a.txt'), true);
  assert.equal(isPathLikeInput('a/b'), true);
  assert.equal(isPathLikeInput('..'), true);
});
