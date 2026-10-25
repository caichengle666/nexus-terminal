import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractVariableNames,
  getMissingVariableNames,
  prepareQuickCommandForSend,
  resolveCommandVariables,
} from '../../src/composables/quickCommands/quickCommandVariables';

test('getMissingVariableNames：未定义 / 空串 / 纯空白都算缺，按模板顺序去重', () => {
  const tpl = 'scp ${file} ${user}@${host}:${dir} && echo ${file}';
  assert.deepEqual(getMissingVariableNames(tpl, { user: 'root', host: '  ', dir: '' }), ['file', 'host', 'dir']);
  assert.deepEqual(getMissingVariableNames(tpl, null), ['file', 'user', 'host', 'dir']);
  assert.deepEqual(getMissingVariableNames('ls -la', {}), []);
});

test('extractVariableNames：去重并保持出现顺序', () => {
  assert.deepEqual(extractVariableNames('${a} ${b} ${a}'), ['a', 'b']);
});

test('resolveCommandVariables：值里的 $& / $1 不当替换模式，变量名含元字符不抛异常', () => {
  assert.equal(resolveCommandVariables('echo ${x}', { x: 'a$&b$1' }), 'echo a$&b$1');
  assert.equal(resolveCommandVariables('echo ${a.b}', { 'a.b': 'ok' }), 'echo ok');
  // 未定义的变量保持原样
  assert.equal(resolveCommandVariables('echo ${y}', {}), 'echo ${y}');
});

test('prepareQuickCommandForSend：变量齐全时不弹窗，直接替换', async () => {
  let prompted = 0;
  const out = await prepareQuickCommandForSend(
    { command: 'ping ${host}', variables: { host: '1.1.1.1' } },
    async () => { prompted++; return {}; }
  );
  assert.equal(out, 'ping 1.1.1.1');
  assert.equal(prompted, 0);
});

test('prepareQuickCommandForSend：缺变量时先补填再发送，补填值覆盖空值', async () => {
  const seen: string[] = [];
  const out = await prepareQuickCommandForSend(
    { name: 'tail', command: 'tail -n ${n} ${file}', variables: { n: '50', file: '' } },
    async (cmd) => { seen.push(cmd.name || ''); return { file: '/var/log/syslog' }; }
  );
  assert.deepEqual(seen, ['tail']);
  assert.equal(out, 'tail -n 50 /var/log/syslog');
});

test('prepareQuickCommandForSend：用户取消返回 null（调用方不发送）', async () => {
  const out = await prepareQuickCommandForSend({ command: 'rm -rf ${path}' }, async () => null);
  assert.equal(out, null);
});

test('prepareQuickCommandForSend：弹窗异常按取消处理，不抛出', async () => {
  const origError = console.error;
  console.error = () => {};
  try {
    const out = await prepareQuickCommandForSend({ command: 'rm -rf ${path}' }, async () => { throw new Error('boom'); });
    assert.equal(out, null);
  } finally {
    console.error = origError;
  }
});

test('prepareQuickCommandForSend：没有提供补填回调时保持旧行为（占位符原样）', async () => {
  const out = await prepareQuickCommandForSend({ command: 'echo ${x}' });
  assert.equal(out, 'echo ${x}');
});
