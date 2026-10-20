const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.APP_BACKEND_DATA_PATH ||= fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-secrets-'));
process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString('hex');

const { filterSettingsForClient } = require('../dist/settings/settings.service.js');
const {
  SECRET_MASK, sealSecret, openSecret, isSealedSecret, isLegacyPlaintextSecret, maskSecret,
} = require('../dist/utils/secret-field.js');
const {
  sealNotificationConfig, openNotificationConfig, maskNotificationConfig,
  mergeMaskedNotificationConfig, hasLegacyPlaintextSecrets,
} = require('../dist/notifications/notification-secrets.js');

test('GET /settings drops secret-bearing keys', () => {
  const filtered = filterSettingsForClient({
    language: 'en-US',
    captchaConfig: '{"recaptchaSecretKey":"s"}',
    webdavBackupConfig: '{"password":"p"}',
    aiTerminalConfig: '{"apiKeyCiphertext":"x"}',
    someApiKey: 'x',
    smtpPassword: 'x',
    layoutTree: '{}',
  });
  assert.deepEqual(Object.keys(filtered).sort(), ['language', 'layoutTree']);
});

test('sealed secrets round-trip and legacy plaintext is read transparently', () => {
  const sealed = sealSecret('hunter2');
  assert.ok(isSealedSecret(sealed));
  assert.notEqual(sealed, 'hunter2');
  assert.equal(sealSecret(sealed), sealed, 'no double encryption');
  assert.equal(openSecret(sealed), 'hunter2');
  assert.equal(openSecret('legacy-plain'), 'legacy-plain');
  assert.equal(isLegacyPlaintextSecret('legacy-plain'), true);
  assert.equal(isLegacyPlaintextSecret(sealed), false);
  assert.equal(sealSecret(''), '');
  assert.equal(maskSecret(''), '');
  assert.equal(maskSecret('x'), SECRET_MASK);
  assert.equal(openSecret('enc:v1:not-valid-ciphertext'), '');
});

test('notification configs are masked for clients and masked values keep the stored secret', () => {
  const stored = {
    smtpHost: 'smtp.example.com', smtpPass: 'mail-pass', botToken: 'bot:123',
    headers: { Authorization: 'Bearer abc', 'X-Trace': 'keep-me' },
  };
  const masked = maskNotificationConfig(stored);
  assert.equal(masked.smtpHost, 'smtp.example.com');
  assert.equal(masked.smtpPass, SECRET_MASK);
  assert.equal(masked.botToken, SECRET_MASK);
  assert.deepEqual(masked.headers, { Authorization: SECRET_MASK, 'X-Trace': SECRET_MASK });

  const incoming = { ...masked, smtpHost: 'smtp2.example.com', botToken: 'bot:new', headers: { Authorization: SECRET_MASK, 'X-New': 'v', 'X-Ghost': SECRET_MASK } };
  const merged = mergeMaskedNotificationConfig(incoming, stored);
  assert.equal(merged.smtpHost, 'smtp2.example.com');
  assert.equal(merged.smtpPass, 'mail-pass');
  assert.equal(merged.botToken, 'bot:new');
  assert.deepEqual(merged.headers, { Authorization: 'Bearer abc', 'X-New': 'v' });

  const sealed = sealNotificationConfig(stored);
  assert.ok(isSealedSecret(sealed.smtpPass) && isSealedSecret(sealed.botToken) && isSealedSecret(sealed.headers.Authorization));
  assert.equal(sealed.smtpHost, 'smtp.example.com');
  assert.equal(hasLegacyPlaintextSecrets(sealed), false);
  assert.equal(hasLegacyPlaintextSecrets(stored), true);
  assert.deepEqual(openNotificationConfig(sealed), stored);
});
