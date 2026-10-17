const assert = require('node:assert/strict');
const test = require('node:test');
const {
  AiConfigValidationError,
  decideStoredKeyOnSave,
  isSameApiBaseUrl,
  resolveAiCredentials,
  validateApiBaseUrl,
} = require('../dist/ai/ai-config.validation.js');

const stored = { apiBaseUrl: 'https://api.openai.com/v1', apiKey: 'sk-stored' };

test('validateApiBaseUrl accepts http(s) and strips trailing slashes', () => {
  assert.equal(validateApiBaseUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1');
  assert.equal(validateApiBaseUrl('  http://127.0.0.1:11434/v1  '), 'http://127.0.0.1:11434/v1');
  // Private / LAN hosts are allowed on purpose (local LLMs such as Ollama).
  assert.equal(validateApiBaseUrl('http://192.168.1.10:8000/v1'), 'http://192.168.1.10:8000/v1');
});

test('validateApiBaseUrl rejects other protocols, credentials and garbage', () => {
  for (const value of [
    '',
    undefined,
    'not a url',
    'file:///etc/passwd',
    'ftp://example.com',
    'gopher://127.0.0.1:6379/_FLUSHALL',
    'javascript:alert(1)',
    'https://user:pass@example.com/v1',
    'https://token@example.com/v1',
  ]) {
    assert.throws(() => validateApiBaseUrl(value), err => err instanceof AiConfigValidationError && err.status === 400, String(value));
  }
});

test('stored key is used only for the stored base URL', () => {
  const same = resolveAiCredentials({}, stored);
  assert.deepEqual(same, { apiBaseUrl: 'https://api.openai.com/v1', apiKey: 'sk-stored', usesStoredKey: true });
  const sameExplicit = resolveAiCredentials({ apiBaseUrl: 'https://API.openai.com:443/v1/' }, stored);
  assert.equal(sameExplicit.apiKey, 'sk-stored');
});

test('different base URL without its own key is rejected (no stored key exfiltration)', () => {
  assert.throws(
    () => resolveAiCredentials({ apiBaseUrl: 'https://attacker.example/v1' }, stored),
    err => err instanceof AiConfigValidationError && err.status === 400,
  );
  assert.throws(
    () => resolveAiCredentials({ apiBaseUrl: 'https://api.openai.com/v2', apiKey: '   ' }, stored),
    AiConfigValidationError,
  );
});

test('different base URL with its own key is allowed and never uses the stored key', () => {
  const result = resolveAiCredentials({ apiBaseUrl: 'http://localhost:11434/v1', apiKey: 'own-key' }, stored);
  assert.deepEqual(result, { apiBaseUrl: 'http://localhost:11434/v1', apiKey: 'own-key', usesStoredKey: false });
});

test('invalid payload base URL is rejected even with a key', () => {
  assert.throws(() => resolveAiCredentials({ apiBaseUrl: 'file:///etc/shadow', apiKey: 'x' }, stored), AiConfigValidationError);
});

test('no stored key: returns empty key so callers report missing key', () => {
  const result = resolveAiCredentials({ apiBaseUrl: 'https://other.example/v1' }, { apiBaseUrl: '', apiKey: '' });
  assert.equal(result.apiKey, '');
  assert.equal(result.usesStoredKey, false);
});

test('isSameApiBaseUrl normalizes case, default port and trailing slash', () => {
  assert.equal(isSameApiBaseUrl('https://Api.Example.com:443/v1/', 'https://api.example.com/v1'), true);
  assert.equal(isSameApiBaseUrl('https://api.example.com/v1', 'http://api.example.com/v1'), false);
  assert.equal(isSameApiBaseUrl('', ''), false);
});

test('saving a new base URL requires a new key when one is stored', () => {
  assert.equal(decideStoredKeyOnSave({ apiBaseUrl: 'https://api.openai.com/v1' }, { apiBaseUrl: stored.apiBaseUrl, hasApiKey: true }), 'keep');
  assert.equal(decideStoredKeyOnSave({ apiBaseUrl: 'https://new.example/v1', apiKey: 'k' }, { apiBaseUrl: stored.apiBaseUrl, hasApiKey: true }), 'replace');
  assert.equal(decideStoredKeyOnSave({ apiBaseUrl: 'https://new.example/v1' }, { apiBaseUrl: '', hasApiKey: false }), 'none');
  assert.throws(
    () => decideStoredKeyOnSave({ apiBaseUrl: 'https://attacker.example/v1' }, { apiBaseUrl: stored.apiBaseUrl, hasApiKey: true }),
    AiConfigValidationError,
  );
  assert.throws(
    () => decideStoredKeyOnSave({ apiBaseUrl: 'file:///x', apiKey: 'k' }, { apiBaseUrl: '', hasApiKey: false }),
    AiConfigValidationError,
  );
});
