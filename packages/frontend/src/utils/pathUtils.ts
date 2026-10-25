/**
 * POSIX 远端路径小工具（纯函数，可单测）。移植自上游 cb310dc7。
 */

/**
 * 把用户输入解析成远端绝对路径。
 *
 * 新建文件 / 文件夹的输入框允许直接写路径：
 *   `1.txt`             → `<base>/1.txt`
 *   `./asd/222/1.txt`   → `<base>/asd/222/1.txt`
 *   `../x`              → `<base 的上一级>/x`
 *   `/etc/nginx/a.conf` → 原样（绝对路径）
 *
 * 规则与 POSIX 一致：`.` 与空段丢弃，`..` 回退一级（已在根就停在根，不会跑出 `/`），
 * 连续斜杠折叠。返回值一定以 `/` 开头且不含结尾斜杠（根目录就是 `/`）。
 */
export function resolveRemotePath(basePath: string, input: string): string {
  const raw = (input || '').trim();
  const combined = raw.startsWith('/')
    ? raw
    : `${(basePath || '/').trim() || '/'}/${raw}`;
  const segments: string[] = [];
  for (const seg of combined.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      segments.pop(); // 空栈时 pop 是 no-op：`/..` 仍然是 `/`
      continue;
    }
    segments.push(seg);
  }
  return `/${segments.join('/')}`;
}

/** 取父目录（`/` 的父目录还是 `/`） */
export function parentOfRemotePath(fullPath: string): string {
  const clean = (fullPath || '/').replace(/\/+$/, '');
  if (!clean) return '/';
  const lastSlash = clean.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : clean.substring(0, lastSlash);
}

/** 新建输入是不是「带路径」的写法（包含 `/`，或就是 `.` / `..`） */
export function isPathLikeInput(input: string): boolean {
  const raw = (input || '').trim();
  return raw.includes('/') || raw === '.' || raw === '..';
}
