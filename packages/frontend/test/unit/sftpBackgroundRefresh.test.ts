import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ref, computed } from 'vue';
import { createPinia, setActivePinia } from 'pinia';

import { createSftpActionsManager } from '../../src/composables/useSftpActions';
import { useUiNotificationsStore } from '../../src/stores/uiNotifications.store';

// The 30 s auto refresh used to flip isLoading, which swaps the whole file list for the
// "加载中…" row and back: the list flashed every 30 s. A background refresh must stay silent.

const file = (filename: string, size = 1) => ({
  filename,
  longname: filename,
  attrs: { size, uid: 0, gid: 0, mode: 0o100644, atime: 1, mtime: 1, isDirectory: false, isFile: true, isSymbolicLink: false },
});

const managers: Array<{ cleanup: () => void }> = [];
afterEach(() => { managers.splice(0).forEach(m => m.cleanup()); }); // clears pending load timeouts

const setup = () => {
  (globalThis as any).window ??= globalThis; // the notification store uses window.setTimeout
  setActivePinia(createPinia());
  const sent: any[] = [];
  const handlers = new Map<string, (payload: any, message: any) => void>();
  const deps = {
    sendMessage: (message: any) => { sent.push(message); },
    onMessage: (type: string, handler: any) => { handlers.set(type, handler); return () => handlers.delete(type); },
    isConnected: computed(() => true),
    isSftpReady: ref(true),
  };
  const currentPath = ref('/');
  const manager = createSftpActionsManager('s1', currentPath, deps as any, (key: string) => key);
  managers.push(manager);
  const reply = (index: number, items: any[]) => handlers.get('sftp:readdir:success')!(items, { requestId: sent[index].requestId, path: sent[index].payload.path });
  const fail = (index: number, error: string) => handlers.get('sftp:readdir:error')!(error, { requestId: sent[index].requestId, path: sent[index].payload.path });
  const errorToasts = () => useUiNotificationsStore().notifications.filter((n: any) => n.type === 'error').length;
  return { manager, sent, reply, fail, errorToasts, currentPath };
};

const readdirs = (sent: any[]) => sent.filter(m => m.type === 'sftp:readdir');

test('a background refresh is in flight (isLoading) but never shows the loading state', async () => {
  const { manager, sent, reply } = setup();
  const first = manager.loadDirectory('/home');
  assert.equal(manager.isLoadingVisible.value, true, 'a normal load still shows "加载中…"');
  reply(0, [file('a.txt'), file('b.txt')]);
  assert.equal(await first, true);

  const refresh = manager.loadDirectory('/home', true, { background: true });
  assert.equal(readdirs(sent).length, 2);
  assert.equal(manager.isLoading.value, true, 'guards still see the request as in flight');
  assert.equal(manager.isLoadingVisible.value, false, 'the list stays on screen');
  assert.deepEqual(manager.fileList.value.map(f => f.filename), ['a.txt', 'b.txt']);
  reply(1, [file('a.txt'), file('b.txt'), file('c.txt')]);
  assert.equal(await refresh, true);
  assert.equal(manager.isLoading.value, false);
  assert.deepEqual(manager.fileList.value.map(f => f.filename), ['a.txt', 'b.txt', 'c.txt']);
});

test('a background refresh is skipped while another request is in flight (no double request)', async () => {
  const { manager, sent } = setup();
  void manager.loadDirectory('/home');
  assert.equal(await manager.loadDirectory('/home', true, { background: true }), false);
  assert.equal(readdirs(sent).length, 1);
  assert.equal(manager.isLoadingVisible.value, true);
});

test('a failed background refresh keeps the list, does not retry and shows no toast', async () => {
  const { manager, sent, reply, fail, errorToasts } = setup();
  const first = manager.loadDirectory('/home');
  reply(0, [file('a.txt')]);
  await first;
  for (const error of ['Permission denied', 'ETIMEDOUT timeout']) {
    const refresh = manager.loadDirectory('/home', true, { background: true });
    fail(readdirs(sent).length - 1, error);
    assert.equal(await refresh, false);
    assert.equal(manager.isLoading.value, false);
  }
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(readdirs(sent).length, 3, 'no retry after a failed background refresh');
  assert.equal(errorToasts(), 0);
  assert.deepEqual(manager.fileList.value.map(f => f.filename), ['a.txt']);
});

test('a manual refresh / navigation during a background refresh is queued and shows loading', async () => {
  const { manager, sent, reply, currentPath } = setup();
  const first = manager.loadDirectory('/home');
  reply(0, [file('a.txt')]);
  await first;
  void manager.loadDirectory('/home', true, { background: true });
  assert.equal(manager.isLoadingVisible.value, false);
  const navigation = manager.loadDirectory('/etc');
  assert.equal(manager.isLoadingVisible.value, true, 'user action shows loading while it waits');
  reply(1, [file('a.txt')]);
  assert.equal(readdirs(sent).length, 3, 'queued navigation runs after the refresh');
  assert.equal(readdirs(sent)[2].payload.path, '/etc');
  assert.equal(manager.isLoadingVisible.value, true);
  reply(2, [file('hosts')]);
  assert.equal(await navigation, true);
  assert.equal(currentPath.value, '/etc');
});

test('normal load failures still toast as before', async () => {
  const { manager, fail, errorToasts } = setup();
  const load = manager.loadDirectory('/root');
  fail(0, 'Permission denied');
  assert.equal(await load, false);
  assert.equal(errorToasts(), 1);
});
