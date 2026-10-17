import { IncomingMessage } from 'http';

/**
 * WebSocket 升级请求的 Origin 校验 (防止跨站 WebSocket 劫持 CSWSH)。
 *
 * 允许条件 (任一满足即可)：
 * 1. 请求没有 Origin 头 (非浏览器客户端；浏览器总会发送 Origin)
 * 2. Origin 的 host[:port] 与请求的 Host 头一致 (同源)；
 *    若 Host 头不含端口 (例如 nginx 使用 `proxy_set_header Host $host;`)，则只比较主机名
 * 3. Origin 与 Host 都是回环地址 (localhost / 127.0.0.1 / ::1)，
 *    用于 Electron 桌面端与 Vite 开发代理 (changeOrigin 会改写 Host 端口)
 * 4. Origin 在环境变量 ALLOWED_WS_ORIGINS (逗号分隔，如 `https://a.example.com,https://b.example.com`) 中
 */

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const normalizeOrigin = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed === 'null') return 'null';
    try {
        const u = new URL(trimmed);
        return `${u.protocol}//${u.host}`.toLowerCase();
    } catch {
        return null;
    }
};

export const getAllowedWsOrigins = (): Set<string> => {
    const raw = process.env.ALLOWED_WS_ORIGINS || '';
    const set = new Set<string>();
    raw.split(',').forEach(entry => {
        const normalized = normalizeOrigin(entry);
        if (normalized) set.add(normalized);
    });
    return set;
};

const stripBrackets = (h: string) => (h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h);

const splitHostHeader = (host: string): { hostname: string; port: string } => {
    try {
        const u = new URL(`http://${host}`);
        return { hostname: stripBrackets(u.hostname.toLowerCase()), port: u.port };
    } catch {
        return { hostname: host.toLowerCase(), port: '' };
    }
};

const isLoopbackHostname = (hostname: string) => LOOPBACK_HOSTNAMES.has(hostname) || /^127\./.test(hostname);

export function isWsOriginAllowed(origin: string | undefined, hostHeader: string | undefined, allowlist: Set<string> = getAllowedWsOrigins()): boolean {
    if (origin === undefined || origin === '') return true;

    const normalizedOrigin = normalizeOrigin(origin);
    if (!normalizedOrigin) return false;
    if (allowlist.has(normalizedOrigin)) return true;
    if (normalizedOrigin === 'null') return false;
    if (!hostHeader) return false;

    let originUrl: URL;
    try {
        originUrl = new URL(normalizedOrigin);
    } catch {
        return false;
    }
    const originHostname = stripBrackets(originUrl.hostname.toLowerCase());
    const originPort = originUrl.port; // 默认端口时为空字符串
    const host = splitHostHeader(hostHeader.trim());

    if (originHostname === host.hostname) {
        if (!host.port) return true;              // Host 头无端口 ($host)，只比较主机名
        if (originPort === host.port) return true;
        // Host 带默认端口 (example.com:443) 而 Origin 省略默认端口
        const defaultPort = originUrl.protocol === 'https:' ? '443' : originUrl.protocol === 'http:' ? '80' : '';
        if (!originPort && host.port === defaultPort) return true;
    }

    if (isLoopbackHostname(originHostname) && isLoopbackHostname(host.hostname)) return true;

    return false;
}

export function checkWsOrigin(request: IncomingMessage): boolean {
    const originHeader = request.headers.origin;
    const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    return isWsOriginAllowed(origin, request.headers.host);
}
