const assert = require('node:assert/strict');
const test = require('node:test');
const https = require('node:https');

const { extractExpectedChecksum } = require('../update-verification');
const { requestWithRedirect } = require('../update-network');

const installerHash = 'b29261bf45a3354a0eb14e1aa5fe32461f52e8e7cd9fcf0a73af2dfeefce78d4';
const portableHash = 'e47668d8c32a34950bfdf6ac328d297f2e6ff98482580de3acdc5e46680a8318';

test('extracts an exact checksum filename match', () => {
  const manifest = `${portableHash}  Nexus Terminal Portable win-unpacked.zip`;
  assert.equal(extractExpectedChecksum(manifest, 'Nexus Terminal Portable win-unpacked.zip'), portableHash);
});

test('matches GitHub release filenames when spaces are normalized to dots', () => {
  const manifest = `${installerHash}  Nexus Terminal Setup 0.9.22.28.exe`;
  assert.equal(extractExpectedChecksum(manifest, 'Nexus.Terminal.Setup.0.9.22.28.exe'), installerHash);
});

test('does not match unrelated filenames', () => {
  const manifest = `${installerHash}  Nexus Terminal Setup 0.9.22.28.exe`;
  assert.equal(extractExpectedChecksum(manifest, 'Nexus.Terminal.Setup.0.9.22.29.exe'), null);
});

test('rejects ambiguous normalized filename matches', () => {
  const manifest = [
    `${installerHash}  Nexus Terminal Setup 0.9.22.28.exe`,
    `${portableHash}  Nexus.Terminal.Setup.0.9.22.28.exe`,
  ].join('\n');
  assert.equal(extractExpectedChecksum(manifest, 'Nexus.Terminal.Setup.0.9.22.28.exe'), null);
});

test('rejects when the update request reports socket hang up', async () => {
  const originalRequest = https.request;
  https.request = (_url, _options, callback) => {
    const request = {
      setTimeout() {},
      on(event, listener) {
        if (event === 'error') setImmediate(() => listener(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })));
        return request;
      },
      end() {
        void callback;
      },
    };
    return request;
  };
  try {
    await assert.rejects(
      requestWithRedirect('https://github.com/example/update.zip'),
      /socket hang up/,
    );
  } finally {
    https.request = originalRequest;
  }
});
