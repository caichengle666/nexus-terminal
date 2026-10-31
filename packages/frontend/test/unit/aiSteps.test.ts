import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectTurnSteps,
  createStep,
  findToolCallOwner,
  finishStep,
  retryTruncateIndex,
  stepStatusFromRun,
  summarizeToolArgs,
  upsertStep,
} from '../../src/stores/ai/ai.steps';
import { stripUiOnlyMessageFields } from '../../src/stores/ai/ai.tools';
import type { AiChatMessage } from '../../src/stores/ai/ai.types';

const call = (id: string, name = 'execute_command') => ({ id, type: 'function' as const, function: { name, arguments: '{}' } });

test('retry truncates right after the user message that started the turn', () => {
  const messages: AiChatMessage[] = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: '', tool_calls: [call('t1')] },
    { role: 'tool', tool_call_id: 't1', content: '{}' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'q3' },
    { role: 'assistant', content: 'a3' },
  ];
  assert.equal(retryTruncateIndex(messages, 5), 3);
  assert.equal(retryTruncateIndex(messages, 1), 1);
  assert.equal(retryTruncateIndex(messages, 7), 7);
  assert.equal(retryTruncateIndex([{ role: 'assistant', content: 'x' }], 0), -1);
  assert.equal(retryTruncateIndex(messages, 99), -1);
});

test('step status maps cancelled runs to denied unless the run was stopped', () => {
  assert.equal(stepStatusFromRun({ status: 'done' }), 'ok');
  assert.equal(stepStatusFromRun({ status: 'error' }), 'error');
  assert.equal(stepStatusFromRun({ status: 'cancelled' }), 'denied');
  assert.equal(stepStatusFromRun({ status: 'cancelled' }, true), 'cancelled');
  assert.equal(stepStatusFromRun({ status: 'running' }), 'running');
});

test('steps are recorded on the owning message and finished with duration', () => {
  const owner: AiChatMessage = { role: 'assistant', content: '', tool_calls: [call('c1'), call('c2', 'read_remote_file')] };
  const messages: AiChatMessage[] = [{ role: 'user', content: 'go' }, owner];
  assert.equal(findToolCallOwner(messages, 'c2'), owner);
  assert.equal(findToolCallOwner(messages, 'nope'), undefined);
  const step = upsertStep(owner, createStep('c1', 'execute_command', { command: 'uptime' }, 1000));
  assert.equal(step.status, 'running');
  assert.equal(step.summary, 'uptime');
  finishStep(step, { name: 'execute_command', status: 'done', args: { command: 'uptime' }, startedAt: 1000, finishedAt: 1450 });
  assert.equal(owner.steps?.[0].status, 'ok');
  assert.equal(owner.steps?.[0].durationMs, 450);
  upsertStep(owner, createStep('c2', 'read_remote_file', { path: '/etc/hosts' }, 2000));
  assert.equal(owner.steps?.length, 2);
  // re-upsert replaces instead of duplicating
  upsertStep(owner, { ...owner.steps![1], status: 'error' });
  assert.equal(owner.steps?.length, 2);
  assert.equal(owner.steps?.[1].status, 'error');
});

test('long arguments are summarized to one short line', () => {
  const summary = summarizeToolArgs('terminal_input', { text: `echo ${'x'.repeat(300)}\nls` });
  assert.ok(summary.length <= 120);
  assert.ok(!summary.includes('\n'));
  assert.equal(summarizeToolArgs('unknown_tool', { a: 1 }), '');
});

test('turn steps are grouped onto the last visible reply of each turn', () => {
  const toolOnly: AiChatMessage = { role: 'assistant', content: '', tool_calls: [call('a')], steps: [{ id: 'a', name: 'execute_command', summary: 'ls', status: 'ok', startedAt: 1 }] };
  const finalReply: AiChatMessage = { role: 'assistant', content: 'done' };
  const second: AiChatMessage = { role: 'assistant', content: 'plain' };
  const messages: AiChatMessage[] = [
    { role: 'user', content: 'q' }, toolOnly, { role: 'tool', tool_call_id: 'a', content: '{}' }, finalReply,
    { role: 'user', content: 'q2' }, second,
  ];
  const visible = (m: AiChatMessage) => !!m.content?.trim() || !m.tool_calls?.length;
  const grouped = collectTurnSteps(messages, visible);
  assert.equal(grouped.get(finalReply)?.length, 1);
  assert.equal(grouped.has(second), false);
  assert.equal(grouped.has(toolOnly), false);
});

test('steps and reported model are never sent to the model', () => {
  const stripped = stripUiOnlyMessageFields({ role: 'assistant', content: 'x', steps: [{ id: 'a' }], model: 'gpt-x' } as Record<string, unknown>);
  assert.deepEqual(stripped, { role: 'assistant', content: 'x' });
});
