const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  applyPendingRestore,
  writePendingRestoreMarker,
  readLastRestoreResult,
  readPendingRestoreMarker,
  getRestoreStagingRoot,
  moveEntry,
  RESTORE_RESERVED_DIR,
} = require('../dist/webdav-backup/pending-restore.js');
const { createFullBackup, extractFullBackup } = require('../dist/webdav-backup/backup-archive.js');

const quiet = { log() {}, warn() {}, error() {} };

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-restore-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataPath = path.join(root, 'data');
  fs.mkdirSync(path.join(dataPath, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dataPath, 'nexus-terminal.db'), 'OLD-DB');
  fs.writeFileSync(path.join(dataPath, 'nexus-terminal.db-wal'), 'OLD-WAL');
  fs.writeFileSync(path.join(dataPath, '.env'), 'ENCRYPTION_KEY=old\n');
  fs.writeFileSync(path.join(dataPath, 'sessions', 'a.json'), '{}');
  return { root, dataPath };
}

function stage(dataPath, files) {
  const staged = path.join(getRestoreStagingRoot(dataPath), 'data');
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(staged, rel)), { recursive: true });
    fs.writeFileSync(path.join(staged, rel), content);
  }
  writePendingRestoreMarker(dataPath, { createdAt: new Date().toISOString(), sourceFile: 'nexus-full-backup-x.zip.enc', safetyBackup: 'safety.zip.enc' });
}

function snapshot(dir) {
  const out = {};
  const visit = (cur, rel) => {
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      if (!rel && e.name === RESTORE_RESERVED_DIR) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) visit(path.join(cur, e.name), r);
      else out[r] = fs.readFileSync(path.join(cur, e.name), 'utf8');
    }
  };
  visit(dir, '');
  return out;
}

test('no marker: nothing happens and stale staging is cleaned', t => {
  const { dataPath } = setup(t);
  fs.mkdirSync(path.join(getRestoreStagingRoot(dataPath), 'data'), { recursive: true });
  const before = snapshot(dataPath);
  assert.equal(applyPendingRestore(dataPath, { logger: quiet }), null);
  assert.deepEqual(snapshot(dataPath), before);
  assert.equal(fs.existsSync(getRestoreStagingRoot(dataPath)), false);
});

test('applies staged data, removes stale WAL, keeps a pre-restore copy', t => {
  const { dataPath } = setup(t);
  stage(dataPath, { 'nexus-terminal.db': 'NEW-DB', '.env': 'ENCRYPTION_KEY=new\n', 'background/bg.png': 'img' });

  const result = applyPendingRestore(dataPath, { logger: quiet });
  assert.equal(result.status, 'applied');
  assert.deepEqual(snapshot(dataPath), {
    '.env': 'ENCRYPTION_KEY=new\n',
    'background/bg.png': 'img',
    'nexus-terminal.db': 'NEW-DB',
  });
  assert.equal(readPendingRestoreMarker(dataPath), null);
  assert.equal(fs.existsSync(getRestoreStagingRoot(dataPath)), false);
  const pre = path.join(dataPath, RESTORE_RESERVED_DIR, result.preRestoreDir);
  assert.equal(fs.readFileSync(path.join(pre, 'nexus-terminal.db'), 'utf8'), 'OLD-DB');
  assert.equal(fs.readFileSync(path.join(pre, 'nexus-terminal.db-wal'), 'utf8'), 'OLD-WAL');
  assert.equal(readLastRestoreResult(dataPath).status, 'applied');
  assert.equal(readLastRestoreResult(dataPath).safetyBackup, 'safety.zip.enc');
});

test('falls back to copy when rename fails across volumes (EXDEV)', t => {
  const { dataPath } = setup(t);
  stage(dataPath, { 'nexus-terminal.db': 'NEW-DB', 'nested/x.txt': 'x' });
  const ops = {
    renameSync() { throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' }); },
    cpSync: (...a) => fs.cpSync(...a),
    rmSync: (...a) => fs.rmSync(...a),
  };
  const result = applyPendingRestore(dataPath, { logger: quiet, fsOps: ops });
  assert.equal(result.status, 'applied');
  assert.deepEqual(snapshot(dataPath), { 'nested/x.txt': 'x', 'nexus-terminal.db': 'NEW-DB' });
});

test('rolls back to the old data when installing a staged entry fails', t => {
  const { dataPath } = setup(t);
  const before = snapshot(dataPath);
  stage(dataPath, { 'nexus-terminal.db': 'NEW-DB', 'zzz-locked': 'boom' });
  const ops = {
    renameSync(src, dst) {
      if (path.basename(src) === 'zzz-locked') throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
      return fs.renameSync(src, dst);
    },
    cpSync(src, dst, o) {
      if (path.basename(src) === 'zzz-locked') throw Object.assign(new Error('copy failed'), { code: 'EBUSY' });
      return fs.cpSync(src, dst, o);
    },
    rmSync: (...a) => fs.rmSync(...a),
  };
  const result = applyPendingRestore(dataPath, { logger: quiet, fsOps: ops });
  assert.equal(result.status, 'rolled-back');
  assert.deepEqual(snapshot(dataPath), before);
  assert.equal(readPendingRestoreMarker(dataPath), null, 'marker must be cleared so startup does not loop');
  const reserved = fs.readdirSync(path.join(dataPath, RESTORE_RESERVED_DIR));
  assert.deepEqual(reserved.filter(n => n.startsWith('pre-restore-')), []);
});

test('rolls back when moving an old entry aside fails (locked file on Windows)', t => {
  const { dataPath } = setup(t);
  const before = snapshot(dataPath);
  stage(dataPath, { 'nexus-terminal.db': 'NEW-DB' });
  const ops = {
    renameSync(src, dst) {
      if (path.basename(src) === 'sessions') throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      return fs.renameSync(src, dst);
    },
    cpSync: (...a) => fs.cpSync(...a),
    rmSync(target, o) {
      if (path.basename(target) === 'sessions' && target.startsWith(dataPath + path.sep + 'sessions')) {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }
      return fs.rmSync(target, o);
    },
  };
  const result = applyPendingRestore(dataPath, { logger: quiet, fsOps: ops });
  assert.equal(result.status, 'rolled-back');
  assert.deepEqual(snapshot(dataPath), before);
});

test('an apply interrupted mid-way (crash) is rolled back on the next start', t => {
  const { dataPath } = setup(t);
  const before = snapshot(dataPath);
  stage(dataPath, { 'nexus-terminal.db': 'NEW-DB', 'new-only.txt': 'n' });
  // simulate: all old entries moved aside, one new entry installed, then the process died
  const reserved = path.join(dataPath, RESTORE_RESERVED_DIR);
  const pre = path.join(reserved, 'pre-restore-crash');
  fs.mkdirSync(pre);
  for (const name of fs.readdirSync(dataPath)) {
    if (name !== RESTORE_RESERVED_DIR) fs.renameSync(path.join(dataPath, name), path.join(pre, name));
  }
  fs.renameSync(path.join(getRestoreStagingRoot(dataPath), 'data', 'new-only.txt'), path.join(dataPath, 'new-only.txt'));
  const marker = readPendingRestoreMarker(dataPath);
  fs.writeFileSync(path.join(reserved, 'pending.json'), JSON.stringify({ ...marker, phase: 'installing', preRestoreDir: 'pre-restore-crash' }));

  const result = applyPendingRestore(dataPath, { logger: quiet });
  assert.equal(result.status, 'rolled-back');
  assert.deepEqual(snapshot(dataPath), before);
});

test('keeps only the two newest pre-restore copies', t => {
  const { dataPath } = setup(t);
  for (let i = 0; i < 3; i += 1) {
    stage(dataPath, { 'nexus-terminal.db': `DB-${i}` });
    applyPendingRestore(dataPath, { logger: quiet, now: () => new Date(Date.UTC(2026, 0, 1 + i)) });
  }
  const copies = fs.readdirSync(path.join(dataPath, RESTORE_RESERVED_DIR)).filter(n => n.startsWith('pre-restore-'));
  assert.equal(copies.length, 2);
  assert.equal(fs.readFileSync(path.join(dataPath, 'nexus-terminal.db'), 'utf8'), 'DB-2');
});

test('moveEntry keeps the source intact when the copy fallback cannot delete it', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-move-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src', 'd'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'd', 'f.txt'), 'keep');
  let rmCalls = 0;
  const ops = {
    renameSync() { throw Object.assign(new Error('x'), { code: 'EXDEV' }); },
    cpSync: (...a) => fs.cpSync(...a),
    rmSync(target, o) {
      rmCalls += 1;
      if (target === path.join(root, 'src')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return fs.rmSync(target, o);
    },
  };
  assert.throws(() => moveEntry(path.join(root, 'src'), path.join(root, 'dst'), ops), /busy/);
  assert.ok(rmCalls >= 1);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'd', 'f.txt'), 'utf8'), 'keep');
  assert.equal(fs.existsSync(path.join(root, 'dst')), false);
});

test('full backups skip the reserved restore directory', async t => {
  const { root, dataPath } = setup(t);
  stage(dataPath, { 'nexus-terminal.db': 'NEW-DB' });
  const archive = await createFullBackup(dataPath, 'correct-passphrase');
  const extracted = extractFullBackup(archive.buffer, 'correct-passphrase', path.join(root, 'out'));
  assert.equal(fs.existsSync(path.join(extracted.dataPath, RESTORE_RESERVED_DIR)), false);
  assert.equal(extracted.manifest.fileCount, 4);
});
