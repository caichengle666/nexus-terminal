/**
 * 自定义终端背景 HTML 的沙箱化工具。
 *
 * 用户 (或远程预设仓库) 提供的 HTML 可能包含 <script>。为了不让这些脚本在应用源中运行
 * (应用源可以调用 window.electronAPI / 带 Cookie 的 WebSocket 等)，背景 HTML 统一渲染在
 * <iframe sandbox="allow-scripts" srcdoc="..."> 中：
 *   - 不带 allow-same-origin → 文档处于不透明源，无法访问父页面 DOM、Cookie、localStorage；
 *   - 只带 allow-scripts → 动画 / canvas 脚本仍能运行，背景视觉效果保持不变；
 *   - 不带 allow-popups / allow-top-navigation / allow-forms / allow-modals。
 */

/** iframe 使用的 sandbox 令牌。切勿加入 allow-same-origin (与 allow-scripts 同时存在会使沙箱失效)。 */
export const TERMINAL_HTML_SANDBOX = 'allow-scripts';

/**
 * 包装文档的基础样式：铺满 iframe、无边距、透明背景，保持与旧版 (直接插入 100% 尺寸 div) 一致的布局。
 * 用户自己的 <html>/<body>/<style> 会覆盖这些默认值 (解析器会把用户的 html/body 属性合并进来)。
 */
const BASE_STYLE = 'html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent;}';

/** 把用户 HTML (片段或完整文档) 包装为 iframe srcdoc 文档。 */
export function buildSandboxedHtmlDocument(userHtml: string | null | undefined): string {
  const content = userHtml ?? '';
  return '<!DOCTYPE html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<style>${BASE_STYLE}</style></head><body>${content}</body></html>`;
}

/** HTML 是否包含会执行的脚本 (<script>、内联事件处理器或 javascript: URL)。用于在应用远程预设前提示用户。 */
export function htmlContainsScript(html: string | null | undefined): boolean {
  if (!html) return false;
  return /<script[\s>/]/i.test(html)
    || /\son[a-z]+\s*=/i.test(html)
    || /javascript\s*:/i.test(html);
}
