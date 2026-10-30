const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const afterPack = require('../scripts/after-pack');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const makeAppDir = (names) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-afterpack-'));
  for (const name of names) fs.writeFileSync(path.join(dir, name), 'x');
  return dir;
};
const ALL = ['Nexus Terminal.exe', 'dxcompiler.dll', 'dxil.dll', 'd3dcompiler_47.dll', 'libEGL.dll', 'libGLESv2.dll', 'vk_swiftshader.dll', 'vulkan-1.dll'];

test('afterPack hook is wired into the electron-builder config and not packaged', () => {
  assert.equal(pkg.build.afterPack, 'scripts/after-pack.js');
  assert.ok(!pkg.build.files.some(entry => entry.startsWith('scripts')), 'build scripts must not be packaged');
});

test('Windows: removes only the WebGPU shader compiler DLLs', async () => {
  const dir = makeAppDir(ALL);
  await afterPack({ electronPlatformName: 'win32', appOutDir: dir });
  const left = fs.readdirSync(dir).sort();
  assert.deepEqual(left, ALL.filter(name => !['dxcompiler.dll', 'dxil.dll'].includes(name)).sort());
});

test('macOS and Linux builds are left untouched', async () => {
  for (const platform of ['darwin', 'linux', 'mas']) {
    const dir = makeAppDir(ALL);
    await afterPack({ electronPlatformName: platform, appOutDir: dir });
    assert.deepEqual(fs.readdirSync(dir).sort(), [...ALL].sort(), platform);
  }
});

test('Windows: fails the build when an ANGLE/D3D DLL needed for GPU acceleration is missing', async () => {
  const dir = makeAppDir(ALL.filter(name => name !== 'libGLESv2.dll'));
  await assert.rejects(afterPack({ electronPlatformName: 'win32', appOutDir: dir }), /libGLESv2\.dll/);
});
