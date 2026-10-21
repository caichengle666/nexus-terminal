// dotenv 18: the "injected env" banner moved from console.log to console.error, .env.vault support and
// preloading were removed. src/index.ts relies on: config({ path, quiet: true }) staying silent,
// a missing file surfacing as result.error.code === 'ENOENT', parsing quoted / # values as before,
// and existing process.env values not being overwritten.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const dotenv = require('dotenv');

const captureConsole = fn => {
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...args) => lines.push(`${k}: ${args.join(' ')}`);
  try { return { result: fn(), lines }; } finally { Object.assign(console, orig); }
};

test('missing .env reports ENOENT and logs nothing with quiet: true', () => {
  const missing = path.join(os.tmpdir(), `nexus-no-such-${process.pid}`, '.env');
  const { result, lines } = captureConsole(() => dotenv.config({ path: missing, quiet: true }));
  assert.equal(result.error && result.error.code, 'ENOENT');
  assert.deepEqual(lines, []);
});

test('existing .env is parsed and injected without console output or overriding existing vars', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-dotenv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, [
    'NEXUS_DOTENV_A=plain',
    'NEXUS_DOTENV_B="quoted # not a comment"',
    'NEXUS_DOTENV_C=value # trailing comment',
    'NEXUS_DOTENV_EXISTING=from-file',
  ].join('\n'));
  process.env.NEXUS_DOTENV_EXISTING = 'from-env';
  t.after(() => {
    for (const k of ['A', 'B', 'C', 'EXISTING']) delete process.env[`NEXUS_DOTENV_${k}`];
  });
  const { result, lines } = captureConsole(() => dotenv.config({ path: file, quiet: true }));
  assert.equal(result.error, undefined);
  assert.deepEqual(lines, []);
  assert.equal(process.env.NEXUS_DOTENV_A, 'plain');
  assert.equal(process.env.NEXUS_DOTENV_B, 'quoted # not a comment');
  assert.equal(process.env.NEXUS_DOTENV_C, 'value');
  assert.equal(process.env.NEXUS_DOTENV_EXISTING, 'from-env');
});
