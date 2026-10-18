const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveWindowState, captureWindowState, isVisibleOnSomeDisplay } = require('../window-state');
const { createTranslator, resolveMainLocale } = require('../main-i18n');

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const second = { x: 1920, y: 0, width: 1280, height: 984 };

test('restores saved bounds that are still on a display', () => {
  const state = resolveWindowState({ x: 2000, y: 100, width: 1000, height: 700, isMaximized: true }, [primary, second], primary);
  assert.deepEqual(state, { x: 2000, y: 100, width: 1000, height: 700, isMaximized: true });
});

test('centers on the primary display when the saved display is gone', () => {
  const state = resolveWindowState({ x: 2000, y: 100, width: 1000, height: 700 }, [primary], primary);
  assert.deepEqual(state, { x: 460, y: 170, width: 1000, height: 700, isMaximized: false });
});

test('a sliver left on screen does not count as visible', () => {
  assert.equal(isVisibleOnSomeDisplay({ x: 1900, y: 100, width: 800, height: 600 }, [primary]), false);
  assert.equal(isVisibleOnSomeDisplay({ x: 1700, y: 100, width: 800, height: 600 }, [primary]), true);
});

test('missing or garbage state falls back to defaults, clamped to the primary display', () => {
  assert.deepEqual(resolveWindowState(undefined, [primary], primary), { x: 360, y: 120, width: 1200, height: 800, isMaximized: false });
  const small = { x: 0, y: 0, width: 1024, height: 700 };
  const state = resolveWindowState({ width: 'x', height: 5000 }, [small], small);
  assert.deepEqual(state, { x: 0, y: 0, width: 1024, height: 700, isMaximized: false });
});

test('captureWindowState saves the normal bounds and the maximized flag', () => {
  const win = { getNormalBounds: () => ({ x: 1, y: 2, width: 3, height: 4 }), getBounds: () => ({ x: 0, y: 0, width: 9, height: 9 }), isMaximized: () => true };
  assert.deepEqual(captureWindowState(win), { x: 1, y: 2, width: 3, height: 4, isMaximized: true });
});

test('main-process strings follow the system locale', () => {
  assert.equal(resolveMainLocale('zh-CN'), 'zh');
  assert.equal(resolveMainLocale('ja'), 'ja');
  assert.equal(resolveMainLocale('fr-FR'), 'en');
  assert.equal(createTranslator('en-US')('updateMessage', { file: 'a.exe' }), 'Update downloaded: a.exe');
  assert.equal(createTranslator(() => 'ja-JP')('trayQuit'), '終了');
  assert.equal(createTranslator('zh-TW')('trayShow'), '显示主窗口');
});
