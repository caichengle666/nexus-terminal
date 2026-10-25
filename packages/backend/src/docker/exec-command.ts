/**
 * 「进入容器」命令的纯逻辑（不依赖 ssh2，方便单测）。
 *
 * 背景：Docker 面板原来写死 `docker exec -it <id> sh`，但
 *   - Alpine / BusyBox 只有 ash、sh
 *   - Debian / Ubuntu 通常有 bash
 *   - Windows 容器只有 powershell / cmd
 *   - distroless 根本没有 shell
 * 所以命令靠按容器探测得出，探不到（distroless）就退回 sh。
 * 刻意不做「连接级固定命令」：同一台主机上的容器本来就是不同发行版（同上游 3f092a55）。
 *
 * 安全：容器 ID 先经 isValidContainerId 严格校验（不做「剥字符」式清洗）；shell 只接受白名单；
 * 探测脚本整体交给 `sh -c` 执行，容器 ID 作为位置参数传入，不拼进脚本正文，
 * 且不依赖远端登录 shell 的语法（fish / csh 用户也能用）。
 */
import { isValidContainerId } from './docker-validate';

/** 允许回给前端、拼进 `docker exec -it` 的 shell（探测顺序见 buildShellProbeCommand） */
export const ALLOWED_CONTAINER_SHELLS = ['bash', 'ash', 'sh', 'powershell', 'pwsh', 'cmd'] as const;
export type ContainerShell = typeof ALLOWED_CONTAINER_SHELLS[number];

export const isAllowedContainerShell = (value: unknown): value is ContainerShell =>
    typeof value === 'string' && (ALLOWED_CONTAINER_SHELLS as readonly string[]).includes(value);

/** POSIX 单引号转义 */
const quote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

/**
 * 生成最终要发进用户终端的命令。
 * @param shell 探测到的 shell；为空或不在白名单内时退回 `sh`
 */
export function buildDockerExecCommand(containerId: string, shell?: string | null): string {
    if (!isValidContainerId(containerId)) throw new Error('Invalid container ID.');
    const safeShell = isAllowedContainerShell(shell) ? shell : 'sh';
    return `docker exec -it ${containerId} ${safeShell}`;
}

/**
 * 探测脚本（一次 SSH exec 跑完）。容器 ID 通过 `$1` 传入。
 * - 所有探测输出都重定向掉：试探不存在的 shell 时 docker 会往 stderr 写 "executable file not found"
 * - `cmd` 的参数是 `/c` 而不是 `-c`
 */
const PROBE_SCRIPT = [
    'CID="$1"',
    `OS=$(docker inspect -f '{{.Os}}' "$CID" 2>/dev/null)`,
    `FOUND=''`,
    'if [ "$OS" = "windows" ]; then',
    '  for s in powershell pwsh cmd; do',
    '    case "$s" in',
    '      cmd) docker exec "$CID" cmd /c exit >/dev/null 2>&1 && FOUND=$s ;;',
    `      *)   docker exec "$CID" "$s" -c 'exit 0' >/dev/null 2>&1 && FOUND=$s ;;`,
    '    esac',
    '    [ -n "$FOUND" ] && break',
    '  done',
    'else',
    '  for s in bash ash sh; do',
    `    docker exec "$CID" "$s" -c 'exit 0' >/dev/null 2>&1 && FOUND=$s`,
    '    [ -n "$FOUND" ] && break',
    '  done',
    'fi',
    'echo "NEXUS_OS=$OS"',
    'echo "NEXUS_SHELL=$FOUND"',
].join('\n');

export function buildShellProbeCommand(containerId: string): string {
    if (!isValidContainerId(containerId)) throw new Error('Invalid container ID.');
    return `sh -c ${quote(PROBE_SCRIPT)} nexus-probe ${quote(containerId)}`;
}

/** 解析探测输出；shell 不在白名单（或为空）时返回空字符串，由调用方退回 sh */
export function parseShellProbeOutput(stdout: string): { shell: string; os: string } {
    const rawShell = (/NEXUS_SHELL=([^\s]*)/.exec(stdout || '')?.[1] || '').trim();
    const os = (/NEXUS_OS=([^\s]*)/.exec(stdout || '')?.[1] || '').trim() || 'unknown';
    return { shell: isAllowedContainerShell(rawShell) ? rawShell : '', os };
}
