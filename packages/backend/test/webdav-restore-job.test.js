const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const test = require('node:test');

// The job module pulls in the database module; point it at a throwaway data directory.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-restore-job-'));
process.env.APP_BACKEND_DATA_PATH = dataDir;
process.on('exit', () => fs.rmSync(dataDir, { recursive: true, force: true }));

const { startRestoreJob, getRestoreJob, resetRestoreJobForTests } = require('../dist/webdav-backup/restore-job.js');
const { FULL_BACKUP_MAGIC } = require('../dist/webdav-backup/backup-archive.js');

const fullBuffer = Buffer.concat([FULL_BACKUP_MAGIC, Buffer.from('payload')]);

function deps(overrides = {}) {
  const calls = [];
  const d = {
    downloadBackup: async () => { calls.push('download'); return fullBuffer; },
    stageFullBackup: () => { calls.push('stage'); return { fileCount: 3 }; },
    createBackup: async () => { calls.push('snapshot'); return { fileName: 'nexus-full-backup-safety.zip.enc', size: 1, fileCount: 3 }; },
    parseLegacyBackup: () => { calls.push('parse'); return { data: {}, restoreTables: ['settings'] }; },
    applyLegacyBackup: async () => { calls.push('applyLegacy'); },
    writePendingRestoreMarker: () => { calls.push('marker'); },
    discardRestoreStaging: () => { calls.push('discard'); },
    restartProcess: () => { calls.push('restart'); },
    ...overrides,
  };
  return { d, calls };
}

test('full restore runs stages in order and ends in restarting', async t => {
  t.after(resetRestoreJobForTests);
  const { d, calls } = deps();
  const { job, done } = startRestoreJob('nexus-full-backup-2026-01-01T00-00-00.zip.enc', 'passphrase!', null, d);
  await done;
  assert.deepEqual(calls, ['download', 'stage', 'snapshot', 'marker', 'restart']);
  const status = getRestoreJob(job.id);
  assert.equal(status.stage, 'restarting');
  assert.equal(status.safetyBackup, 'nexus-full-backup-safety.zip.enc');
  assert.equal(status.format, 'full');
});

test('wrong passphrase fails at verifying before any safety snapshot is made', async t => {
  t.after(resetRestoreJobForTests);
  const { d, calls } = deps({
    stageFullBackup: () => { throw new Error('备份密码错误，或备份文件已损坏。'); },
  });
  const { job, done } = startRestoreJob('nexus-full-backup-2026-01-01T00-00-00.zip.enc', 'wrong-pass', null, d);
  await done;
  assert.ok(!calls.includes('snapshot'));
  assert.ok(!calls.includes('restart'));
  assert.ok(calls.includes('discard'));
  const status = getRestoreJob(job.id);
  assert.equal(status.stage, 'failed');
  assert.equal(status.failedStage, 'verifying');
  assert.match(status.error, /备份密码错误/);
});

test('a second restore is rejected while one is in progress, allowed after failure', async t => {
  t.after(resetRestoreJobForTests);
  let release;
  const { d } = deps({ downloadBackup: () => new Promise((_, reject) => { release = () => reject(new Error('net')); }) });
  const first = startRestoreJob('a.zip.enc', 'passphrase!', null, d);
  assert.throws(() => startRestoreJob('b.zip.enc', 'passphrase!', null, d), /已有恢复任务/);
  release();
  await first.done;
  assert.equal(getRestoreJob(first.job.id).failedStage, 'downloading');
  const second = startRestoreJob('b.zip.enc', 'passphrase!', null, deps().d);
  await second.done;
  assert.equal(getRestoreJob(second.job.id).stage, 'restarting');
});

test('legacy restore applies in the database and restarts; snapshot only with a passphrase', async t => {
  t.after(resetRestoreJobForTests);
  const { d, calls } = deps({ downloadBackup: async () => Buffer.from('PK legacy') });
  const { job, done } = startRestoreJob('nexus-backup-2026-01-01T00-00-00.zip', undefined, null, d);
  await done;
  assert.deepEqual(calls, ['parse', 'applyLegacy', 'restart']);
  assert.equal(getRestoreJob(job.id).format, 'legacy');
});
