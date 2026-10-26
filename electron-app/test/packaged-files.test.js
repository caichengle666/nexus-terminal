const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const files = new Set(pkg.build.files);

// Walk local requires starting at main.js / preload.js so a new module that is
// not listed in build.files fails here instead of crashing the packaged app
// with "Cannot find module".
test('every locally required main-process module is packaged', () => {
  const seen = new Set();
  const queue = [pkg.main || 'main.js', 'preload.js'];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const match of source.matchAll(/require\(\s*['"]\.\/([^'"]+)['"]\s*\)/g)) {
      let name = match[1];
      if (!path.extname(name)) name += '.js';
      queue.push(name);
    }
  }
  const missing = [...seen].filter(name => !files.has(name));
  assert.deepEqual(missing, [], `missing from build.files: ${missing.join(', ')}`);
});
