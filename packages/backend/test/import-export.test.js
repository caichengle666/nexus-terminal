const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Isolated data dir + encryption key; must be set before loading dist modules.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-import-export-test-'));
process.env.APP_BACKEND_DATA_PATH = dataDir;
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

const { getDbInstance, runDb, getDb, allDb } = require('../dist/database/connection.js');
const ConnectionRepository = require('../dist/connections/connection.repository.js');
const ProxyRepository = require('../dist/proxies/proxy.repository.js');
const ImportExport = require('../dist/services/import-export.service.js');
const { encrypt } = require('../dist/utils/crypto.js');

test.after(async () => {
  try {
    const db = await getDbInstance();
    await new Promise(resolve => db.close(() => resolve()));
  } catch { /* ignore */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const clearConnections = async () => {
  const db = await getDbInstance();
  await runDb(db, 'DELETE FROM connection_tags');
  await runDb(db, 'DELETE FROM connections');
};

const baseConn = (name, extra = {}) => ({
  name,
  type: 'SSH',
  host: `${name}.example.com`,
  port: 22,
  username: 'root',
  auth_method: 'password',
  encrypted_password: encrypt(`${name}-pw`),
  proxy_id: null,
  proxy_type: null,
  notes: null,
  jump_chain: null,
  ...extra,
});

test('JSON export keeps notes, connection proxy_type and jump chain; import resolves jump chain to new IDs', async () => {
  await clearConnections();
  const proxyId = await ProxyRepository.createProxy({
    name: 'socks-proxy', type: 'SOCKS5', host: '10.0.0.1', port: 1080,
    username: null, auth_method: 'none', encrypted_password: null, encrypted_private_key: null, encrypted_passphrase: null,
  });
  const bastionId = await ConnectionRepository.createConnection(baseConn('bastion'));
  const innerId = await ConnectionRepository.createConnection(baseConn('inner', { proxy_type: 'jump', jump_chain: [bastionId], notes: 'behind bastion' }));
  await ConnectionRepository.createConnection(baseConn('proxied', { proxy_type: 'proxy', proxy_id: proxyId }));

  const exported = JSON.parse((await ImportExport.exportConnectionsAsJson()).toString('utf8'));
  const byName = Object.fromEntries(exported.connections.map(c => [c.name, c]));

  assert.equal(byName.inner.notes, 'behind bastion');
  assert.equal(byName.inner.proxy_type, 'jump');
  assert.deepEqual(byName.inner.jump_chain_names, ['bastion']);
  assert.deepEqual(byName.inner.jump_chain, [bastionId]);
  assert.equal(byName.inner.id, innerId);
  // Connection's own proxy_type must not be clobbered by the proxy server type.
  assert.equal(byName.proxied.proxy_type, 'proxy');
  assert.equal(byName.proxied.proxy.type, 'SOCKS5');
  assert.equal(byName.bastion.jump_chain, undefined);

  // Import into an empty instance (IDs change).
  await clearConnections();
  const db = await getDbInstance();
  await runDb(db, "INSERT INTO connections (name, type, host, port, username, auth_method, created_at, updated_at) VALUES ('filler', 'SSH', 'f', 22, 'u', 'password', 0, 0)");

  const result = await ImportExport.importConnections(Buffer.from(JSON.stringify(exported)));
  assert.equal(result.failureCount, 0, JSON.stringify(result.errors));
  assert.equal(result.successCount, 3);

  const rows = await allDb(db, 'SELECT id, name, notes, proxy_type, proxy_id, jump_chain FROM connections');
  const rowByName = Object.fromEntries(rows.map(r => [r.name, r]));
  assert.notEqual(rowByName.bastion.id, bastionId, 'test precondition: IDs changed');
  assert.deepEqual(JSON.parse(rowByName.inner.jump_chain), [rowByName.bastion.id]);
  assert.equal(rowByName.inner.proxy_type, 'jump');
  assert.equal(rowByName.inner.notes, 'behind bastion');
  assert.equal(rowByName.proxied.proxy_type, 'proxy');
  assert.ok(rowByName.proxied.proxy_id);
});

test('import falls back to original IDs, and reports unresolved jump hosts without failing the connection', async () => {
  await clearConnections();
  const file = {
    version: 2,
    tags: [],
    connections: [
      { id: 7, name: 'hop', type: 'SSH', host: 'hop', port: 22, username: 'u', auth_method: 'password', password: 'x' },
      // Name missing (e.g. renamed) but original ID present in the same file.
      { id: 8, name: 'target', type: 'SSH', host: 't', port: 22, username: 'u', auth_method: 'password', password: 'x', proxy_type: 'jump', jump_chain: [7], jump_chain_names: [''] },
      { id: 9, name: 'orphan', type: 'SSH', host: 'o', port: 22, username: 'u', auth_method: 'password', password: 'x', proxy_type: 'jump', jump_chain: [999], jump_chain_names: ['missing-host'] },
    ],
  };
  const result = await ImportExport.importConnections(Buffer.from(JSON.stringify(file)));
  assert.equal(result.successCount, 3);
  assert.equal(result.failureCount, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].connectionName, 'orphan');
  assert.match(result.errors[0].message, /missing-host/);

  const db = await getDbInstance();
  const hop = await getDb(db, "SELECT id FROM connections WHERE name = 'hop'");
  const target = await getDb(db, "SELECT jump_chain, proxy_type FROM connections WHERE name = 'target'");
  const orphan = await getDb(db, "SELECT jump_chain, proxy_type FROM connections WHERE name = 'orphan'");
  assert.deepEqual(JSON.parse(target.jump_chain), [hop.id]);
  assert.equal(orphan.jump_chain, null);
  assert.equal(orphan.proxy_type, null, 'unresolvable jump chain falls back to direct');
});

test('legacy (v1 / array) export files still import', async () => {
  await clearConnections();
  const legacy = [
    { name: 'old', type: 'SSH', host: 'old', port: 22, username: 'u', auth_method: 'password', password: 'p', notes: 'n' },
    { name: 'rdp', type: 'RDP', host: 'r', port: 3389, username: 'u', auth_method: 'password', password: 'p' },
  ];
  const result = await ImportExport.importConnections(Buffer.from(JSON.stringify(legacy)));
  assert.equal(result.successCount, 2);
  assert.equal(result.failureCount, 0);
  assert.deepEqual(result.errors, []);
  const db = await getDbInstance();
  const old = await getDb(db, "SELECT notes, jump_chain, proxy_type FROM connections WHERE name = 'old'");
  assert.equal(old.notes, 'n');
  assert.equal(old.jump_chain, null);
  assert.equal(old.proxy_type, null);
});
