/**
 * 校验登录后的重定向目标，只允许站内路径 (以 '/' 开头，且不是 '//' 协议相对地址或 '/\' 变体)。
 * @returns 安全的路径；不安全或为空时返回 null
 */
export const getSafeRedirectPath = (raw: unknown): string | null => {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.length === 0) return null;
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//') || value.startsWith('/\\')) return null;
  // 拒绝控制字符 (例如 "/\t/evil.com" 在部分浏览器中会被规范化为协议相对地址)
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  if (value === '/login' || value.startsWith('/login?') || value.startsWith('/login#')) return null;
  return value;
};
