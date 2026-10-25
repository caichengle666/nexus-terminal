import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cancelQuickCommandVariablePrompt,
  promptQuickCommandVariables,
  quickCommandVariablePromptState,
  submitQuickCommandVariables,
} from '../../src/composables/quickCommands/useQuickCommandVariablePrompt';

test('promptQuickCommandVariables：没有缺失时不弹窗，立刻返回已有变量', async () => {
  const values = await promptQuickCommandVariables({ command: 'ls ${d}', variables: { d: '/tmp' } });
  assert.deepEqual(values, { d: '/tmp' });
  assert.equal(quickCommandVariablePromptState.value, null);
});

test('promptQuickCommandVariables：缺失时打开弹窗，提交后合并已有值并关闭', async () => {
  const pending = promptQuickCommandVariables({ name: 'cp', command: 'cp ${a} ${b}', variables: { a: 'x', b: '' } });
  assert.deepEqual(quickCommandVariablePromptState.value?.missing, ['b']);
  assert.equal(quickCommandVariablePromptState.value?.commandName, 'cp');
  submitQuickCommandVariables({ b: 'y' });
  assert.deepEqual(await pending, { a: 'x', b: 'y' });
  assert.equal(quickCommandVariablePromptState.value, null);
});

test('promptQuickCommandVariables：取消返回 null；再次弹窗会把上一个当成取消', async () => {
  const first = promptQuickCommandVariables({ command: 'echo ${a}' });
  const second = promptQuickCommandVariables({ command: 'echo ${b}' });
  assert.equal(await first, null);
  assert.deepEqual(quickCommandVariablePromptState.value?.missing, ['b']);
  cancelQuickCommandVariablePrompt();
  assert.equal(await second, null);
  assert.equal(quickCommandVariablePromptState.value, null);
});
