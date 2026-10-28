'use strict';

// CI guard: the packaged backend runs on Electron's embedded Node.js (ELECTRON_RUN_AS_NODE),
// so its native modules must load there, not just under the Node.js that built them.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const electronPath = require('electron');

const backendDist = path.resolve(__dirname, '..', '..', 'packages', 'backend', 'dist');
const probe = `
const results = {};
const sqlite3 = require('sqlite3');
const db = new sqlite3.Database(':memory:');
db.close();
results.sqlite3 = 'ok';
const bcrypt = require('bcrypt');
if (!bcrypt.compareSync('nexus', bcrypt.hashSync('nexus', 4))) throw new Error('bcrypt mismatch');
results.bcrypt = 'ok';
require('ssh2');
results.ssh2 = 'ok';
console.log(process.versions.node, JSON.stringify(results));
`;

const result = spawnSync(electronPath, ['-e', probe], {
  cwd: backendDist,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8',
});
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.status !== 0) {
  console.error(`Backend native modules failed to load in Electron's Node.js (exit ${result.status}).`);
  process.exit(1);
}
