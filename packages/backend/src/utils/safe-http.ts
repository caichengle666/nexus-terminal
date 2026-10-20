import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import dns from 'dns';
import http from 'http';
import https from 'https';
import net from 'net';
import ipaddr from 'ipaddr.js';

/**
 * 出站请求 (SSRF) 防护
 *
 * AI 接口地址、Webhook、Telegram 自定义域名、WebDAV 地址都由用户填写。这里统一拒绝访问
 * 云厂商元数据 / 链路本地地址，防止被用来读取实例凭据：
 *   - 169.254.0.0/16 (IPv4 链路本地，含 169.254.169.254 元数据)
 *   - fe80::/10      (IPv6 链路本地)
 *   - fd00:ec2::254  (AWS IPv6 元数据)
 *   - 100.100.100.200 (阿里云元数据)
 * 以及上述地址的 IPv4 映射 IPv6 形式。回环地址和内网地址 (RFC1918 / ULA) 允许访问，
 * 这样本机或局域网的 Ollama 等服务仍可使用。
 *
 * 域名会在建立连接时解析，并校验每一个解析结果 (通过自定义 lookup，连接使用的就是校验过的地址，
 * 不存在先查后连的 DNS rebinding 窗口)；IP 字面量 (不经过 lookup) 在请求前和每次重定向前校验。
 */

const BLOCKED_V4_CIDRS: Array<[ipaddr.IPv4, number]> = [
    [ipaddr.IPv4.parse('169.254.0.0'), 16],
];
const BLOCKED_V4_EXACT = new Set(['100.100.100.200']);
const BLOCKED_V6_CIDRS: Array<[ipaddr.IPv6, number]> = [
    [ipaddr.IPv6.parse('fe80::'), 10],
];
const BLOCKED_V6_EXACT = new Set([ipaddr.IPv6.parse('fd00:ec2::254').toNormalizedString()]);

export class BlockedOutboundRequestError extends Error {
    code = 'EBLOCKEDDESTINATION';
    constructor(public readonly host: string, public readonly address?: string) {
        super(`出于安全原因，禁止访问该地址 (${host}${address && address !== host ? ` → ${address}` : ''})：链路本地 / 云元数据地址不允许访问。`);
        this.name = 'BlockedOutboundRequestError';
    }
}

/** 判断一个 IP 地址是否属于禁止访问的范围。无法解析的字符串返回 false (由调用方按域名处理)。 */
export function isBlockedIp(address: string): boolean {
    let raw = address.trim();
    if (raw.startsWith('[') && raw.endsWith(']')) raw = raw.slice(1, -1);
    const zoneIndex = raw.indexOf('%');
    if (zoneIndex !== -1) raw = raw.slice(0, zoneIndex);
    if (!ipaddr.isValid(raw)) return false;
    let parsed = ipaddr.parse(raw);
    if (parsed.kind() === 'ipv6') {
        const v6 = parsed as ipaddr.IPv6;
        if (v6.isIPv4MappedAddress()) {
            parsed = v6.toIPv4Address();
        } else {
            if (BLOCKED_V6_EXACT.has(v6.toNormalizedString())) return true;
            return BLOCKED_V6_CIDRS.some(([range, bits]) => v6.match(range, bits));
        }
    }
    const v4 = parsed as ipaddr.IPv4;
    if (BLOCKED_V4_EXACT.has(v4.toString())) return true;
    return BLOCKED_V4_CIDRS.some(([range, bits]) => v4.match(range, bits));
}

const stripBrackets = (host: string): string => (host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host);

/** URL 的主机名若为被禁止的 IP 字面量则抛错 */
export function assertUrlHostAllowed(rawUrl: string | URL): void {
    let url: URL;
    try {
        url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
    } catch {
        return; // 交给 axios 报告无效 URL
    }
    const host = stripBrackets(url.hostname);
    if (net.isIP(host) && isBlockedIp(host)) throw new BlockedOutboundRequestError(host, host);
}

/** 解析域名并校验所有结果；任一结果被禁止即拒绝 */
export async function assertHostResolvesSafely(hostname: string): Promise<void> {
    const host = stripBrackets(hostname);
    if (net.isIP(host)) {
        if (isBlockedIp(host)) throw new BlockedOutboundRequestError(host, host);
        return;
    }
    const addresses = await dns.promises.lookup(host, { all: true, verbatim: true });
    const blocked = addresses.find(entry => isBlockedIp(entry.address));
    if (blocked) throw new BlockedOutboundRequestError(host, blocked.address);
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: any, family?: number) => void;

/** 供 http(s).Agent / net.connect 使用的 lookup：校验每个解析结果 */
export function guardedLookup(hostname: string, options: any, callback?: LookupCallback): void {
    const cb: LookupCallback = typeof options === 'function' ? options : callback!;
    const opts: dns.LookupOptions = typeof options === 'object' && options !== null ? options : {};
    dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
        if (err) return cb(err, undefined);
        const list = addresses as dns.LookupAddress[];
        const blocked = list.find(entry => isBlockedIp(entry.address));
        if (blocked) return cb(new BlockedOutboundRequestError(hostname, blocked.address), undefined);
        if (list.length === 0) {
            const notFound: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
            notFound.code = 'ENOTFOUND';
            return cb(notFound, undefined);
        }
        if ((opts as any).all) return cb(null, list);
        return cb(null, list[0].address, list[0].family);
    });
}

export const safeHttpAgent = new http.Agent({ keepAlive: true, lookup: guardedLookup as any });
export const safeHttpsAgent = new https.Agent({ keepAlive: true, lookup: guardedLookup as any });

export const SAFE_HTTP_MAX_CONTENT_LENGTH = 10 * 1024 * 1024;

const resolveRequestUrl = (config: AxiosRequestConfig): string | undefined => {
    if (!config.url) return config.baseURL;
    try {
        return new URL(config.url, config.baseURL).toString();
    } catch {
        return config.url;
    }
};

const installGuards = (instance: AxiosInstance): AxiosInstance => {
    instance.interceptors.request.use(config => {
        const url = resolveRequestUrl(config);
        if (url) assertUrlHostAllowed(url);
        // 自定义 agent 只在未显式提供代理 agent 时生效
        config.httpAgent ??= safeHttpAgent;
        config.httpsAgent ??= safeHttpsAgent;
        const userBeforeRedirect = (config as any).beforeRedirect;
        (config as any).beforeRedirect = (options: any, responseDetails: any) => {
            const host = stripBrackets(String(options?.hostname ?? options?.host ?? ''));
            if (net.isIP(host) && isBlockedIp(host)) throw new BlockedOutboundRequestError(host, host);
            if (typeof userBeforeRedirect === 'function') userBeforeRedirect(options, responseDetails);
        };
        return config;
    });
    return instance;
};

/** 通用出站 HTTP 客户端：SSRF 防护 + 10MB 响应上限 + 最多 5 次重定向 */
export const safeAxios: AxiosInstance = installGuards(axios.create({
    maxContentLength: SAFE_HTTP_MAX_CONTENT_LENGTH,
    maxBodyLength: SAFE_HTTP_MAX_CONTENT_LENGTH,
    maxRedirects: 5,
}));

/** Webhook 专用：不跟随重定向 */
export const safeWebhookAxios: AxiosInstance = installGuards(axios.create({
    maxContentLength: SAFE_HTTP_MAX_CONTENT_LENGTH,
    maxBodyLength: SAFE_HTTP_MAX_CONTENT_LENGTH,
    maxRedirects: 0,
}));

/** 只保留 URL 的 origin，用于日志 (Slack/Discord/飞书等 webhook 的令牌在路径里) */
export function urlOriginForLog(rawUrl: unknown): string {
    if (typeof rawUrl !== 'string' || !rawUrl) return '(empty)';
    try {
        return new URL(rawUrl).origin;
    } catch {
        return '(invalid url)';
    }
}

/** 上游响应体只在服务端日志中保留截断后的内容，不再返回给客户端 */
export function summarizeUpstreamBodyForLog(data: unknown, maxLength = 300): string {
    if (data === undefined || data === null) return '';
    let text: string;
    if (typeof data === 'string') text = data;
    else if (Buffer.isBuffer(data)) text = data.toString('utf8', 0, Math.min(data.length, maxLength * 4));
    else {
        try { text = JSON.stringify(data); } catch { text = String(data); }
    }
    return text.length > maxLength ? `${text.slice(0, maxLength)}…(${text.length} chars)` : text;
}

export type { AxiosResponse };
