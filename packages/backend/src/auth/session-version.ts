import { EventEmitter } from 'events';
import { getDbInstance, getDb, runDb } from '../database/connection';

/**
 * 会话版本 (users.session_version)
 *
 * 登录时把用户当前的 session_version 写入会话。修改密码、启用/禁用 2FA 时递增，
 * 之后所有携带旧版本号的会话 (以及基于它们建立的 WebSocket) 都会失效。
 * 发起修改的那个会话会被重新生成并写入新版本号，因此不会被登出。
 *
 * 历史会话 (升级前创建，没有 sessionVersion 字段) 视为版本 0，与数据库默认值一致，
 * 所以升级本身不会把任何人登出。
 */

const versionCache = new Map<number, number>();

export const normalizeSessionVersion = (value: unknown): number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;

export const isSessionVersionCurrent = (sessionVersion: unknown, currentVersion: number | null | undefined): boolean =>
    typeof currentVersion === 'number' && normalizeSessionVersion(sessionVersion) === currentVersion;

/** 读取用户当前的会话版本；用户不存在时返回 null。结果在内存缓存，递增时同步更新。 */
export async function getCurrentSessionVersion(userId: number): Promise<number | null> {
    const cached = versionCache.get(userId);
    if (cached !== undefined) return cached;
    const db = await getDbInstance();
    const row = await getDb<{ session_version: number | null }>(db, 'SELECT session_version FROM users WHERE id = ?', [userId]);
    if (!row) return null;
    const version = normalizeSessionVersion(row.session_version);
    versionCache.set(userId, version);
    return version;
}

/** 递增用户会话版本并返回新值。 */
export async function bumpSessionVersion(userId: number): Promise<number> {
    const db = await getDbInstance();
    await runDb(db, 'UPDATE users SET session_version = COALESCE(session_version, 0) + 1 WHERE id = ?', [userId]);
    versionCache.delete(userId);
    const version = await getCurrentSessionVersion(userId);
    return version ?? 0;
}

/** 仅供测试：直接设置缓存值，避免依赖数据库。 */
export function __setCachedSessionVersionForTest(userId: number, version: number | undefined): void {
    if (version === undefined) versionCache.delete(userId);
    else versionCache.set(userId, version);
}

export interface SessionLike {
    userId?: number;
    sessionVersion?: number;
    requiresTwoFactor?: boolean;
}

/** 会话是否已完成登录且版本号仍然有效 */
export async function isSessionStillValid(session: SessionLike | undefined | null): Promise<boolean> {
    if (!session || !session.userId || session.requiresTwoFactor) return false;
    const current = await getCurrentSessionVersion(session.userId);
    return isSessionVersionCurrent(session.sessionVersion, current);
}

// --- 撤销事件：WebSocket 层订阅，关闭对应的 WebSocket 与 SSH 会话 ---
export interface SessionRevocation {
    userId: number;
    /** 只关闭这个 express 会话的连接 (例如登出) */
    onlyExpressSessionId?: string;
    /** 关闭该用户除此 express 会话外的所有连接 (例如修改密码的会话自己保留) */
    exceptExpressSessionId?: string;
    reason: string;
}

const revocationEmitter = new EventEmitter();

export function onSessionRevoked(listener: (revocation: SessionRevocation) => void): void {
    revocationEmitter.on('revoked', listener);
}

export function emitSessionRevoked(revocation: SessionRevocation): void {
    revocationEmitter.emit('revoked', revocation);
}

/** 判断某个连接是否属于本次撤销范围 */
export function isConnectionRevoked(
    connection: { userId?: number; expressSessionId?: string },
    revocation: SessionRevocation
): boolean {
    if (connection.userId !== revocation.userId) return false;
    if (revocation.onlyExpressSessionId !== undefined) {
        return connection.expressSessionId === revocation.onlyExpressSessionId;
    }
    if (revocation.exceptExpressSessionId !== undefined) {
        return connection.expressSessionId !== revocation.exceptExpressSessionId;
    }
    return true;
}
