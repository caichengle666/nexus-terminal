const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DOCKER_CONTAINER_ID_PATTERN,
  assertValidContainerId,
  isValidContainerId,
} = require('../dist/docker/docker-validate.js');

test('accepts container IDs and names', () => {
  for (const id of [
    'a1b2c3d4e5f6',
    'f'.repeat(64),
    'my_container',
    'web-1',
    'app.service_2',
    'A',
    'a'.repeat(128),
  ]) {
    assert.equal(isValidContainerId(id), true, id);
    assert.equal(assertValidContainerId(id), id);
  }
});

test('rejects shell metacharacters and malformed IDs instead of stripping them', () => {
  for (const id of [
    'abc; rm -rf /',
    'abc && reboot',
    '$(id)',
    '`id`',
    'abc|sh',
    'abc def',
    "abc'",
    'abc\n',
    '-abc',
    '.abc',
    '_abc',
    '',
    'a'.repeat(129),
    'abc/def',
    '--format={{json .}}',
  ]) {
    assert.equal(isValidContainerId(id), false, JSON.stringify(id));
    assert.throws(() => assertValidContainerId(id), /Invalid container ID/);
  }
});

test('rejects non-string values', () => {
  for (const value of [undefined, null, 123, {}, ['abc']]) {
    assert.equal(isValidContainerId(value), false);
    assert.throws(() => assertValidContainerId(value), /Invalid container ID/);
  }
});

test('pattern is anchored', () => {
  assert.equal(DOCKER_CONTAINER_ID_PATTERN.source.startsWith('^'), true);
  assert.equal(DOCKER_CONTAINER_ID_PATTERN.source.endsWith('$'), true);
});
