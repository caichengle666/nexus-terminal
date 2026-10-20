import crypto from 'crypto';
import { getDbInstance, getDb } from '../database/connection';
import { isLocalIp } from './ip-match';

/**
 * 初始管理员设置令牌 (一次性)
 *
 * 当数据库中没有任何用户时，生成一个随机令牌并打印到后端日志，
 * 创建初始管理员 (POST /api/v1/auth/setup) 时必须提供该令牌，
 * 防止新部署的实例在管理员完成设置前被他人抢先接管。
 *
 * - 环境变量 SETUP_TOKEN 可指定固定令牌 (覆盖随机生成)。
 * - Electron 桌面端：主进程每次启动生成随机令牌 (NEXUS_DESKTOP_PROXY_TOKEN)，其本地代理
 *   在转发请求时注入 x-nexus-desktop-token 头；仅携带正确令牌的回环请求无需设置令牌
 *   (桌面端用户无法方便地查看后端日志)。旧的 SETUP_ALLOW_LOOPBACK_WITHOUT_TOKEN 已不再生效。
 */

let currentToken: string | null = null;
let tokenFromEnv = false;
let consumed = false;

const printToken = (reason: string) => {
    if (!currentToken) return;
    const banner = '='.repeat(72);
    const value = tokenFromEnv ? '(来自环境变量 SETUP_TOKEN / from env SETUP_TOKEN)' : currentToken;
    console.warn(
        `\n${banner}\n` +
        `[Setup] 尚未创建管理员账号 (${reason})。初始设置令牌 / Initial setup token:\n\n` +
        `    ${value}\n\n` +
        `[Setup] 在初始设置页面填写此令牌以创建管理员账号。Docker 部署可通过 \`docker compose logs backend\` 查看。\n` +
        `[Setup] Enter this token on the setup page to create the admin account (see \`docker compose logs backend\`).\n` +
        `${banner}\n`
    );
};

const ensureToken = (reason: string): string => {
    if (currentToken && !consumed) return currentToken;
    const envToken = (process.env.SETUP_TOKEN || '').trim();
    if (envToken) {
        currentToken = envToken;
        tokenFromEnv = true;
    } else {
        currentToken = crypto.randomBytes(16).toString('hex');
        tokenFromEnv = false;
    }
    consumed = false;
    printToken(reason);
    return currentToken;
};

const countUsers = async (): Promise<number> => {
    const db = await getDbInstance();
    const row = await getDb<{ count: number }>(db, 'SELECT COUNT(*) as count FROM users');
    return row ? row.count : 0;
};

/** 启动时调用：若尚无用户则生成并打印设置令牌 */
export const initializeSetupToken = async (): Promise<void> => {
    try {
        if ((await countUsers()) === 0) {
            ensureToken('startup');
        }
    } catch (error) {
        console.error('[Setup] 检查用户数量以生成设置令牌时出错:', error);
    }
};

/** needsSetup 在没有用户时调用：令牌已存在则不重复打印；若已被使用/失效则重新生成并打印 */
export const getOrCreateSetupToken = (): string => ensureToken('regenerated');

/** Electron 桌面端代理注入的请求头 (值为每次启动随机生成的令牌，经环境变量 NEXUS_DESKTOP_PROXY_TOKEN 传入) */
export const DESKTOP_PROXY_TOKEN_HEADER = 'x-nexus-desktop-token';
const MIN_DESKTOP_PROXY_TOKEN_LENGTH = 32;

const constantTimeEquals = (expectedValue: string, providedValue: string): boolean => {
    const expected = Buffer.from(expectedValue, 'utf8');
    const actual = Buffer.from(providedValue, 'utf8');
    const padded = Buffer.alloc(expected.length);
    actual.copy(padded, 0, 0, Math.min(actual.length, expected.length));
    const equal = crypto.timingSafeEqual(expected, padded);
    return equal && actual.length === expected.length;
};

interface DesktopRequestLike {
    ip?: string;
    socket?: { remoteAddress?: string | null } | null;
    headers?: Record<string, string | string[] | undefined>;
}

/**
 * 请求是否来自本机 Electron 桌面端代理：
 * 必须同时满足 (1) 后端配置了 NEXUS_DESKTOP_PROXY_TOKEN (仅 Electron 设置，每次启动随机)；
 * (2) 请求头 x-nexus-desktop-token 与之常量时间相等；(3) TCP 对端为回环地址。
 * 不再仅凭来源 IP 判断：代理会让所有转发请求看起来都来自 127.0.0.1。
 */
export const isDesktopLocalRequest = (req: DesktopRequestLike | undefined | null): boolean => {
    const expected = (process.env.NEXUS_DESKTOP_PROXY_TOKEN || '').trim();
    if (!req || expected.length < MIN_DESKTOP_PROXY_TOKEN_LENGTH) return false;
    const peerIp = req.socket?.remoteAddress || req.ip;
    if (!peerIp || !isLocalIp(peerIp)) return false;
    const raw = req.headers?.[DESKTOP_PROXY_TOKEN_HEADER];
    const provided = Array.isArray(raw) ? raw[0] : raw;
    if (typeof provided !== 'string' || provided.length === 0) return false;
    return constantTimeEquals(expected, provided.trim());
};

/** 初始管理员设置是否可免令牌：仅限经 Electron 桌面端代理 (带每次启动随机令牌) 的本机请求 */
export const isLoopbackBypassAllowed = (req: DesktopRequestLike | undefined | null): boolean => isDesktopLocalRequest(req);

/** 常量时间比较提供的令牌 */
export const verifySetupToken = (provided: unknown): boolean => {
    if (!currentToken || consumed || typeof provided !== 'string' || provided.length === 0) return false;
    // 长度不同也做一次等长比较，避免提前返回泄露时间信息
    return constantTimeEquals(currentToken, provided.trim());
};

/** 管理员创建成功后使令牌失效 */
export const invalidateSetupToken = (): void => {
    consumed = true;
    currentToken = null;
};
