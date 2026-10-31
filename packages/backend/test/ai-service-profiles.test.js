// Service-level tests for AI model profiles: legacy migration through the settings DB,
// per-profile key binding, and the stream_options include_usage fallback.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// The mock provider runs on 127.0.0.1: never route it through an environment proxy.
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[key];
process.env.NO_PROXY = '127.0.0.1,localhost';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ai-profiles-'));
process.env.APP_BACKEND_DATA_PATH = dataDir;
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

const { getDbInstance } = require('../dist/database/connection.js');
const { settingsRepository } = require('../dist/settings/settings.repository.js');
const { encrypt } = require('../dist/utils/crypto.js');
const AiService = require('../dist/ai/ai.service.js');

let server;
let baseUrl;
const seen = [];
let rejectStreamOptions = true;

test.before(async () => {
  await getDbInstance();
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      seen.push({ url: req.url, auth: req.headers.authorization, body: json });
      if (rejectStreamOptions && json.stream_options) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: stream_options' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
});

test.after(async () => {
  server?.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const readStream = stream => new Promise((resolve, reject) => {
  let text = '';
  stream.on('data', chunk => { text += chunk; });
  stream.on('end', () => resolve(text));
  stream.on('error', reject);
});

test('legacy aiTerminalConfig is read as one "默认" profile and saved in the new shape', async () => {
  await settingsRepository.setSetting('aiTerminalConfig', JSON.stringify({
    apiBaseUrl: baseUrl,
    model: 'legacy-model',
    encryptedApiKey: encrypt('sk-legacy'),
    customSystemPrompt: 'keep it short',
  }));
  const config = await AiService.getConfig();
  assert.equal(config.profiles.length, 1);
  assert.equal(config.profiles[0].name, '默认');
  assert.equal(config.profiles[0].hasApiKey, true);
  assert.equal(config.activeProfileId, config.profiles[0].id);
  assert.equal(config.customSystemPrompt, 'keep it short');
  assert.equal(config.model, 'legacy-model');
  assert.equal(JSON.stringify(config).includes('sk-legacy'), false);

  // Empty key keeps the stored key; the setting is rewritten as version 2.
  const saved = await AiService.saveConfig({ apiBaseUrl: baseUrl, apiKey: '', model: 'legacy-model-2' });
  assert.equal(saved.profiles[0].hasApiKey, true);
  assert.equal(saved.model, 'legacy-model-2');
  const raw = JSON.parse(await settingsRepository.getSetting('aiTerminalConfig'));
  assert.equal(raw.version, 2);
  assert.equal(raw.profiles.length, 1);
  assert.equal(raw.customSystemPrompt, 'keep it short');
});

test('profiles can be created, switched, renamed and deleted; keys stay per profile', async () => {
  const created = await AiService.createProfile({ name: 'Second', apiBaseUrl: baseUrl, model: 'second-model', apiKey: 'sk-second' });
  const secondId = created.createdProfileId;
  assert.ok(secondId);
  assert.equal(created.profiles.length, 2);
  assert.equal(created.activeProfileId, 'default', 'creating does not switch unless asked');

  const switched = await AiService.activateProfile(secondId);
  assert.equal(switched.activeProfileId, secondId);
  assert.equal(switched.model, 'second-model');

  const renamed = await AiService.saveConfig({ profileId: secondId, name: 'Renamed', apiBaseUrl: baseUrl, apiKey: '' });
  assert.equal(renamed.profiles.find(p => p.id === secondId).name, 'Renamed');
  assert.equal(renamed.profiles.find(p => p.id === secondId).hasApiKey, true);

  // Changing a profile's base URL without a new key is rejected (key stays bound to its URL).
  await assert.rejects(
    AiService.saveConfig({ profileId: secondId, apiBaseUrl: 'https://elsewhere.example/v1', apiKey: '' }),
    err => err.status === 400,
  );
  await assert.rejects(AiService.saveConfig({ profileId: 'missing', model: 'x' }), err => err.status === 404);

  // Chat with an explicit profileId uses that profile's key; default uses the legacy key.
  rejectStreamOptions = false;
  seen.length = 0;
  const upstream = await AiService.forwardChatCompletionStream({ profileId: 'default', messages: [{ role: 'user', content: 'hi' }] });
  await readStream(upstream.data);
  assert.equal(seen[0].auth, 'Bearer sk-legacy');
  assert.equal(seen[0].body.model, 'legacy-model-2');
  assert.deepEqual(seen[0].body.stream_options, { include_usage: true });

  const afterDelete = await AiService.deleteProfile(secondId);
  assert.equal(afterDelete.profiles.length, 1);
  assert.equal(afterDelete.activeProfileId, 'default');
  await assert.rejects(AiService.deleteProfile('default'), err => err.status === 400);
});

test('a 400 for stream_options is retried once without it and remembered per profile', async () => {
  rejectStreamOptions = true;
  seen.length = 0;
  const first = await AiService.forwardChatCompletionStream({ messages: [{ role: 'user', content: 'hi' }] });
  assert.match(await readStream(first.data), /"ok"/);
  assert.equal(seen.length, 2);
  assert.ok(seen[0].body.stream_options);
  assert.equal(seen[1].body.stream_options, undefined);
  const raw = JSON.parse(await settingsRepository.getSetting('aiTerminalConfig'));
  assert.equal(raw.profiles[0].streamUsageUnsupported, true);

  seen.length = 0;
  const second = await AiService.forwardChatCompletionStream({ messages: [{ role: 'user', content: 'again' }] });
  await readStream(second.data);
  assert.equal(seen.length, 1, 'remembered: no second attempt with stream_options');
  assert.equal(seen[0].body.stream_options, undefined);
  // Never leaks to the client view.
  assert.equal(JSON.stringify(await AiService.getConfig()).includes('streamUsageUnsupported'), false);
});
