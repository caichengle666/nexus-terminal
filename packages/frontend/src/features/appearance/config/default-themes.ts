import type { ITheme } from '@xterm/xterm';

// 默认 xterm 主题
// (与 backend/src/config/default-themes.ts 中的定义保持一致)
export const defaultXtermTheme: ITheme = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  selectionBackground: '#264f78', // 使用 selectionBackground
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#e5e5e5'
};

// 默认 UI 主题 (CSS 变量)
// (与 backend/src/config/default-themes.ts 中的定义保持一致)
export const defaultUiTheme: Record<string, string> = {
  '--app-bg-color': '#ffffff',
  '--text-color': '#333333',
  '--text-color-secondary': '#666666',
  '--border-color': '#cccccc',
  '--link-color': '#8E44AD', // 现代紫色 (Amethyst 变种)
  '--link-hover-color': '#B180E0', // 现代紫色 - 悬停 (更亮)
  '--link-active-color': '#A06CD5', // 现代紫色 - 激活 (基础)
  '--link-active-bg-color': '#F3EBFB', /* 现代紫色 - 激活背景 (非常浅) */
  '--nav-item-active-bg-color': 'var(--link-active-bg-color)', /* Added */
  '--header-bg-color': '#f0f0f0',
  '--footer-bg-color': '#f0f0f0',
  '--button-bg-color': '#A06CD5', // 现代紫色 - 激活 (基础)
  '--button-text-color': '#ffffff',
  '--button-hover-bg-color': '#8E44AD', // 现代紫色 - 悬停 (稍暗)
  '--icon-color': 'var(--text-color-secondary)', // 图标颜色
  '--icon-hover-color': 'var(--link-hover-color)', // 图标悬停颜色 (自动更新)
  '--split-line-color': 'var(--border-color)', /* 分割线颜色 */
  '--split-line-hover-color': 'var(--border-color)', /* 分割线悬停颜色 */
  '--input-focus-border-color': 'var(--link-active-color)', /* 输入框聚焦边框颜色 (自动更新) */
  '--input-focus-glow': 'var(--link-active-color)', /* 输入框聚焦光晕值 (自动更新) */
  '--overlay-bg-color': 'rgba(0, 0, 0, 0.6)', /* Added Overlay Background - 恢复 rgba 以支持透明度 */
  '--color-success': '#28a745',
  '--color-warning': '#ffc107',
  '--color-error': '#dc3545',
  '--color-success-text': '#ffffff',
  '--color-warning-text': '#212529',
  '--color-error-text': '#ffffff',
  '--font-family-sans-serif': 'sans-serif',
  '--base-padding': '1rem',
  '--base-margin': '0.5rem',
};

export type UiThemePreset = {
  key: string;
  name: string;
  description: string;
  mode: 'light' | 'dark';
  theme: Record<string, string>;
};

const createUiTheme = (overrides: Record<string, string>): Record<string, string> => ({
  ...defaultUiTheme,
  ...overrides,
});

export const uiThemePresets: UiThemePreset[] = [
  {
    key: 'default',
    name: '默认白',
    description: '清爽、通用、适合多数用户',
    mode: 'light',
    theme: defaultUiTheme,
  },
  {
    key: 'clean-light',
    name: '冷静白',
    description: '更现代的浅色工作台',
    mode: 'light',
    theme: createUiTheme({
      '--app-bg-color': '#f8fafc',
      '--text-color': '#172033',
      '--text-color-secondary': '#65738a',
      '--border-color': '#d6deea',
      '--link-color': '#1166d8',
      '--link-hover-color': '#0b55b6',
      '--link-active-color': '#1769e0',
      '--link-active-bg-color': '#e8f0ff',
      '--header-bg-color': '#ffffff',
      '--footer-bg-color': '#ffffff',
      '--button-bg-color': '#1769e0',
      '--button-hover-bg-color': '#0b55b6',
      '--overlay-bg-color': 'rgba(15, 23, 42, 0.55)',
    }),
  },
  {
    key: 'soft-light',
    name: '暖白',
    description: '柔和不刺眼，长时间使用舒服',
    mode: 'light',
    theme: createUiTheme({
      '--app-bg-color': '#fbfaf7',
      '--text-color': '#2f3437',
      '--text-color-secondary': '#6f756f',
      '--border-color': '#ded9cc',
      '--link-color': '#28705d',
      '--link-hover-color': '#1f5c4c',
      '--link-active-color': '#2f7d68',
      '--link-active-bg-color': '#e6f3ef',
      '--header-bg-color': '#f4f1ea',
      '--footer-bg-color': '#f4f1ea',
      '--button-bg-color': '#2f7d68',
      '--button-hover-bg-color': '#1f5c4c',
      '--overlay-bg-color': 'rgba(47, 52, 55, 0.55)',
    }),
  },
  {
    key: 'pro-dark',
    name: '专业黑',
    description: '标准深色，终端工具感更强',
    mode: 'dark',
    theme: createUiTheme({
      '--app-bg-color': '#111827',
      '--text-color': '#e5e7eb',
      '--text-color-secondary': '#9ca3af',
      '--border-color': '#374151',
      '--link-color': '#60a5fa',
      '--link-hover-color': '#93c5fd',
      '--link-active-color': '#38bdf8',
      '--link-active-bg-color': 'rgba(56, 189, 248, 0.16)',
      '--header-bg-color': '#0b1120',
      '--footer-bg-color': '#0b1120',
      '--button-bg-color': '#0284c7',
      '--button-hover-bg-color': '#0369a1',
      '--overlay-bg-color': 'rgba(0, 0, 0, 0.8)',
      '--color-success': '#22c55e',
      '--color-warning': '#f59e0b',
      '--color-error': '#ef4444',
      '--color-warning-text': '#111827',
    }),
  },
  {
    key: 'midnight',
    name: '午夜蓝',
    description: '更沉稳，适合夜间运维',
    mode: 'dark',
    theme: createUiTheme({
      '--app-bg-color': '#07111f',
      '--text-color': '#dce7f5',
      '--text-color-secondary': '#88a0bb',
      '--border-color': '#1f334a',
      '--link-color': '#66e0ff',
      '--link-hover-color': '#9beeff',
      '--link-active-color': '#42d3ff',
      '--link-active-bg-color': 'rgba(66, 211, 255, 0.14)',
      '--header-bg-color': '#050b14',
      '--footer-bg-color': '#050b14',
      '--button-bg-color': '#147ea3',
      '--button-hover-bg-color': '#0d6485',
      '--overlay-bg-color': 'rgba(0, 6, 14, 0.84)',
      '--color-success': '#41d394',
      '--color-warning': '#f2b84b',
      '--color-error': '#ff6b6b',
      '--color-warning-text': '#07111f',
    }),
  },
  {
    key: 'blackout',
    name: '极简黑',
    description: '更纯粹的黑色界面',
    mode: 'dark',
    theme: createUiTheme({
      '--app-bg-color': '#050505',
      '--text-color': '#f2f2f2',
      '--text-color-secondary': '#9b9b9b',
      '--border-color': '#2a2a2a',
      '--link-color': '#7dd3fc',
      '--link-hover-color': '#bae6fd',
      '--link-active-color': '#f4f4f5',
      '--link-active-bg-color': 'rgba(244, 244, 245, 0.12)',
      '--header-bg-color': '#000000',
      '--footer-bg-color': '#000000',
      '--button-bg-color': '#f4f4f5',
      '--button-text-color': '#050505',
      '--button-hover-bg-color': '#d4d4d8',
      '--overlay-bg-color': 'rgba(0, 0, 0, 0.86)',
      '--color-success': '#4ade80',
      '--color-warning': '#facc15',
      '--color-error': '#f87171',
      '--color-warning-text': '#050505',
    }),
  },
  {
    key: 'glass-dark',
    name: '毛玻璃·深',
    description: '半透明磨砂面板，透出背景，深色更沉浸',
    mode: 'dark',
    theme: createUiTheme({
      '--ui-effect': 'glass',
      '--app-bg-color': 'rgba(15, 20, 32, 0.52)',
      '--text-color': '#e8edf6',
      '--text-color-secondary': '#a3afc2',
      '--border-color': 'rgba(255, 255, 255, 0.12)',
      '--link-color': '#7cc4ff',
      '--link-hover-color': '#a8d8ff',
      '--link-active-color': '#5cb8ff',
      '--link-active-bg-color': 'rgba(92, 184, 255, 0.16)',
      '--header-bg-color': 'rgba(12, 16, 26, 0.48)',
      '--footer-bg-color': 'rgba(12, 16, 26, 0.48)',
      '--button-bg-color': '#2f8fe0',
      '--button-hover-bg-color': '#2479c4',
      '--overlay-bg-color': 'rgba(4, 8, 16, 0.55)',
      '--color-success': '#3ddc97',
      '--color-warning': '#f5b74e',
      '--color-error': '#ff6b6b',
      '--color-warning-text': '#0b1020',
      '--glass-base-color': '#0b1220',
      '--glass-backdrop': 'radial-gradient(1200px 800px at 8% 6%, rgba(56, 116, 255, 0.40), transparent 60%), radial-gradient(900px 700px at 92% 16%, rgba(168, 85, 247, 0.30), transparent 62%), radial-gradient(1000px 800px at 70% 100%, rgba(20, 184, 166, 0.26), transparent 60%), radial-gradient(700px 520px at 16% 94%, rgba(236, 72, 153, 0.16), transparent 65%), linear-gradient(160deg, #0b1220 0%, #0d1526 45%, #0a0f1c 100%)',
      '--glass-surface': 'rgba(18, 24, 38, 0.55)',
      '--glass-surface-strong': 'rgba(20, 26, 40, 0.86)',
      '--glass-inner': 'rgba(255, 255, 255, 0.045)',
      '--glass-field': 'rgba(0, 0, 0, 0.22)',
      '--glass-border': 'rgba(255, 255, 255, 0.10)',
      '--glass-highlight': 'rgba(255, 255, 255, 0.07)',
      '--glass-shadow': '0 10px 30px rgba(0, 0, 0, 0.35)',
      '--glass-blur': '22px',
      '--glass-saturate': '160%',
      '--glass-terminal-alpha': '74%',
    }),
  },
  {
    key: 'glass-light',
    name: '毛玻璃·浅',
    description: '通透明亮的磨砂质感，终端保持深色易读',
    mode: 'light',
    theme: createUiTheme({
      '--ui-effect': 'glass',
      '--app-bg-color': 'rgba(255, 255, 255, 0.55)',
      '--text-color': '#1b2333',
      '--text-color-secondary': '#4f5b70',
      '--border-color': 'rgba(30, 41, 59, 0.14)',
      '--link-color': '#1f6fe0',
      '--link-hover-color': '#1559b8',
      '--link-active-color': '#1f6fe0',
      '--link-active-bg-color': 'rgba(31, 111, 224, 0.12)',
      '--header-bg-color': 'rgba(255, 255, 255, 0.50)',
      '--footer-bg-color': 'rgba(255, 255, 255, 0.50)',
      '--button-bg-color': '#1f6fe0',
      '--button-hover-bg-color': '#1559b8',
      '--overlay-bg-color': 'rgba(15, 23, 42, 0.28)',
      '--color-success': '#16a34a',
      '--color-warning': '#d97706',
      '--color-error': '#dc2626',
      '--color-warning-text': '#ffffff',
      '--glass-base-color': '#dfe7f3',
      '--glass-backdrop': 'radial-gradient(1100px 760px at 6% 4%, rgba(120, 170, 255, 0.55), transparent 60%), radial-gradient(900px 700px at 96% 12%, rgba(250, 170, 220, 0.48), transparent 62%), radial-gradient(1000px 800px at 72% 100%, rgba(140, 230, 210, 0.50), transparent 60%), radial-gradient(800px 600px at 15% 95%, rgba(255, 214, 150, 0.40), transparent 65%), linear-gradient(160deg, #e9eff8 0%, #e3eaf5 50%, #eef1f7 100%)',
      '--glass-surface': 'rgba(255, 255, 255, 0.58)',
      '--glass-surface-strong': 'rgba(255, 255, 255, 0.88)',
      '--glass-inner': 'rgba(255, 255, 255, 0.42)',
      '--glass-field': 'rgba(255, 255, 255, 0.62)',
      '--glass-border': 'rgba(255, 255, 255, 0.70)',
      '--glass-highlight': 'rgba(255, 255, 255, 0.75)',
      '--glass-shadow': '0 10px 30px rgba(30, 41, 59, 0.12)',
      '--glass-blur': '24px',
      '--glass-saturate': '180%',
      '--glass-terminal-alpha': '84%',
    }),
  },
];

// 软件首次打开 / 重置时使用的默认界面主题：毛玻璃·深
export const defaultAppUiTheme: Record<string, string> =
  uiThemePresets.find(preset => preset.key === 'glass-dark')!.theme;
