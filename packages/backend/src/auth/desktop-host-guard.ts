import type { IncomingMessage } from 'http';

/**
 * Electron 桌面端 DNS rebinding 防护。
 *
 * 桌面端后端只监听回环地址，但网页可以通过 DNS rebinding 让浏览器把攻击者域名解析到
 * 127.0.0.1 再访问它。此时请求的 Host 头是攻击者的域名，因此在桌面模式
 * (设置了 NEXUS_DESKTOP_PROXY_TOKEN) 下只接受回环主机名。Docker / 自托管部署不受影响。
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export const isDesktopMode = (): boolean => (process.env.NEXUS_DESKTOP_PROXY_TOKEN || '').trim().length > 0;

export const isLoopbackHostHeader = (hostHeader: unknown): boolean => {
    if (typeof hostHeader !== 'string' || !hostHeader) return false;
    const value = hostHeader.trim().toLowerCase();
    let hostname = value;
    if (value.startsWith('[')) {
        const end = value.indexOf(']');
        if (end < 0) return false;
        hostname = value.slice(0, end + 1);
        const rest = value.slice(end + 1);
        if (rest && !/^:\d{1,5}$/.test(rest)) return false;
    } else {
        const parts = value.split(':');
        if (parts.length > 2) return false;
        hostname = parts[0];
        if (parts.length === 2 && !/^\d{1,5}$/.test(parts[1])) return false;
    }
    return LOOPBACK_HOSTNAMES.has(hostname);
};

/** 桌面模式下 Host 头不是回环主机名时返回 true (应拒绝) */
export const shouldRejectDesktopHost = (req: Pick<IncomingMessage, 'headers'>): boolean =>
    isDesktopMode() && !isLoopbackHostHeader(req.headers?.host);
