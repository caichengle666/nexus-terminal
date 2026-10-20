const assert = require('node:assert/strict');
const test = require('node:test');
const { Readable } = require('node:stream');
const { resolveAiError, readStreamBody, parseProviderErrorBody } = require('../dist/ai/ai-error.js');

const streamError = (status, body) => ({
  message: `Request failed with status code ${status}`,
  response: { status, data: Readable.from([Buffer.from(body)]) },
});

test('streamed 401 becomes 424 AI_AUTH with the provider message', async () => {
  const result = await resolveAiError(streamError(401, JSON.stringify({ error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } })), { streaming: true });
  assert.equal(result.status, 424);
  assert.equal(result.code, 'AI_AUTH');
  assert.equal(result.message, 'Incorrect API key provided');
  assert.equal(result.providerStatus, 401);
});

test('429 maps to AI_RATE_LIMIT, insufficient_quota to AI_QUOTA', async () => {
  const rate = await resolveAiError(streamError(429, '{"error":{"message":"Rate limit reached","type":"requests"}}'), { streaming: true });
  assert.equal(rate.status, 429);
  assert.equal(rate.code, 'AI_RATE_LIMIT');
  const quota = await resolveAiError({ response: { status: 429, data: { error: { message: 'You exceeded your current quota', type: 'insufficient_quota' } } } });
  assert.equal(quota.status, 402);
  assert.equal(quota.code, 'AI_QUOTA');
});

test('stream-unsupported is only reported when the provider says so', async () => {
  const unsupported = await resolveAiError(streamError(400, '{"error":{"message":"stream is not supported for this model"}}'), { streaming: true });
  assert.equal(unsupported.code, 'AI_STREAM_UNSUPPORTED');
  const badRequest = await resolveAiError(streamError(400, '{"error":{"message":"messages: invalid role"}}'), { streaming: true });
  assert.equal(badRequest.code, 'AI_BAD_REQUEST');
  assert.equal(badRequest.status, 400);
  const notFound = await resolveAiError(streamError(404, '{"error":{"message":"model not found"}}'), { streaming: true });
  assert.equal(notFound.code, 'AI_NOT_FOUND');
});

test('5xx and network failures', async () => {
  assert.equal((await resolveAiError(streamError(500, 'oops'))).status, 502);
  const timeout = await resolveAiError({ code: 'ECONNABORTED', message: 'timeout of 120000ms exceeded' });
  assert.equal(timeout.code, 'AI_TIMEOUT');
  const own = await resolveAiError(Object.assign(new Error('too big'), { status: 413 }));
  assert.equal(own.status, 413);
});

test('readStreamBody is bounded and times out', async () => {
  const big = Readable.from([Buffer.alloc(100 * 1024, 'a')]);
  assert.equal((await readStreamBody(big, 1024, 1000)).length, 1024);
  const never = new Readable({ read() {} });
  const started = Date.now();
  assert.equal(await readStreamBody(never, 1024, 50), '');
  assert.ok(Date.now() - started < 1000);
});

test('parseProviderErrorBody handles plain text and SSE error events', () => {
  // Plain-text bodies are not echoed to the client (they may come from an internal service).
  assert.equal(parseProviderErrorBody('Bad gateway').message, '');
  assert.equal(parseProviderErrorBody('data: {"error":{"message":"denied"}}\n\n').message, 'denied');
  assert.equal(parseProviderErrorBody('<html>err</html>').message, '');
});
