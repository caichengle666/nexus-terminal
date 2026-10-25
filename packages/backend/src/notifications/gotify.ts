import https from 'https';
import { guardedLookup, safeWebhookAxios, summarizeUpstreamBodyForLog } from '../utils/safe-http';
import { GotifyConfig } from '../types/notification.types';

/**
 * Gotify 推送（自建推送服务）。
 *
 * 协议：`POST {serverUrl}/message`，body `{ title, message, priority }`，应用 Token 放在
 * `X-Gotify-Key` 请求头里（而不是 `?token=` 查询参数），避免 Token 出现在反向代理 / 访问日志的 URL 中。
 *
 * 地址归一化：用户常把 Gotify 后台那条完整消息地址粘过来（`https://host/message?token=xxx`），
 * 或结尾多一个 `/`，或反代在子路径上（`https://host/gotify`）。统一归一化成
 * `协议//主机[:端口]/路径前缀`，发送时只在后面接 `/message`。
 *
 * 出站请求复用 safe-http 的 SSRF 防护（拒绝链路本地 / 云元数据地址），且不跟随重定向。
 */

export type GotifyUrlError = 'invalidUrl' | 'unsupportedProtocol' | 'credentialsInUrl';

export interface GotifyUrlResult {
    /** 归一化后的基地址（不含 `/message`，不含结尾斜杠）；失败时为 null。 */
    baseUrl: string | null;
    error?: GotifyUrlError;
}

export const GOTIFY_DEFAULT_PRIORITY = 5;
export const GOTIFY_REQUEST_TIMEOUT_MS = 10000;
const MAX_TITLE_LENGTH = 250;
const MAX_MESSAGE_LENGTH = 32 * 1024;

export function normalizeGotifyBaseUrl(serverUrl: unknown): GotifyUrlResult {
    const raw = typeof serverUrl === 'string' ? serverUrl.trim() : '';
    if (!raw) return { baseUrl: null, error: 'invalidUrl' };

    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        return { baseUrl: null, error: 'invalidUrl' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { baseUrl: null, error: 'unsupportedProtocol' };
    }
    // user:pass@host 会被 axios 当成 Basic 认证发出去，而且容易在日志里泄露，直接拒绝
    if (parsed.username || parsed.password) {
        return { baseUrl: null, error: 'credentialsInUrl' };
    }

    let path = parsed.pathname.replace(/\/+$/, '');
    // 用户把 `.../message` 一起粘过来（query 里的 token 不用，token 走配置）
    path = path.replace(/\/message$/i, '');
    return { baseUrl: `${parsed.protocol}//${parsed.host}${path}` };
}

export function buildGotifyMessageUrl(baseUrl: string): string {
    return `${(baseUrl || '').replace(/\/+$/, '')}/message`;
}

/** 优先级钳制到 0~10 的整数，非法值回落 5（Gotify 默认）。 */
export function normalizeGotifyPriority(value: unknown): number {
    if (value === null || value === undefined || value === '') return GOTIFY_DEFAULT_PRIORITY;
    const parsed = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(parsed)) return GOTIFY_DEFAULT_PRIORITY;
    return Math.min(10, Math.max(0, Math.round(parsed)));
}

/** Token 只保留首尾几位，日志与报错信息里不出现完整凭据。 */
export function maskGotifyToken(token: string): string {
    if (!token) return '';
    if (token.length <= 8) return '***';
    return `${token.slice(0, 2)}***${token.slice(-2)}`;
}

const insecureHttpsAgent = new https.Agent({ keepAlive: true, lookup: guardedLookup as any, rejectUnauthorized: false });

export interface GotifyMessage {
    title: string;
    message: string;
}

/**
 * 发送一条 Gotify 消息；失败时抛出带原因的 Error（不含 Token）。
 */
export async function sendGotifyMessage(config: Partial<GotifyConfig> | null | undefined, msg: GotifyMessage): Promise<{ id?: number }> {
    const serverUrl = typeof config?.serverUrl === 'string' ? config.serverUrl.trim() : '';
    const token = typeof config?.token === 'string' ? config.token.trim() : '';
    if (!serverUrl || !token) {
        throw new Error('Gotify configuration is incomplete (missing server URL or app token).');
    }
    // 防止请求头注入：Token 只允许可见 ASCII
    if (!/^[\x21-\x7e]+$/.test(token)) {
        throw new Error('Gotify app token contains invalid characters.');
    }
    const normalized = normalizeGotifyBaseUrl(serverUrl);
    if (!normalized.baseUrl) {
        const reason = normalized.error === 'unsupportedProtocol'
            ? 'Gotify server URL must start with http:// or https://'
            : normalized.error === 'credentialsInUrl'
                ? 'Gotify server URL must not contain a username or password'
                : 'Invalid Gotify server URL';
        throw new Error(reason);
    }

    const priority = normalizeGotifyPriority(config?.priority);
    const title = (String(config?.title ?? '').trim() || msg.title || 'Nexus Terminal').slice(0, MAX_TITLE_LENGTH);
    const message = String(msg.message ?? '').slice(0, MAX_MESSAGE_LENGTH) || title;
    const url = buildGotifyMessageUrl(normalized.baseUrl);

    console.log(`[Gotify] Sending notification to ${normalized.baseUrl} (token: ${maskGotifyToken(token)}, priority: ${priority})`);
    let response;
    try {
        response = await safeWebhookAxios.post(url, { title, message, priority }, {
            timeout: GOTIFY_REQUEST_TIMEOUT_MS,
            headers: { 'Content-Type': 'application/json', 'X-Gotify-Key': token },
            validateStatus: () => true,
            ...(config?.skipTlsVerify ? { httpsAgent: insecureHttpsAgent } : {}),
        });
    } catch (error: any) {
        throw new Error(`Failed to reach Gotify server: ${error?.message || error}`);
    }

    if (response.status >= 200 && response.status < 300) {
        return { id: typeof response.data?.id === 'number' ? response.data.id : undefined };
    }
    const detail = typeof response.data === 'object' && response.data
        ? (response.data.errorDescription || response.data.error || '')
        : '';
    console.error(`[Gotify] HTTP ${response.status}: ${summarizeUpstreamBodyForLog(response.data)}`);
    throw new Error(`Gotify API error (HTTP ${response.status})${detail ? `: ${String(detail).slice(0, 200)}` : ''}`);
}
