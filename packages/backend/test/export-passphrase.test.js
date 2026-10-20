const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-export-pass-'));
process.env.APP_BACKEND_DATA_PATH = dataDir;
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

const ImportExport = require('../dist/services/import-export.service.js'); // registers 'zip-encrypted'
const archiver = require('archiver');
const { getDbInstance } = require('../dist/database/connection.js');

test.after(async () => {
  try { const db = await getDbInstance(); await new Promise(r => db.close(() => r())); } catch { /* ignore */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const makeZip = async (password, files) => {
  const a = archiver.create('zip-encrypted', { zlib: { level: 9 }, encryptionMethod: 'aes256', password });
  const bufs = [];
  a.on('data', c => bufs.push(c));
  for (const [name, content] of Object.entries(files)) a.append(content, { name });
  await a.finalize();
  return Buffer.concat(bufs);
};

test('export zip is encrypted with the user passphrase and is importable', async () => {
  await assert.rejects(ImportExport.exportConnectionsAsPassphraseZip('short'), /至少/);
  const zip = await ImportExport.exportConnectionsAsPassphraseZip('my-export-pass');
  assert.throws(() => ImportExport.resolveImportPayload(zip), err => err.code === 'IMPORT_PASSPHRASE_INVALID');
  assert.throws(() => ImportExport.resolveImportPayload(zip, 'wrong-pass'), err => err.code === 'IMPORT_PASSPHRASE_INVALID');
  const json = JSON.parse(ImportExport.resolveImportPayload(zip, 'my-export-pass').toString('utf8'));
  assert.equal(json.version, 2);
  assert.ok(Array.isArray(json.connections));
});

test('plain JSON uploads pass through unchanged', () => {
  const buf = Buffer.from('{"connections":[]}');
  assert.equal(ImportExport.resolveImportPayload(buf), buf);
});

test('legacy ENCRYPTION_KEY zip with connections.txt is still importable', async () => {
  const script = [
    'root@10.0.0.1:22 -type SSH -name "web server" -p "pa ss\\"word" -tags prod "eu west" -note "hello world"',
    'admin@db.local:2222 -type SSH -k mykey -passphrase kp',
    'u@win.local:3389 -type RDP -p rdp',
  ].join('\n');
  const zip = await makeZip(process.env.ENCRYPTION_KEY, { 'connections.txt': script, 'ssh_keys/mykey.txt': 'PRIVATE KEY' });
  const json = JSON.parse(ImportExport.resolveImportPayload(zip, 'irrelevant-user-pass').toString('utf8'));
  assert.equal(json.connections.length, 3);
  const [web, db, rdp] = json.connections;
  assert.deepEqual(
    { name: web.name, host: web.host, port: web.port, username: web.username, password: web.password, tags: web.tag_names, notes: web.notes },
    { name: 'web server', host: '10.0.0.1', port: 22, username: 'root', password: 'pa ss"word', tags: ['prod', 'eu west'], notes: 'hello world' },
  );
  assert.equal(db.auth_method, 'key');
  assert.equal(db.ssh_key_name, 'mykey');
  assert.equal(db.port, 2222);
  assert.deepEqual(json.ssh_keys, [{ name: 'mykey', private_key: 'PRIVATE KEY', passphrase: 'kp' }]);
  assert.equal(rdp.type, 'RDP');
  assert.equal(rdp.password, 'rdp');
});
