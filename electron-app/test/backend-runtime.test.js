'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getBackendSpawnSpec } = require('../backend-runtime');

test('backend runs on the Electron binary in Node mode', () => {
  const spec = getBackendSpawnSpec({
    execPath: 'C:\\Apps\\Nexus Terminal\\Nexus Terminal.exe',
    entryPath: 'C:\\Apps\\Nexus Terminal\\resources\\packages\\backend\\dist\\index.js',
    env: { PORT: '18111', NODE_OPTIONS: '--inspect', ELECTRON_RUN_AS_NODE: '0' },
  });
  assert.equal(spec.command, 'C:\\Apps\\Nexus Terminal\\Nexus Terminal.exe');
  assert.deepEqual(spec.args, ['C:\\Apps\\Nexus Terminal\\resources\\packages\\backend\\dist\\index.js']);
  assert.equal(spec.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(spec.env.PORT, '18111');
  assert.equal('NODE_OPTIONS' in spec.env, false);
});

test('missing paths fail loudly', () => {
  assert.throws(() => getBackendSpawnSpec({ execPath: '', entryPath: 'x', env: {} }));
  assert.throws(() => getBackendSpawnSpec({ execPath: 'x', entryPath: '', env: {} }));
});

test('runAsNode fuse stays on and no separate Node.js runtime is packaged', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.build.electronFuses.runAsNode, true);
  assert.equal(pkg.build.extraResources.some(r => /nodejs-runtime/.test(r.from || '')), false);
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.equal(main.includes('nodejs-runtime'), false);
});
