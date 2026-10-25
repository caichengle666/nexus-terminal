/**
 * 运行平台判断。
 *
 * Electron 桌面端由 preload.js 注入 window.electronAPI；Web / Docker 部署没有。
 * 与 App.vue / WindowControls.vue 等处的判断方式保持一致。
 */
export const isDesktopApp = (): boolean => {
  if (typeof window === 'undefined') return false;
  return Boolean((window as { electronAPI?: unknown }).electronAPI);
};
