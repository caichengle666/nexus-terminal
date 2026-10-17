import { Request, Response, NextFunction } from 'express';
import { isLocalIp, matchesWhitelist } from './ip-match';
import { settingsService } from '../settings/settings.service';

export { matchesWhitelist, normalizeIp, parseNormalizedIp, isLocalIp, parseWhitelistEntries } from './ip-match';

const IP_WHITELIST_SETTING_KEY = 'ipWhitelist';

// 设置 IP_WHITELIST_DEBUG=true 可输出逐请求的调试日志 (默认关闭)
const DEBUG = process.env.IP_WHITELIST_DEBUG === 'true';

/** 读取设置中的白名单并判断 IP 是否允许。供 Express 中间件与 WebSocket 升级共用。 */
export async function isIpAllowed(ip: string | null | undefined): Promise<boolean> {
    if (ip && isLocalIp(ip)) {
        if (DEBUG) console.debug(`[IP Whitelist] 允许本地回环地址 (${ip}) 访问。`);
        return true;
    }
    const whitelistString = await settingsService.getSetting(IP_WHITELIST_SETTING_KEY);
    return matchesWhitelist(ip, whitelistString);
}

/**
 * IP 白名单中间件
 * 检查请求来源 IP (req.ip，遵循 Express 的 trust proxy 设置) 是否在白名单内。
 * 如果白名单未设置或为空，则允许所有 IP。本地回环地址始终允许访问。
 */
export const ipWhitelistMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const requestIpString = req.ip || req.socket.remoteAddress;

        if (!requestIpString) {
            console.warn('无法获取请求 IP 地址，已拒绝访问。');
            return res.status(403).json({ message: '禁止访问：无法识别来源 IP。' });
        }

        if (await isIpAllowed(requestIpString)) {
            return next();
        }

        console.warn(`已拒绝来自 IP ${requestIpString} 的访问 (不在白名单内)。`);
        return res.status(403).json({ message: '禁止访问：您的 IP 地址不在允许列表中。' });
    } catch (error: any) {
        console.error('IP 白名单中间件执行出错:', error);
        // 中间件出错时，为安全起见，默认拒绝访问
        return res.status(500).json({ message: '服务器内部错误 (IP 校验失败)。' });
    }
};
