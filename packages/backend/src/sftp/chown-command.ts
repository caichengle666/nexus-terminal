/**
 * 修改文件所有者 / 权限的参数校验与命令生成（纯函数，可直接单测）。
 *
 * 为什么 chown 不用 `sftp.chown(path, uid, gid)`：SFTP 协议的 chown 只收数字 uid/gid，
 * 而界面里填的多是 `www-data` 这类名字；直接经 SSH 执行 `chown -- 用户:组 路径` 一次搞定。
 *
 * 安全要点（用户名 / 组名 / 路径都会进入远端 shell）：
 *  - 用户名 / 组名只允许 `[A-Za-z0-9._-]`（首字符不能是 `-` / `.`）或纯数字，其它一律拒绝；
 *  - 路径必须是绝对路径，不能含 NUL / 换行，整体单引号包裹（内部单引号按 POSIX 规则转义）；
 *  - `--` 结束选项解析。
 * chmod 仍走 SFTP 原生 chmod（不经过 shell），这里只负责校验 mode。
 */

export interface ChownTargets {
    owner?: string;
    group?: string;
}

export type ChownErrorCode = 'emptyTargets' | 'invalidOwner' | 'invalidGroup' | 'invalidPath';

export interface ChownCommandResult {
    /** 可执行的完整命令；校验失败时为 null。 */
    command: string | null;
    error?: ChownErrorCode;
    /** 归一化后的 chown 目标（`user:group` / `user` / `:group`）。 */
    spec?: string;
}

/** 用户名 / 组名：字母数字或 `_` 开头，允许 `._-`，最长 64；不允许空格、冒号、斜杠、`$` 等。 */
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
/** 纯数字 uid/gid，限制在 32 位无符号范围内。 */
const NUMERIC_RE = /^[0-9]{1,10}$/;
const MAX_ID = 4294967295;

export function isValidChownName(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const text = value.trim();
    if (!text) return false;
    if (NUMERIC_RE.test(text)) return Number(text) <= MAX_ID;
    return NAME_RE.test(text);
}

/** POSIX 单引号转义，与 sftp.service 里 rm / tar 命令使用的写法一致。 */
export function quoteShellArgument(value: string): string {
    return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

/** 远端绝对路径校验：必须以 `/` 开头，不含 NUL 与换行，长度合理。 */
export function isSafeRemotePath(value: unknown): value is string {
    return typeof value === 'string'
        && value.startsWith('/')
        && value.length <= 4096
        && !/[\0\r\n]/.test(value);
}

/**
 * 生成 chown 命令。
 * - 只填 owner → `chown -- 'user' '/path'`（组不动）
 * - 只填 group → `chown -- ':group' '/path'`
 * - 都填 → `chown -- 'user:group' '/path'`
 * - 都空 → 不执行
 */
export function buildChownCommand(path: unknown, targets: ChownTargets): ChownCommandResult {
    const owner = typeof targets?.owner === 'string' ? targets.owner.trim() : '';
    const group = typeof targets?.group === 'string' ? targets.group.trim() : '';

    if (!owner && !group) return { command: null, error: 'emptyTargets' };
    if (owner && !isValidChownName(owner)) return { command: null, error: 'invalidOwner' };
    if (group && !isValidChownName(group)) return { command: null, error: 'invalidGroup' };
    const spec = owner && group ? `${owner}:${group}` : (owner || `:${group}`);
    // 路径不 trim：文件名可以合法地以空格开头 / 结尾
    if (!isSafeRemotePath(path)) return { command: null, error: 'invalidPath', spec };

    return { command: `chown -- ${quoteShellArgument(spec)} ${quoteShellArgument(path)}`, spec };
}

/** chmod 的 mode：0 ~ 0o7777 的整数（含 setuid / setgid / sticky）。 */
export function isValidChmodMode(mode: unknown): mode is number {
    return typeof mode === 'number' && Number.isInteger(mode) && mode >= 0 && mode <= 0o7777;
}
