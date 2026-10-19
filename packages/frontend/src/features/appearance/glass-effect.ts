// 毛玻璃效果 (Glass) 的纯函数工具
//
// 毛玻璃是一个独立于 UI 主题的开关 (appearance 设置 uiGlassEnabled)：
//  - 开关打开 + 毛玻璃主题 (含 '--ui-effect': 'glass')：直接使用主题自带的 --glass-* 变量。
//  - 开关打开 + 普通实色主题：根据主题自身的颜色自动推导 --glass-* 变量，并把背景 / 顶栏变为半透明。
//  - 开关关闭 + 毛玻璃主题：去掉 --ui-effect，并把半透明的背景 / 顶栏 / 边框按 --glass-base-color
//    合成为不透明颜色，保证可读。
//  - 开关关闭 + 普通主题：原样返回。
// styles/glass.css 的规则全部挂在 html[data-ui-effect="glass"] 上，无需为“推导出的玻璃”另写样式。

export const GLASS_EFFECT_KEY = '--ui-effect';
export const GLASS_EFFECT_VALUE = 'glass';

/** 毛玻璃主题额外携带的颜色类变量 (可由 AI 生成，需通过颜色校验) */
export const GLASS_COLOR_KEYS = [
  '--glass-base-color',
  '--glass-surface',
  '--glass-surface-strong',
  '--glass-inner',
  '--glass-field',
  '--glass-border',
  '--glass-highlight',
] as const;

/** 毛玻璃主题额外携带的非颜色变量 (AI 生成时保持模板值) */
export const GLASS_NON_COLOR_KEYS = ['--glass-blur', '--glass-saturate', '--glass-terminal-alpha'] as const;

/** 需要专门安全校验的复合值变量 */
export const GLASS_BACKDROP_KEY = '--glass-backdrop';
export const GLASS_SHADOW_KEY = '--glass-shadow';

export const ALL_GLASS_KEYS: string[] = [
  ...GLASS_COLOR_KEYS,
  GLASS_BACKDROP_KEY,
  GLASS_SHADOW_KEY,
  ...GLASS_NON_COLOR_KEYS,
];

export type ThemeMode = 'light' | 'dark';

export const isGlassTheme = (theme: Record<string, string> | null | undefined): boolean =>
  !!theme && (theme[GLASS_EFFECT_KEY] || '').trim() === GLASS_EFFECT_VALUE;

// ---------- 颜色解析 ----------

export type Rgba = { r: number; g: number; b: number; a: number };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const parseChannel = (raw: string, max: number): number | null => {
  const value = raw.trim();
  if (!value) return null;
  if (value.endsWith('%')) {
    const n = Number(value.slice(0, -1));
    return Number.isFinite(n) ? clamp((n / 100) * max, 0, max) : null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n, 0, max) : null;
};

/** 解析 #rgb / #rgba / #rrggbb / #rrggbbaa / rgb() / rgba() (逗号或空格语法)。无法解析时返回 null。 */
export const parseColor = (input: string | undefined | null): Rgba | null => {
  if (!input) return null;
  const value = input.trim().toLowerCase();
  const hex = value.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }
  if (value === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  if (value === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  const fn = value.match(/^rgba?\(([^()]*)\)$/);
  if (!fn) return null;
  const parts = fn[1].includes(',')
    ? fn[1].split(',')
    : fn[1].replace(/\s*\/\s*/, ' / ').split(/\s+/).filter(p => p && p !== '/');
  if (parts.length !== 3 && parts.length !== 4) return null;
  const r = parseChannel(parts[0], 255);
  const g = parseChannel(parts[1], 255);
  const b = parseChannel(parts[2], 255);
  const a = parts.length === 4 ? parseChannel(parts[3], 1) : 1;
  if (r === null || g === null || b === null || a === null) return null;
  return { r, g, b, a };
};

const toHex = (c: Rgba): string => `#${[c.r, c.g, c.b].map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')}`;

/** 把 (可能半透明的) 前景色合成到不透明底色上，返回不透明的 #rrggbb */
export const compositeOver = (fg: Rgba, bg: Rgba): string => toHex({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1,
});

const relativeLuminance = (c: Rgba): number => {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
};

/**
 * 猜测主题是深色还是浅色：优先看毛玻璃底色，其次背景色，再看文字色 (浅色文字 => 深色主题)。
 */
export const guessThemeMode = (theme: Record<string, string>): ThemeMode => {
  const bg = parseColor(theme['--glass-base-color']) || parseColor(theme['--app-bg-color']);
  if (bg) {
    const base = isGlassTheme(theme) || bg.a >= 0.5 ? bg : null;
    if (base) return relativeLuminance(base) < 0.22 ? 'dark' : 'light';
  }
  const text = parseColor(theme['--text-color']);
  if (text) return relativeLuminance(text) > 0.5 ? 'dark' : 'light';
  return 'light';
};

// ---------- 推导 / 回退 ----------

const MODE_DEFAULTS: Record<ThemeMode, Record<string, string>> = {
  dark: {
    '--glass-base-color': '#0b1220',
    '--glass-inner': 'rgba(255, 255, 255, 0.045)',
    '--glass-field': 'rgba(0, 0, 0, 0.22)',
    '--glass-border': 'rgba(255, 255, 255, 0.10)',
    '--glass-highlight': 'rgba(255, 255, 255, 0.07)',
    '--glass-shadow': '0 10px 30px rgba(0, 0, 0, 0.35)',
    '--glass-blur': '22px',
    '--glass-saturate': '160%',
    '--glass-terminal-alpha': '74%',
  },
  light: {
    '--glass-base-color': '#dfe7f3',
    '--glass-inner': 'rgba(255, 255, 255, 0.42)',
    '--glass-field': 'rgba(255, 255, 255, 0.62)',
    '--glass-border': 'rgba(255, 255, 255, 0.70)',
    '--glass-highlight': 'rgba(255, 255, 255, 0.75)',
    '--glass-shadow': '0 10px 30px rgba(30, 41, 59, 0.12)',
    '--glass-blur': '24px',
    '--glass-saturate': '180%',
    '--glass-terminal-alpha': '84%',
  },
};

/** 取主题里某个变量的字面量；若引用了自身 (会形成循环) 或为空则返回 null */
const literal = (theme: Record<string, string>, key: string): string | null => {
  const value = (theme[key] || '').trim();
  if (!value || value.includes(`var(${key}`)) return null;
  return value;
};

const mix = (color: string, percent: number) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;

const defaultBackdrop = (mode: ThemeMode, base: string, accent: string): string => (mode === 'dark'
  ? [
    `radial-gradient(1200px 800px at 8% 6%, ${mix(accent, 34)}, transparent 60%)`,
    'radial-gradient(900px 700px at 92% 16%, rgba(168, 85, 247, 0.24), transparent 62%)',
    'radial-gradient(1000px 800px at 70% 100%, rgba(20, 184, 166, 0.22), transparent 60%)',
    'radial-gradient(700px 520px at 16% 94%, rgba(236, 72, 153, 0.12), transparent 65%)',
    `linear-gradient(160deg, ${base} 0%, color-mix(in srgb, ${base} 92%, #ffffff) 45%, ${base} 100%)`,
  ]
  : [
    `radial-gradient(1100px 760px at 6% 4%, ${mix(accent, 30)}, transparent 60%)`,
    'radial-gradient(900px 700px at 96% 12%, rgba(250, 170, 220, 0.42), transparent 62%)',
    'radial-gradient(1000px 800px at 72% 100%, rgba(140, 230, 210, 0.44), transparent 60%)',
    'radial-gradient(800px 600px at 15% 95%, rgba(255, 214, 150, 0.36), transparent 65%)',
    `linear-gradient(160deg, color-mix(in srgb, ${base} 88%, #c9d6ea) 0%, color-mix(in srgb, ${base} 82%, #c9d6ea) 50%, color-mix(in srgb, ${base} 90%, #c9d6ea) 100%)`,
  ]).join(', ');

/**
 * 为普通 (实色) 主题推导毛玻璃变量。主题里已有的 --glass-* 值优先。
 */
export const deriveGlassTheme = (theme: Record<string, string>): Record<string, string> => {
  const mode = guessThemeMode(theme);
  const defaults = MODE_DEFAULTS[mode];
  const bg = literal(theme, '--app-bg-color') || defaults['--glass-base-color'];
  const header = literal(theme, '--header-bg-color') || bg;
  const footer = literal(theme, '--footer-bg-color') || header;
  const border = literal(theme, '--border-color');
  const accent = literal(theme, '--link-active-color') || (mode === 'dark' ? '#5cb8ff' : '#1f6fe0');
  const bgRgba = parseColor(bg);
  const base = bgRgba && bgRgba.a >= 1 ? bg : defaults['--glass-base-color'];

  const derived: Record<string, string> = {
    ...defaults,
    '--glass-base-color': base,
    '--glass-backdrop': defaultBackdrop(mode, base, accent),
    '--glass-surface': mix(bg, mode === 'dark' ? 55 : 58),
    '--glass-surface-strong': mix(bg, mode === 'dark' ? 86 : 88),
    '--app-bg-color': mix(bg, mode === 'dark' ? 52 : 55),
    '--header-bg-color': mix(header, 50),
    '--footer-bg-color': mix(footer, 50),
  };
  if (border) derived['--border-color'] = mix(border, mode === 'dark' ? 70 : 80);

  const ownGlass = Object.fromEntries(ALL_GLASS_KEYS.filter(key => literal(theme, key)).map(key => [key, theme[key]]));
  return { ...theme, ...derived, ...ownGlass, [GLASS_EFFECT_KEY]: GLASS_EFFECT_VALUE };
};

/** 毛玻璃主题在关闭开关时需要变为不透明的变量 */
const SOLIDIFY_KEYS = ['--app-bg-color', '--header-bg-color', '--footer-bg-color', '--border-color'];

/**
 * 毛玻璃主题关闭毛玻璃时的实色回退：去掉 --ui-effect，半透明背景 / 顶栏 / 边框按底色合成为不透明。
 */
export const solidifyGlassTheme = (theme: Record<string, string>): Record<string, string> => {
  const mode = guessThemeMode(theme);
  const baseRgba = parseColor(theme['--glass-base-color']);
  const base = baseRgba && baseRgba.a >= 1 ? baseRgba : parseColor(MODE_DEFAULTS[mode]['--glass-base-color'])!;
  const result: Record<string, string> = { ...theme };
  delete result[GLASS_EFFECT_KEY];
  for (const key of SOLIDIFY_KEYS) {
    const color = parseColor(theme[key]);
    if (color && color.a < 1) result[key] = compositeOver(color, base);
  }
  return result;
};

/** 根据主题与开关计算最终应用到页面上的主题变量 */
export const resolveEffectiveUiTheme = (theme: Record<string, string>, glassEnabled: boolean): Record<string, string> => {
  const glassTheme = isGlassTheme(theme);
  if (glassEnabled) return glassTheme ? theme : deriveGlassTheme(theme);
  return glassTheme ? solidifyGlassTheme(theme) : theme;
};

// ---------- AI 生成结果的安全校验 ----------

const GRADIENT_ALLOWED = /^[a-z0-9\s,.%#()\-+]*$/i;
const GRADIENT_WORDS = new Set([
  'linear-gradient', 'radial-gradient', 'conic-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient',
  'rgb', 'rgba', 'hsl', 'hsla', 'at', 'from', 'to', 'in', 'srgb', 'transparent', 'circle', 'ellipse',
  'closest-side', 'closest-corner', 'farthest-side', 'farthest-corner', 'top', 'bottom', 'left', 'right', 'center',
  'deg', 'turn', 'rad', 'px', 'em', 'rem', 'vw', 'vh',
]);

/** --glass-backdrop：只允许由渐变函数、颜色、长度 / 百分比 / 角度和位置关键字组成 */
export const isSafeGlassBackdrop = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v || v.length > 1500 || !GRADIENT_ALLOWED.test(v)) return false;
  if (!/^(repeating-)?(linear|radial|conic)-gradient\(/i.test(v)) return false;
  // 括号必须配平
  let depth = 0;
  for (const ch of v) {
    if (ch === '(') depth += 1;
    else if (ch === ')') { depth -= 1; if (depth < 0) return false; }
  }
  if (depth !== 0) return false;
  // 每个字母单词必须在白名单内 (数字后的单位如 60% / 800px / 160deg 一并检查)
  const words = v.toLowerCase().match(/[a-z][a-z-]*/g) || [];
  return words.every(word => GRADIENT_WORDS.has(word) || /^[a-f]+$/.test(word));
};

/** --glass-shadow：只允许 box-shadow 的长度 + 颜色，不含函数以外的任何语法 */
export const isSafeGlassShadow = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v || v.length > 200 || !/^[a-z0-9\s,.%#()\-]*$/i.test(v)) return false;
  const words = v.toLowerCase().match(/[a-z][a-z-]*/g) || [];
  return words.every(word => ['px', 'em', 'rem', 'rgb', 'rgba', 'hsl', 'hsla', 'inset', 'transparent', 'none'].includes(word) || /^[a-f]+$/.test(word));
};

// ---------- 轻量毛玻璃 (lite)：不使用实时 backdrop-filter ----------
//
// 桌面版 (Electron) 在 GPU 合成不可用 (被关闭或驱动回退) 时，backdrop-filter 只能软件渲染，
// 每次重绘都要对大面积区域重新模糊，界面明显卡顿。lite 模式下 glass.css 去掉 backdrop-filter：
// 无页面背景图时背后只是平滑渐变，几乎看不出差别；有页面背景图时用一张预先模糊好的背景图 (canvas 生成)
// 以 fixed 方式铺在玻璃区域下面，与 body 上的清晰背景对齐，模拟毛玻璃。

export type GlassRenderMode = 'full' | 'lite';

export const GLASS_RENDER_OVERRIDE_KEY = 'nx-glass-render';

/**
 * 仅在 Electron 且 GPU 合成未启用时使用 lite (gpuCompositing 未知 / 旧版桌面端未提供该接口时按未启用处理)；
 * 普通浏览器保留真实模糊。localStorage 覆盖值 'full' / 'lite' 优先 (便于排查 / 强制切换)。
 */
export const resolveGlassRenderMode = (input: {
  isElectron: boolean;
  gpuCompositing?: boolean | null;
  override?: string | null;
}): GlassRenderMode => {
  const override = (input.override || '').trim().toLowerCase();
  if (override === 'full' || override === 'lite') return override;
  return input.isElectron && input.gpuCompositing !== true ? 'lite' : 'full';
};

export type LiteBlurPlan = {
  /** 输出画布尺寸 (与原图同宽高比) */
  width: number;
  height: number;
  /** 画布像素下的模糊半径 */
  blurPx: number;
  /** 绘制时四周外扩的像素，避免模糊后边缘发暗 / 透明 */
  pad: number;
};

/**
 * 计算预模糊背景图的画布尺寸与模糊半径。
 * 背景图在页面上以 cover 方式铺满视口，屏幕上的 cssBlurPx 换算成缩小后画布上的像素。
 */
export const computeLiteBlurPlan = (input: {
  imageWidth: number;
  imageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  cssBlurPx: number;
  maxWidth?: number;
}): LiteBlurPlan | null => {
  const { imageWidth: iw, imageHeight: ih, viewportWidth: vw, viewportHeight: vh } = input;
  if (!(iw > 0 && ih > 0 && vw > 0 && vh > 0)) return null;
  const maxWidth = input.maxWidth && input.maxWidth > 0 ? input.maxWidth : 1280;
  const width = Math.max(1, Math.round(Math.min(iw, maxWidth)));
  const height = Math.max(1, Math.round(ih * (width / iw)));
  const coverScale = Math.max(vw / iw, vh / ih);
  const screenPxPerCanvasPx = coverScale * (iw / width);
  const cssBlur = Number.isFinite(input.cssBlurPx) && input.cssBlurPx > 0 ? input.cssBlurPx : 22;
  const blurPx = Math.max(1, Math.round((cssBlur / screenPxPerCanvasPx) * 10) / 10);
  return { width, height, blurPx, pad: Math.ceil(blurPx * 2) };
};
