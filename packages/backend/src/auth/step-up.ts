import { Request } from 'express';
import bcrypt from 'bcrypt';
import { getDbInstance, getDb } from '../database/connection';
import { ipBlacklistService } from './ip-blacklist.service';

/**
 * 敏感操作的二次确认 (step-up)：要求再次输入当前密码。
 * 用于 Passkey 注册、启用 2FA、导出连接凭据，防止被盗会话把临时访问变成持久访问或批量导出凭据。
 * 密码错误计入 IP 黑名单失败次数。
 */
export async function verifyCurrentPassword(req: Request, password: unknown): Promise<boolean> {
    const userId = req.session.userId;
    if (!userId || typeof password !== 'string' || password.length === 0) return false;
    const db = await getDbInstance();
    const user = await getDb<{ hashed_password: string }>(db, 'SELECT hashed_password FROM users WHERE id = ?', [userId]);
    if (!user) return false;
    const ok = await bcrypt.compare(password, user.hashed_password);
    if (!ok) {
        const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
        ipBlacklistService.recordFailedAttempt(clientIp);
    }
    return ok;
}

export const STEP_UP_PASSWORD_REQUIRED_CODE = 'CURRENT_PASSWORD_REQUIRED';
export const STEP_UP_PASSWORD_INVALID_CODE = 'CURRENT_PASSWORD_INVALID';
