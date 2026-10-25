/**
 * 终端搜索的纯函数层：正则构建、行内匹配（含宽字符列映射）、分片扫描、滚动条标记计算。
 *
 * 移植自上游 Heavrnl/nexus-terminal（55d72bdb / 1d7fa370 / 0366a642）。
 * 高亮不再交给 @xterm/addon-search：它每次搜索词变化都要全量扫 buffer，且不暴露命中行号，
 * 滚动条标记还得再扫一遍。这里"扫一次 → 自己建 decoration"，扫描分片可取消。
 *
 * 本文件必须保持零运行时依赖（只能 import type），便于 esbuild 打包后直接跑 node:test。
 */

export interface TerminalSearchOptions {
  /** 按正则解释搜索词 */
  regex?: boolean;
  /** 整词匹配（前后不能是 [A-Za-z0-9_]） */
  wholeWord?: boolean;
  /** 区分大小写 */
  caseSensitive?: boolean;
}

export interface TerminalSearchMatch {
  /** buffer 绝对行号（0 = scrollback 第一行） */
  row: number;
  /** 起始**终端列**（cell 下标，不是字符串下标） */
  col: number;
  /** 占用**列数**（宽字符算 2 列，不是字符数） */
  length: number;
}

export interface TerminalSearchMarker {
  /** 距轨道顶部比例 0~1 */
  top: number;
  /** 高度比例 0~1（调用方需兜底最小像素高度） */
  height: number;
  /** 当前聚焦的匹配是否落在本段 */
  active: boolean;
}

const WORD_CHAR = /[A-Za-z0-9_]/;

/**
 * 默认高亮配色。
 *
 * 语义：黄色 = 全部命中，橙红 = 当前聚焦命中（与滚动条标记保持同一套颜色）。
 * 背景用半透明，避免盖住终端自身的 ANSI 前景色；边框用来在密集行里划清边界。
 * xterm 的 decoration 背景会走 `css.toColor`，支持 rgba() 与 #RRGGBBAA。
 */
export const DEFAULT_SEARCH_DECORATIONS = {
  matchBackground: 'rgba(250, 204, 21, 0.26)',
  matchOverviewRuler: '#facc15',
  activeMatchBackground: 'rgba(239, 68, 68, 0.65)',
  activeMatchBorder: 'rgba(248, 113, 113, 0.95)',
  activeMatchColorOverviewRuler: '#f87171',
};

/** 转义正则元字符（变量/搜索词里含 . ( ) [ ] 时不会抛异常） */
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 构建全局匹配用的正则。非法正则返回 null（调用方按"无结果"处理），
 * 绝不把异常抛到渲染层。
 */
export function buildSearchRegExp(
  term: string,
  options: TerminalSearchOptions = {}
): RegExp | null {
  if (!term) return null;
  const flags = options.caseSensitive ? 'g' : 'gi';
  const body = options.regex ? term : escapeRegExp(term);

  // 整词边界优先编进正则（lookaround 不消费字符，match.index 仍是词首）。
  // 老 Safari 不支持 lookbehind 时降级为裸正则 + findMatchRangesInLine 的手工边界判断。
  if (options.wholeWord) {
    try {
      return new RegExp(`(?<![\\w])(?:${body})(?![\\w])`, flags);
    } catch {
      /* 降级到下面的裸正则 */
    }
  }

  try {
    return new RegExp(body, flags);
  } catch {
    // 非法正则：交给调用方按"无结果"处理，别让异常冒到渲染层
    return null;
  }
}

/**
 * 在一行里找出所有命中区间 [start, end)。
 *
 * 用 exec + lastIndex 而不是 indexOf：正则模式下要靠 lastIndex 推进；
 * 零宽匹配（如 `^`）必须手动 +1，否则死循环。
 */
export function findMatchRangesInLine(
  line: string,
  pattern: RegExp,
  wholeWord = false
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  if (!line || !pattern) return ranges;

  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    const start = match.index;
    const end = start + match[0].length;

    if (match[0].length === 0) {
      pattern.lastIndex = start + 1;
      continue;
    }

    if (wholeWord) {
      const before = start > 0 ? line[start - 1] : '';
      const after = end < line.length ? line[end] : '';
      if ((before && WORD_CHAR.test(before)) || (after && WORD_CHAR.test(after))) {
        // 不满足整词边界：从 start+1 继续找，避免漏掉行内后面的合法命中
        pattern.lastIndex = start + 1;
        continue;
      }
    }

    ranges.push([start, end]);
  }

  pattern.lastIndex = 0;
  return ranges;
}

/**
 * 扫描整段行文本，返回"每个匹配所在的行号"（按匹配出现顺序，一行多次命中会重复出现）。
 *
 * 顺序必须与 addon 的 resultIndex 一致：addon 也是从 buffer 顶部往下逐行扫，
 * 一行内从左到右。这样滚动条标记的 active 段才能对上"3/57"里的 3。
 */
export function collectMatchLines(
  lines: string[],
  term: string,
  options: TerminalSearchOptions = {}
): number[] {
  const pattern = buildSearchRegExp(term, options);
  if (!pattern) return [];

  const result: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ranges = findMatchRangesInLine(lines[i], pattern, options.wholeWord);
    for (let r = 0; r < ranges.length; r++) {
      result.push(i);
    }
  }
  return result;
}

/** 最小 cell 接口（xterm IBufferCell 的子集） */
export interface SearchCellLike {
  getChars(): string;
  getWidth(): number;
}

/** 最小行接口：只依赖扫描与列映射需要的东西，便于单测用假对象 */
export interface SearchLineLike {
  /** 该行的**列数**（不是字符串长度） */
  readonly length: number;
  translateToString(trimRight?: boolean): string;
  getCell?(x: number): SearchCellLike | undefined;
}

/** 最小 buffer 接口：只依赖扫描需要的成员，便于单测用假对象 */
export interface SearchBufferLike {
  length: number;
  baseY: number;
  getLine(index: number): SearchLineLike | undefined;
}

/**
 * 把「字符串下标」换算成「终端列」。
 *
 * `translateToString()` 拼的是每个 cell 的 chars，一个 CJK / emoji 只产生 1 个字符，
 * 但在终端里占 2 列；它后面那个「续格」（width=0、chars=''）不产生字符。
 * 所以正则匹配到的 `match.index` 是**字符下标**，直接当 `x` 传给 registerDecoration
 * 会随着行内宽字符数量累积偏移 —— 这正是「高亮框往左偏、越到行尾偏得越多」的原因。
 *
 * 没有 getCell（单测假对象）时退化成恒等映射，保证纯函数可测。
 */
export function mapStringRangeToCells(
  line: SearchLineLike,
  start: number,
  end: number
): { col: number; width: number } {
  const fallback = { col: Math.max(0, start), width: Math.max(1, end - start) };
  if (!line || typeof line.length !== 'number' || line.length <= 0) return fallback;
  if (typeof line.getCell !== 'function') return fallback;
  if (start < 0 || end <= start) return fallback;

  let charIndex = 0;
  let startCol = -1;
  let endCol = -1;

  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    const width = cell?.getWidth?.() ?? 1;
    const chars = cell?.getChars?.() ?? '';

    if (width === 0) {
      /*
       * 两种 width=0 的 cell 必须区分开：
       * - 宽字符的第二格（CJK/emoji）：chars 为空，既不占列也不产生字符
       * - 零宽组合字符（天城文 matra、阿拉伯变音符）：chars 非空，
       *   translateToString 会把它拼进字符串，所以字符下标要推进，但列不加
       * 混为一谈会让组合文字之后的所有命中整体左偏。
       */
      if (chars.length) {
        if (startCol < 0 && start < charIndex + chars.length) startCol = x;
        charIndex += chars.length;
        if (endCol < 0 && end <= charIndex) {
          endCol = x + 1;
          break;
        }
      }
      continue;
    }

    // 正常 cell 的字符数就是 1；宽字符 1 个字符占 2 列；极少见的组合字符会有多个 code unit
    const charSpan = chars.length || 1;

    if (startCol < 0 && start < charIndex + charSpan) {
      startCol = x;
    }

    charIndex += charSpan;
    if (end <= charIndex) {
      endCol = x + width;
      break;
    }
  }

  if (startCol < 0) startCol = fallback.col;
  if (endCol < 0) endCol = startCol + fallback.width;
  return { col: startCol, width: Math.max(1, endCol - startCol) };
}

/**
 * 分片扫描整个 buffer，返回命中行号。
 *
 * 分片是为了"高性能"：10 万行 × 每行 100 字符如果一口气扫，主线程会卡住输入。
 * 每扫 chunkSize 行让出一帧，用户键入时感觉不到。isCancelled 用来在搜索词变化时
 * 立刻放弃上一轮扫描，避免旧结果覆盖新结果。
 */
export async function scanSearchBuffer(
  buffer: SearchBufferLike,
  term: string,
  options: TerminalSearchOptions = {},
  isCancelled: () => boolean = () => false,
  chunkSize = 800
): Promise<{ matches: TerminalSearchMatch[]; matchLines: number[]; totalLines: number }> {
  const totalLines = Math.max(1, buffer?.baseY ?? 1);
  if (!term || !buffer || buffer.length <= 0) {
    return { matches: [], matchLines: [], totalLines };
  }

  const pattern = buildSearchRegExp(term, options);
  if (!pattern) return { matches: [], matchLines: [], totalLines };

  const total = buffer.length;
  const matches: TerminalSearchMatch[] = [];
  const matchLines: number[] = [];

  // 字面量预筛：非正则模式下先用 includes 过滤整行，只有疑似命中的行才跑正则。
  // 3000 行里命中 10 行时，这一步能把耗时砍掉一个数量级。
  const useLiteralPrefilter = !options.regex;
  const needle = options.caseSensitive ? term : term.toLowerCase();

  for (let offset = 0; offset < total; offset += chunkSize) {
    if (isCancelled()) return { matches: [], matchLines: [], totalLines };

    const end = Math.min(total, offset + chunkSize);
    for (let i = offset; i < end; i++) {
      const lineObj = buffer.getLine(i);
      if (!lineObj) continue;
      const line = lineObj.translateToString(true) ?? '';
      if (!line) continue;

      if (useLiteralPrefilter) {
        const haystack = options.caseSensitive ? line : line.toLowerCase();
        if (haystack.indexOf(needle) === -1) continue;
      }

      const ranges = findMatchRangesInLine(line, pattern, options.wholeWord);
      for (let r = 0; r < ranges.length; r++) {
        const [start, stop] = ranges[r];
        // 只在命中行做 cell 映射（O(列数) 的 getCell 循环），不拖慢整体扫描
        const { col, width } = mapStringRangeToCells(lineObj, start, stop);
        matches.push({ row: i, col, length: width });
        // 一行多次命中要重复计数：滚动条标记的 active 段用"匹配序号"定位，
        // 少算会让"当前第几个"和标记对不上。
        matchLines.push(i);
      }
    }

    if (end < total) {
      // 每片最多 ~800 行（约 15ms）：让出主线程，用户输入不会被整段扫描顶住
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  if (isCancelled()) return { matches: [], matchLines: [], totalLines };
  return { matches, matchLines, totalLines };
}

/**
 * 把匹配行号压缩成滚动条标记。
 *
 * - 相邻/同一行合并成一段，避免 1000 个匹配生成 1000 个 DOM 节点
 * - 段数超过 maxSegments 时均匀抽稀，但**当前聚焦段一定保留**（否则跳转后看不见自己）
 */
export function buildSearchMarkers(
  matchLines: number[],
  totalLines: number,
  activeIndex: number = -1,
  maxSegments: number = 160
): TerminalSearchMarker[] {
  if (!matchLines.length || totalLines <= 0) return [];

  const total = Math.max(1, totalLines);
  const segments: Array<{ from: number; to: number; first: number; last: number }> = [];

  for (let i = 0; i < matchLines.length; i++) {
    const line = Math.max(0, Math.min(total - 1, matchLines[i]));
    const last = segments[segments.length - 1];
    if (last && line <= last.last + 1) {
      last.last = Math.max(last.last, line);
      last.to = i;
    } else {
      segments.push({ from: i, to: i, first: line, last: line });
    }
  }

  let kept = segments;
  if (segments.length > maxSegments) {
    const activeSegIndex = segments.findIndex(
      (s) => activeIndex >= s.from && activeIndex <= s.to
    );
    const step = segments.length / maxSegments;
    const picked: typeof segments = [];
    for (let k = 0; k < maxSegments; k++) {
      picked.push(segments[Math.min(segments.length - 1, Math.floor(k * step))]);
    }
    if (activeSegIndex >= 0 && !picked.includes(segments[activeSegIndex])) {
      picked.push(segments[activeSegIndex]);
    }
    kept = picked;
  }

  return kept.map((seg) => ({
    top: seg.first / total,
    height: Math.max((seg.last - seg.first + 1) / total, 1 / total),
    active: activeIndex >= seg.from && activeIndex <= seg.to,
  }));
}
