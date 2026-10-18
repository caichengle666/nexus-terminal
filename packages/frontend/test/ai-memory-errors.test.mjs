import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

if (!process.env.AI_MEMORY_MODULE || !process.env.AI_ERRORS_MODULE) {
  throw new Error('Run via test/run-ai-tools-test.mjs (AI_MEMORY_MODULE / AI_ERRORS_MODULE not set).');
}
const memory = await import(pathToFileURL(process.env.AI_MEMORY_MODULE).href);
const errors = await import(pathToFileURL(process.env.AI_ERRORS_MODULE).href);
const { connectionMemoryKey, findOrphanMemoryKey, pruneOrphanMemories, isOrphanMemoryKey } = memory;
const { isRetryableAiError, isStreamUnsupportedError, describeAiError } = errors;

const mem = (extra = {}) => ({ messages: [{ role: 'user', content: 'hi' }], toolRuns: [], summary: '', ...extra });
const httpError = (status, data = {}) => ({ message: 'x', response: { status, data } });

test('connection memory keys are stable and slot-aware', () => {
  assert.equal(connectionMemoryKey('12'), 'conn:12');
  assert.equal(connectionMemoryKey('12', 1), 'conn:12#2');
  assert.equal(isOrphanMemoryKey('lx9abc'), true);
  assert.equal(isOrphanMemoryKey('global'), false);
  assert.equal(isOrphanMemoryKey('conn:12'), false);
});

test('findOrphanMemoryKey adopts the most recent orphan of the same connection', () => {
  const memories = {
    'conn:1': mem({ connectionId: '1', updatedAt: 999 }),
    old: mem({ connectionId: '1', updatedAt: 10 }),
    newer: mem({ connectionId: '1', updatedAt: 20 }),
    other: mem({ connectionId: '2', updatedAt: 30 }),
    legacy: mem({ toolRuns: [{ id: 'a', name: 'get_terminal_output', args: {}, status: 'done', startedAt: 40, result: { connectionName: 'web-1' } }] }),
    empty: { messages: [], toolRuns: [], summary: '' },
  };
  assert.equal(findOrphanMemoryKey(memories, { connectionId: '1' }), 'newer');
  assert.equal(findOrphanMemoryKey(memories, { connectionId: '3' }), null);
  // Legacy entries (no connectionId) only match by an unambiguous name.
  assert.equal(findOrphanMemoryKey(memories, { connectionId: '3', connectionName: 'web-1' }), 'legacy');
  assert.equal(findOrphanMemoryKey(memories, { connectionId: '3', connectionName: 'db' }), null);
});

test('pruneOrphanMemories drops empty, stale and excess orphans only', () => {
  const now = 100 * 24 * 3600 * 1000;
  const memories = {
    global: { messages: [], toolRuns: [], summary: '' },
    'conn:1': { messages: [], toolRuns: [], summary: '' },
    empty: { messages: [], toolRuns: [], summary: '' },
    stale: mem({ updatedAt: now - 31 * 24 * 3600 * 1000 }),
    a: mem({ updatedAt: now - 1 }),
    b: mem({ updatedAt: now - 2 }),
    c: mem({ updatedAt: now - 3 }),
  };
  const removed = pruneOrphanMemories(memories, { now, maxOrphans: 2 });
  assert.deepEqual(removed.sort(), ['c', 'empty', 'stale']);
  assert.deepEqual(Object.keys(memories).sort(), ['a', 'b', 'conn:1', 'global']);
});

test('auth / quota / bad request errors are never retried', () => {
  for (const status of [400, 401, 402, 403, 404, 422, 424]) {
    assert.equal(isRetryableAiError(httpError(status)), false, `status ${status}`);
  }
  assert.equal(isRetryableAiError(httpError(502, { code: 'AI_AUTH' })), false);
  assert.equal(isRetryableAiError(httpError(429, { code: 'AI_RATE_LIMIT' })), true);
  assert.equal(isRetryableAiError(httpError(503)), true);
  assert.equal(isRetryableAiError(new TypeError('Failed to fetch')), true);
});

test('non-stream fallback only when streaming is really unsupported', () => {
  assert.equal(isStreamUnsupportedError(httpError(422, { code: 'AI_STREAM_UNSUPPORTED' })), true);
  assert.equal(isStreamUnsupportedError(httpError(424, { code: 'AI_AUTH', message: 'invalid key' })), false);
  assert.equal(isStreamUnsupportedError(httpError(400, { code: 'AI_BAD_REQUEST', message: 'stream bad' })), false);
  // Older backend without codes.
  assert.equal(isStreamUnsupportedError(httpError(400, { message: 'stream not supported' })), true);
  assert.equal(isStreamUnsupportedError(httpError(400, { message: 'invalid messages' })), false);
});

test('describeAiError names the cause and keeps the provider message', () => {
  const text = describeAiError(httpError(424, { code: 'AI_AUTH', message: 'Incorrect API key provided' }));
  assert.match(text, /uxAi\.errors\.withProvider/);
  assert.match(text, /uxAi\.errors\.auth/);
  assert.match(text, /Incorrect API key provided/);
  assert.match(describeAiError(httpError(429, { code: 'AI_RATE_LIMIT' })), /uxAi\.errors\.rateLimit/);
});
