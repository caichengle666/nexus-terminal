/**
 * 纯 IP 匹配逻辑 (不依赖数据库)，供 IP 白名单中间件、WebSocket 升级和测试共用。
 */
import ipaddr from 'ipaddr.js';

// 本地回环地址始终允许访问 (已规范化，::ffff:127.0.0.1 会先被转换为 127.0.0.1)
const LOCAL_IPS = [
    '127.0.0.1',    // IPv4 本地回环
    '::1',          // IPv6 本地回环
    'localhost'     // 本地主机名
];

type ParsedIp = ipaddr.IPv4 | ipaddr.IPv6;

/**
 * 解析 IP 字符串并规范化：IPv4-mapped IPv6 (::ffff:1.2.3.4) 转为 IPv4。
 * 同时去掉 IPv6 zone id (fe80::1%eth0)。解析失败返回 null。
 */
export function parseNormalizedIp(ip: string): ParsedIp | null {
    if (typeof ip !== 'string') return null;
    let value = ip.trim();
    if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
    const zoneIndex = value.indexOf('%');
    if (zoneIndex !== -1) value = value.slice(0, zoneIndex);
    if (!value || !ipaddr.isValid(value)) return null;
    try {
        return ipaddr.process(value);
    } catch {
        return null;
    }
}

/** 返回规范化后的 IP 字符串；无法解析时原样返回 (去空格)。 */
export function normalizeIp(ip: string): string {
    const parsed = parseNormalizedIp(ip);
    return parsed ? parsed.toString() : (ip || '').trim();
}

export function isLocalIp(ip: string): boolean {
    return LOCAL_IPS.includes(normalizeIp(ip));
}

/** 将白名单字符串 (换行或逗号分隔) 拆分为条目 */
export function parseWhitelistEntries(whitelistString: string | null | undefined): string[] {
    if (!whitelistString) return [];
    return whitelistString
        .split(/[\n,]+/)
        .map(entry => entry.trim())
        .filter(entry => entry.length > 0);
}

function matchesEntry(requestIp: ParsedIp, entry: string): boolean {
    if (entry.includes('/')) {
        const slash = entry.lastIndexOf('/');
        const addrPart = entry.slice(0, slash);
        const prefixPart = entry.slice(slash + 1);
        const rangeAddr = parseNormalizedIp(addrPart);
        if (!rangeAddr || !/^\d{1,3}$/.test(prefixPart)) {
            console.warn(`无效的 IP 白名单条目: "${entry}"`);
            return false;
        }
        let prefix = parseInt(prefixPart, 10);
        // ::ffff:a.b.c.d/N (N>=96) 规范化为 IPv4 CIDR a.b.c.d/(N-96)
        let normalizedRange: ParsedIp = rangeAddr;
        try {
            const raw = ipaddr.parse(addrPart.replace(/%.*$/, ''));
            if (raw.kind() === 'ipv6' && rangeAddr.kind() === 'ipv4') {
                if (prefix < 96) {
                    // 前缀覆盖了 ::ffff: 之外的部分，按 IPv6 匹配 (IPv4 请求 IP 转回 mapped 形式比较)
                    normalizedRange = raw;
                } else {
                    prefix -= 96;
                }
            }
        } catch {
            /* 已由 parseNormalizedIp 校验 */
        }
        const maxPrefix = normalizedRange.kind() === 'ipv4' ? 32 : 128;
        if (prefix > maxPrefix) {
            console.warn(`无效的 IP 白名单条目: "${entry}"`);
            return false;
        }
        if (requestIp.kind() === normalizedRange.kind()) {
            return (requestIp as any).match(normalizedRange, prefix);
        }
        if (requestIp.kind() === 'ipv4' && normalizedRange.kind() === 'ipv6') {
            return (requestIp as ipaddr.IPv4).toIPv4MappedAddress().match(normalizedRange as ipaddr.IPv6, prefix);
        }
        return false;
    }

    const allowedIp = parseNormalizedIp(entry);
    if (!allowedIp) {
        console.warn(`无效的 IP 白名单条目: "${entry}"`);
        return false;
    }
    return requestIp.kind() === allowedIp.kind() && requestIp.toNormalizedString() === allowedIp.toNormalizedString();
}

/**
 * 纯函数：判断 IP 是否被白名单允许 (不访问数据库，便于测试)。
 * - 本地回环地址始终允许
 * - 白名单为空 (或解析后为空) 时允许所有 IP
 * - 支持 IPv4 / IPv6 单个地址与 CIDR；IPv4-mapped IPv6 会被规范化为 IPv4
 */
export function matchesWhitelist(ip: string | null | undefined, whitelistString: string | null | undefined): boolean {
    if (ip && isLocalIp(ip)) return true;

    const entries = parseWhitelistEntries(whitelistString);
    if (entries.length === 0) return true;

    if (!ip) return false;
    const requestIp = parseNormalizedIp(ip);
    if (!requestIp) return false;

    return entries.some(entry => matchesEntry(requestIp, entry));
}
