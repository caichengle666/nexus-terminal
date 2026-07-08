import type { ITheme } from 'xterm';

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
];
