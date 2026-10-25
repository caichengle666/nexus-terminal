import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSearchMarkers,
  buildSearchRegExp,
  collectMatchLines,
  escapeRegExp,
  findMatchRangesInLine,
  mapStringRangeToCells,
  scanSearchBuffer,
} from '../../src/utils/terminalSearch.ts';

// --- 正则构建 ---

test('escapeRegExp：搜索词含正则元字符时按字面量匹配', () => {
  const pattern = buildSearchRegExp('a.b(c)');
  assert.ok(pattern);
  assert.deepEqual(findMatchRangesInLine('a.b(c) and axbxc', pattern), [[0, 6]]);
  assert.equal(escapeRegExp('a.b'), 'a\\.b');
});

test('buildSearchRegExp：非法正则返回 null 而不是抛异常', () => {
  assert.equal(buildSearchRegExp('([a-z', { regex: true }), null);
  assert.equal(buildSearchRegExp('', { regex: true }), null);
});

test('buildSearchRegExp：区分大小写开关生效', () => {
  const insensitive = buildSearchRegExp('error');
  assert.equal(findMatchRangesInLine('ERROR error', insensitive!).length, 2);

  const sensitive = buildSearchRegExp('error', { caseSensitive: true });
  assert.equal(findMatchRangesInLine('ERROR error', sensitive!).length, 1);
});

// --- 行内匹配 ---

test('findMatchRangesInLine：一行内多次命中全部返回', () => {
  const pattern = buildSearchRegExp('ab');
  assert.deepEqual(findMatchRangesInLine('ab-ab-ab', pattern), [
    [0, 2],
    [3, 5],
    [6, 8],
  ]);
});

test('findMatchRangesInLine：整词匹配不误伤子串', () => {
  // 边界由 buildSearchRegExp 编进正则；findMatchRangesInLine 的 wholeWord 是
  // 老浏览器不支持 lookbehind 时的兜底
  const pattern = buildSearchRegExp('cat', { wholeWord: true });
  assert.deepEqual(findMatchRangesInLine('cat category cat_x cat.', pattern!, true), [
    [0, 3],
    [19, 22],
  ]);
});

test('findMatchRangesInLine：零宽正则不会死循环', () => {
  const pattern = buildSearchRegExp('^', { regex: true });
  // 零宽匹配没有可视宽度，不产生标记（否则滚动条上会出现无数条重叠横线）
  assert.deepEqual(findMatchRangesInLine('abc', pattern!), []);
});

test('findMatchRangesInLine：正则模式支持捕获与字符类', () => {
  const pattern = buildSearchRegExp('\\d{3}', { regex: true });
  assert.deepEqual(findMatchRangesInLine('port 2222 port 8080', pattern), [
    [5, 8],
    [15, 18],
  ]);
});

// --- 整段扫描 ---

test('collectMatchLines：行号按从顶部到下面的顺序返回，同一行多次命中重复计数', () => {
  const lines = ['foo bar', 'nothing', 'foo foo'];
  assert.deepEqual(collectMatchLines(lines, 'foo'), [0, 2, 2]);
});

test('collectMatchLines：空搜索词或空行集返回空数组', () => {
  assert.deepEqual(collectMatchLines(['foo'], ''), []);
  assert.deepEqual(collectMatchLines([], 'foo'), []);
});

test('collectMatchLines：整词与大小写选项一路透传', () => {
  const lines = ['Cat cat', 'CATALOG'];
  // 区分大小写时只有第二行那个小写 cat 命中（Cat 不算，CATALOG 也不整词）
  assert.deepEqual(collectMatchLines(lines, 'cat', { wholeWord: true, caseSensitive: true }), [0]);
  // 不区分大小写时 Cat/cat 都命中，CATALOG 仍因整词边界排除
  assert.deepEqual(collectMatchLines(lines, 'cat', { wholeWord: true }), [0, 0]);
});

// --- 滚动条标记 ---

test('buildSearchMarkers：相邻行合并成一段，跨度按行数折算', () => {
  const markers = buildSearchMarkers([10, 11, 12], 100);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].top, 0.1);
  assert.equal(markers[0].height, 0.03);
  assert.equal(markers[0].active, false);
});

test('buildSearchMarkers：不相邻的匹配各自成段', () => {
  const markers = buildSearchMarkers([0, 50, 99], 100);
  assert.equal(markers.length, 3);
  assert.deepEqual(
    markers.map((m) => Math.round(m.top * 100)),
    [0, 50, 99]
  );
});

test('buildSearchMarkers：activeIndex 落在正确段（而不是按下标猜行）', () => {
  // 第 0 行 2 个匹配、第 50 行 1 个匹配 => 索引 0/1 属于第一段，索引 2 属于第二段
  const lines = [0, 0, 50];
  let markers = buildSearchMarkers(lines, 100, 0);
  assert.equal(markers[0].active, true);
  assert.equal(markers[1].active, false);

  markers = buildSearchMarkers(lines, 100, 2);
  assert.equal(markers[0].active, false);
  assert.equal(markers[1].active, true);
});

test('buildSearchMarkers：段数超限时抽稀，但当前聚焦段必须保留', () => {
  const many = Array.from({ length: 1000 }, (_, i) => i * 3);
  const markers = buildSearchMarkers(many, 3000, 999, 50);
  assert.ok(markers.length <= 51);
  assert.equal(
    markers.filter((m) => m.active).length,
    1,
    '抽稀后仍要有且仅有一个 active 段'
  );
});

test('buildSearchMarkers：行号越界被裁剪，不产生负值或超 1 的 top', () => {
  const markers = buildSearchMarkers([-5, 500], 100);
  for (const m of markers) {
    assert.ok(m.top >= 0 && m.top <= 1);
    assert.ok(m.height > 0);
  }
});

test('buildSearchMarkers：totalLines 为 0 或无匹配时返回空数组', () => {
  assert.deepEqual(buildSearchMarkers([1, 2], 0), []);
  assert.deepEqual(buildSearchMarkers([], 100), []);
});


// --- 分片扫描（用假 buffer，不需要真 xterm） ---

function makeBuffer(lines: string[], baseY = 0) {
  return {
    length: lines.length,
    baseY,
    getLine: (i: number) =>
      lines[i] === undefined ? undefined : { translateToString: () => lines[i] },
  };
}

test('scanSearchBuffer：跨分片扫描时行号保持全局连续', async () => {
  const lines = Array.from({ length: 10 }, (_, i) => (i % 3 === 0 ? 'hit' : 'miss'));
  const result = await scanSearchBuffer(makeBuffer(lines, 4), 'hit', {}, () => false, 3);
  assert.deepEqual(result.matchLines, [0, 3, 6, 9]);
  assert.equal(result.totalLines, 4);
});

test('scanSearchBuffer：被取消时立刻返回空结果，不覆盖新搜索', async () => {
  const result = await scanSearchBuffer(makeBuffer(['hit', 'hit']), 'hit', {}, () => true, 3);
  assert.deepEqual(result.matchLines, []);
});

test('scanSearchBuffer：空搜索词不扫描', async () => {
  const result = await scanSearchBuffer(makeBuffer(['hit']), '', {}, () => false, 3);
  assert.deepEqual(result.matchLines, []);
  assert.equal(result.totalLines, 1);
});


// --- 字符串下标 -> 终端列（宽字符偏移的根因） ---

/**
 * 按「列规格」造一行：['中', 2] 表示一个占 2 列的字符（后面自动补 width=0 的续格）。
 */
function makeCells(spec: Array<[string, number]>) {
  const cells: Array<{ getChars(): string; getWidth(): number }> = [];
  for (const [chars, width] of spec) {
    cells.push({ getChars: () => chars, getWidth: () => width });
    for (let k = 1; k < width; k++) {
      cells.push({ getChars: () => '', getWidth: () => 0 });
    }
  }
  return {
    length: cells.length,
    translateToString: () => spec.map(([c]) => c).join(''),
    getCell: (x: number) => cells[x],
  };
}

test('mapStringRangeToCells：CJK 之前的命中要按列偏移', () => {
  // "中abc"：字符串下标 1，但「中」占 2 列 → 列是 2
  const line = makeCells([['中', 2], ['a', 1], ['b', 1], ['c', 1]]);
  assert.deepEqual(mapStringRangeToCells(line, 1, 4), { col: 2, width: 3 });
});

test('mapStringRangeToCells：命中宽字符本身时宽度为 2', () => {
  const line = makeCells([['a', 1], ['中', 2], ['b', 1]]);
  assert.deepEqual(mapStringRangeToCells(line, 1, 2), { col: 1, width: 2 });
});

test('mapStringRangeToCells：全角标点按 2 列算', () => {
  // "，。！" 三个全角标点 = 6 列，后面接 x
  const line = makeCells([['，', 2], ['。', 2], ['！', 2], ['x', 1]]);
  assert.deepEqual(mapStringRangeToCells(line, 3, 4), { col: 6, width: 1 });
});

test('mapStringRangeToCells：emoji（代理对 + 双宽）不产生额外偏移', () => {
  // emoji 在 JS 里是 2 个 code unit，xterm 里占 2 列
  const line = makeCells([['😀', 2], ['x', 1]]);
  const text = line.translateToString();
  assert.equal(text.indexOf('x'), 2, '字符串下标是 2');
  assert.deepEqual(mapStringRangeToCells(line, 2, 3), { col: 2, width: 1 });
});

test('mapStringRangeToCells：日文/韩文混排逐字符累加列宽', () => {
  // あ(2) い(2) 한(2) 글(2) 然后 "OK"(1+1) → OK 起始列 8
  const line = makeCells([['あ', 2], ['い', 2], ['한', 2], ['글', 2], ['O', 1], ['K', 1]]);
  assert.deepEqual(mapStringRangeToCells(line, 4, 6), { col: 8, width: 2 });
});

test('mapStringRangeToCells：无 getCell 的假对象退化为恒等映射', () => {
  const line = { length: 5, translateToString: () => 'abcde' };
  assert.deepEqual(mapStringRangeToCells(line, 1, 3), { col: 1, width: 2 });
});

test('scanSearchBuffer：宽字符行返回的 col 是列号而不是字符串下标', async () => {
  const line = makeCells([['中', 2], ['文', 2], ['n', 1], ['e', 1], ['e', 1], ['d', 1], ['l', 1], ['e', 1]]);
  const buffer = {
    length: 1,
    baseY: 1,
    getLine: (i: number) => (i === 0 ? line : undefined),
  };
  const result = await scanSearchBuffer(buffer, 'needle', {}, () => false, 10);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].col, 4, '「中文」占 4 列，needle 从第 4 列开始');
  assert.equal(result.matches[0].length, 6);
});


test('mapStringRangeToCells：零宽组合字符推进字符但不占列', () => {
  // 模拟天城文：'न' + 零宽 matra 'ि'（width=0 但有 chars）+ 'x'
  const cells = [
    { getChars: () => 'न', getWidth: () => 1 },
    { getChars: () => 'ि', getWidth: () => 0 },
    { getChars: () => 'x', getWidth: () => 1 },
  ];
  const line = { length: cells.length, translateToString: () => 'निx', getCell: (x: number) => cells[x] };
  // 字符串下标 2 是 'x'，列也应是 2（组合字符不加列）
  assert.deepEqual(mapStringRangeToCells(line, 2, 3), { col: 2, width: 1 });
});
