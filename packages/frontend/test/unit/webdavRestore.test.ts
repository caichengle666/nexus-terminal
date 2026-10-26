import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RESTORE_NOTICE_KEY,
  saveRestoreNotice,
  takeRestoreNotice,
  waitForBackendRestart,
} from '../../src/utils/webdavRestore';

// A fake clock: sleep advances time instantly, so the loops run without real waiting.
const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
};

test('waits until the backend answers with a new bootId', async () => {
  const c = clock();
  const answers = ['old', 'old', null, null, 'new'];
  let calls = 0;
  const ok = await waitForBackendRestart({
    getBootId: async () => answers[Math.min(calls++, answers.length - 1)],
    previousBootId: 'old',
    ...c,
  });
  assert.equal(ok, true);
  assert.equal(calls, 5);
});

test('a fast restart that is never seen down still counts (bootId changed)', async () => {
  const c = clock();
  const ok = await waitForBackendRestart({ getBootId: async () => 'new', previousBootId: 'old', ...c });
  assert.equal(ok, true);
});

test('without a previous bootId it requires the backend to go down and come back', async () => {
  const c = clock();
  const answers: Array<string | null> = ['x', null, 'y'];
  let calls = 0;
  const ok = await waitForBackendRestart({
    getBootId: async () => {
      const a = answers[Math.min(calls++, answers.length - 1)];
      if (a === null) throw new Error('ECONNREFUSED');
      return a;
    },
    previousBootId: null,
    ...c,
  });
  assert.equal(ok, true);
  assert.equal(calls, 3);
});

test('gives up after the timeout when the backend never comes back', async () => {
  const c = clock();
  const ok = await waitForBackendRestart({ getBootId: async () => null, previousBootId: 'old', timeoutMs: 60_000, intervalMs: 1000, ...c });
  assert.equal(ok, false);
  assert.ok(c.now() >= 60_000);
});

test('stops when aborted (component unmounted)', async () => {
  const c = clock();
  const signal = { aborted: false };
  let calls = 0;
  const ok = await waitForBackendRestart({
    getBootId: async () => { calls += 1; if (calls === 2) signal.aborted = true; return 'old'; },
    previousBootId: 'old',
    signal,
    ...c,
  });
  assert.equal(ok, false);
  assert.equal(calls, 2);
});

test('the restore notice survives a reload exactly once', () => {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
  saveRestoreNotice(storage, { fileName: 'nexus-full-backup-x.zip.enc', format: 'full', startedAt: '2026-01-01T00:00:00.000Z' });
  assert.ok(map.has(RESTORE_NOTICE_KEY));
  assert.equal(takeRestoreNotice(storage)?.fileName, 'nexus-full-backup-x.zip.enc');
  assert.equal(takeRestoreNotice(storage), null);
  map.set(RESTORE_NOTICE_KEY, '{not json');
  assert.equal(takeRestoreNotice(storage), null);
});
