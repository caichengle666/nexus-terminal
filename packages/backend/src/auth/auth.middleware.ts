import { Request, Response, NextFunction } from 'express';
import { getCurrentSessionVersion, isSessionVersionCurrent } from './session-version';

/**
 * 认证中间件：检查用户是否已登录 (通过 session 中的 userId 判断)，
 * 并校验会话版本号 (修改密码 / 2FA 后旧会话失效)。
 */
export const isAuthenticated = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.session || !req.session.userId || req.session.requiresTwoFactor) {
        res.status(401).json({ message: '未授权：请先登录。' });
        return;
    }
    let currentVersion: number | null;
    try {
        currentVersion = await getCurrentSessionVersion(req.session.userId);
    } catch (error) {
        console.error('[Auth] 校验会话版本失败:', error);
        res.status(500).json({ message: '认证检查失败。' });
        return;
    }
    if (!isSessionVersionCurrent(req.session.sessionVersion, currentVersion)) {
        const userId = req.session.userId;
        req.session.destroy(() => { /* ignore */ });
        console.log(`[Auth] 用户 ${userId} 的会话版本已过期 (密码或两步验证已变更)，拒绝请求。`);
        res.status(401).json({ message: '会话已失效，请重新登录。', code: 'SESSION_REVOKED' });
        return;
    }
    next();
};
