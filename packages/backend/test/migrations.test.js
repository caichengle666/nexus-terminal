const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3');
const { runMigrations, addColumnIfMissing, columnExists } = require('../dist/database/migrations.js');

const openMemoryDb = () => new sqlite3.Database(':memory:');
const run = (db, sql) => new Promise((resolve, reject) => db.exec(sql, err => (err ? reject(err) : resolve())));
const all = (db, sql) => new Promise((resolve, reject) => db.all(sql, (err, rows) => (err ? reject(err) : resolve(rows))));
const close = db => new Promise(resolve => db.close(() => resolve()));

test('addColumnIfMissing adds once and skips an existing column', async () => {
  const db = openMemoryDb();
  try {
    await run(db, 'CREATE TABLE t (id INTEGER PRIMARY KEY)');
    assert.equal(await addColumnIfMissing(db, { table: 't', column: 'extra', definition: 'TEXT NULL' }), true);
    assert.equal(await addColumnIfMissing(db, { table: 't', column: 'extra', definition: 'TEXT NULL' }), false);
    assert.equal(await columnExists(db, 't', 'extra'), true);
    await assert.rejects(addColumnIfMissing(db, { table: 'missing_table', column: 'x', definition: 'TEXT' }), /不存在/);
    await assert.rejects(addColumnIfMissing(db, { table: 't; DROP TABLE t', column: 'x', definition: 'TEXT' }), /非法/);
  } finally {
    await close(db);
  }
});

test('migration #13 repairs columns skipped by the old multi-statement migrations', async () => {
  const db = openMemoryDb();
  try {
    // Simulates a DB where #9 stopped after jump_chain (already present) and #11 only added selection_foreground,
    // yet both were recorded as applied.
    await run(db, `
      CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, hashed_password TEXT, two_factor_secret TEXT);
      CREATE TABLE connections (id INTEGER PRIMARY KEY, jump_chain TEXT NULL, host_key_fingerprint TEXT NULL);
      CREATE TABLE terminal_themes (id INTEGER PRIMARY KEY, selection_foreground TEXT NULL);
      CREATE TABLE migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL DEFAULT 0);
      INSERT INTO users (id, username, hashed_password) VALUES (1, 'admin', 'x');
      ${Array.from({ length: 12 }, (_, i) => `INSERT INTO migrations (id, name) VALUES (${i + 1}, 'm${i + 1}');`).join('\n')}
    `);
    await runMigrations(db);
    for (const column of ['jump_chain', 'proxy_type']) {
      assert.equal(await columnExists(db, 'connections', column), true, column);
    }
    for (const column of ['selection_foreground', 'selection_inactive_background', 'scrollbar_slider_background',
      'scrollbar_slider_hover_background', 'scrollbar_slider_active_background', 'overview_ruler_border', 'extended_ansi']) {
      assert.equal(await columnExists(db, 'terminal_themes', column), true, column);
    }
    const users = await all(db, 'SELECT session_version FROM users');
    assert.deepEqual(users, [{ session_version: 0 }]);
    const recorded = await all(db, 'SELECT MAX(id) AS v FROM migrations');
    assert.equal(recorded[0].v, 13);

    // Running again is a no-op.
    await runMigrations(db);
  } finally {
    await close(db);
  }
});

test('a failing migration is rolled back and not recorded', async () => {
  const db = openMemoryDb();
  try {
    // users table is missing, so adding users.session_version must fail instead of being swallowed.
    await run(db, `
      CREATE TABLE connections (id INTEGER PRIMARY KEY, jump_chain TEXT NULL, proxy_type TEXT NULL);
      CREATE TABLE terminal_themes (id INTEGER PRIMARY KEY);
      CREATE TABLE migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL DEFAULT 0);
      ${Array.from({ length: 12 }, (_, i) => `INSERT INTO migrations (id, name) VALUES (${i + 1}, 'm${i + 1}');`).join('\n')}
    `);
    await assert.rejects(runMigrations(db), /迁移 #13 失败/);
    const recorded = await all(db, 'SELECT MAX(id) AS v FROM migrations');
    assert.equal(recorded[0].v, 12);
    // Rolled back: the theme columns added earlier in #13 are gone again.
    assert.equal(await columnExists(db, 'terminal_themes', 'extended_ansi'), false);
  } finally {
    await close(db);
  }
});
