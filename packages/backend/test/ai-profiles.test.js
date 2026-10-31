const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_AI_PROFILE_ID,
  DEFAULT_AI_PROFILE_NAME,
  MAX_AI_PROFILES,
  addProfile,
  findProfile,
  normalizeProfileName,
  parseStoredAiConfig,
  removeProfile,
  serializeAiConfig,
  setActiveProfile,
  toClientConfig,
} = require('../dist/ai/ai-profiles.js');
const { AiConfigValidationError } = require('../dist/ai/ai-config.validation.js');

const legacyRaw = JSON.stringify({
  apiBaseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4.1-mini',
  encryptedApiKey: 'enc:legacy',
  customSystemPrompt: 'be brief',
});

test('legacy single config migrates to one "默认" profile', () => {
  const config = parseStoredAiConfig(legacyRaw);
  assert.equal(config.version, 2);
  assert.equal(config.activeProfileId, DEFAULT_AI_PROFILE_ID);
  assert.equal(config.customSystemPrompt, 'be brief');
  assert.equal(config.profiles.length, 1);
  assert.deepEqual(config.profiles[0], {
    id: DEFAULT_AI_PROFILE_ID,
    name: DEFAULT_AI_PROFILE_NAME,
    apiBaseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    encryptedApiKey: 'enc:legacy',
  });
  assert.equal(DEFAULT_AI_PROFILE_NAME, '默认');
});

test('missing / broken config yields one empty default profile', () => {
  for (const raw of [null, undefined, '', 'not json', '[]', '42']) {
    const config = parseStoredAiConfig(raw);
    assert.equal(config.profiles.length, 1, String(raw));
    assert.equal(config.profiles[0].id, DEFAULT_AI_PROFILE_ID);
    assert.equal(config.profiles[0].encryptedApiKey, '');
    assert.equal(config.activeProfileId, DEFAULT_AI_PROFILE_ID);
  }
});

test('client view never exposes encrypted keys, keeps hasApiKey per profile and legacy fields', () => {
  let config = parseStoredAiConfig(legacyRaw);
  config = addProfile(config, { id: 'p_local', name: 'Ollama', apiBaseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3', encryptedApiKey: '' });
  const client = toClientConfig(config);
  assert.equal(JSON.stringify(client).includes('enc:legacy'), false);
  assert.equal(JSON.stringify(client).includes('encryptedApiKey'), false);
  assert.deepEqual(client.profiles.map(p => [p.id, p.hasApiKey]), [['default', true], ['p_local', false]]);
  // Legacy top-level fields mirror the active profile.
  assert.equal(client.apiBaseUrl, 'https://api.openai.com/v1');
  assert.equal(client.model, 'gpt-4.1-mini');
  assert.equal(client.hasApiKey, true);
  const switched = toClientConfig(setActiveProfile(config, 'p_local'));
  assert.equal(switched.activeProfileId, 'p_local');
  assert.equal(switched.model, 'qwen3');
  assert.equal(switched.hasApiKey, false);
});

test('serialized v2 config round-trips and sanitizes bad entries', () => {
  const config = addProfile(parseStoredAiConfig(legacyRaw), { id: 'p_two', name: 'Two', apiBaseUrl: '', model: 'm', encryptedApiKey: 'enc:2', streamUsageUnsupported: true }, true);
  const again = parseStoredAiConfig(serializeAiConfig(config));
  assert.deepEqual(again, config);

  const dirty = parseStoredAiConfig(JSON.stringify({
    activeProfileId: 'gone',
    profiles: [
      { id: 'ok', name: '  Named  ', apiBaseUrl: 1, model: 'x', encryptedApiKey: null },
      { id: 'ok', name: 'duplicate' },
      { id: '../evil', name: 'bad id' },
      'junk',
      { id: 'noname' },
    ],
  }));
  assert.deepEqual(dirty.profiles.map(p => [p.id, p.name, p.apiBaseUrl, p.encryptedApiKey]), [['ok', 'Named', '', ''], ['noname', 'noname', '', '']]);
  assert.equal(dirty.activeProfileId, 'ok', 'unknown active id falls back to the first profile');
  assert.equal(parseStoredAiConfig(JSON.stringify({ profiles: [] })).profiles[0].id, DEFAULT_AI_PROFILE_ID);
});

test('findProfile: unknown id is a 404, empty id means the active profile', () => {
  const config = setActiveProfile(addProfile(parseStoredAiConfig(legacyRaw), { id: 'p_b', name: 'B', apiBaseUrl: '', model: '', encryptedApiKey: '' }), 'p_b');
  assert.equal(findProfile(config).id, 'p_b');
  assert.equal(findProfile(config, '').id, 'p_b');
  assert.equal(findProfile(config, 'default').id, 'default');
  assert.throws(() => findProfile(config, 'nope'), err => err instanceof AiConfigValidationError && err.status === 404);
});

test('removing profiles keeps at least one and re-points the active profile', () => {
  let config = addProfile(parseStoredAiConfig(legacyRaw), { id: 'p_b', name: 'B', apiBaseUrl: '', model: '', encryptedApiKey: '' }, true);
  assert.equal(config.activeProfileId, 'p_b');
  config = removeProfile(config, 'p_b');
  assert.equal(config.activeProfileId, 'default');
  assert.deepEqual(config.profiles.map(p => p.id), ['default']);
  assert.throws(() => removeProfile(config, 'default'), err => err instanceof AiConfigValidationError && err.status === 400);
});

test('profile limit and duplicate ids are rejected', () => {
  let config = parseStoredAiConfig('');
  for (let index = 1; index < MAX_AI_PROFILES; index += 1) {
    config = addProfile(config, { id: `p_${index}`, name: `P${index}`, apiBaseUrl: '', model: '', encryptedApiKey: '' });
  }
  assert.equal(config.profiles.length, MAX_AI_PROFILES);
  assert.throws(() => addProfile(config, { id: 'p_extra', name: 'x', apiBaseUrl: '', model: '', encryptedApiKey: '' }), AiConfigValidationError);
  assert.throws(() => addProfile(parseStoredAiConfig(''), { id: 'default', name: 'dup', apiBaseUrl: '', model: '', encryptedApiKey: '' }), AiConfigValidationError);
});

test('profile names are trimmed and length-limited', () => {
  assert.equal(normalizeProfileName(undefined, 'fallback'), 'fallback');
  assert.equal(normalizeProfileName('  DeepSeek  ', 'x'), 'DeepSeek');
  assert.throws(() => normalizeProfileName('   ', 'x'), AiConfigValidationError);
  assert.throws(() => normalizeProfileName('x'.repeat(65), 'x'), AiConfigValidationError);
  assert.throws(() => normalizeProfileName(42, 'x'), AiConfigValidationError);
});
