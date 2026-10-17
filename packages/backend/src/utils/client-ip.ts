import { IncomingMessage } from 'http';
import proxyaddr from 'proxy-addr';
import { normalizeIp } from '../auth/ip-match';

/**
 * 解析 TRUST_PROXY 为可信代理跳数，Express 的 `trust proxy` 与 WebSocket 升级共用同一规则：
 * - TRUST_PROXY=true：信任 1 跳代理 (即直接连接的 nginx)，取 X-Forwarded-For 最右侧 (由该代理写入) 的地址
 * - TRUST_PROXY=<正整数 N>：信任 N 跳代理 (nginx 前面还有其他反向代理时使用)
 * - 其他/未设置：不信任任何转发头，直接使用 socket.remoteAddress
 * 这样客户端无法通过伪造 X-Forwarded-For / X-Real-IP 冒充其他 IP。
 */
export const getTrustProxyHops = (): number => {
    const raw = (process.env.TRUST_PROXY || '').trim().toLowerCase();
    if (raw === 'true') return 1;
    if (/^\d+$/.test(raw)) return Math.min(parseInt(raw, 10), 10);
    return 0;
};

export const isTrustProxyEnabled = (): boolean => getTrustProxyHops() > 0;

export function getClientIp(req: IncomingMessage): string | undefined {
    const remote = req.socket?.remoteAddress;
    if (!remote) return undefined;
    try {
        const hops = getTrustProxyHops();
        const ip = proxyaddr(req, (_addr: string, index: number) => index < hops);
        return normalizeIp(ip);
    } catch {
        return normalizeIp(remote);
    }
}
