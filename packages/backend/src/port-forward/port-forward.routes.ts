import { Router, Request, Response, NextFunction } from 'express';
import * as Controller from './port-forward.controller';
import { isAuthenticated } from '../auth/auth.middleware';
import { isDesktopMode } from '../auth/desktop-host-guard';

const router = Router();

/**
 * 端口转发会在后端所在机器上开监听端口。
 * 桌面端（Electron）后端跑在用户自己电脑上，监听的就是本机端口，这是预期行为；
 * Web / Docker 部署时后端在服务器上，让网页随手在服务器上开端口是安全隐患，
 * 所以只在桌面模式（Electron 主进程注入了 NEXUS_DESKTOP_PROXY_TOKEN）下开放。
 */
export const requireDesktopMode = (_req: Request, res: Response, next: NextFunction): void => {
    if (!isDesktopMode()) {
        res.status(403).json({ message: 'Port forwarding is only available in the desktop app.', code: 'PORT_FORWARD_DESKTOP_ONLY' });
        return;
    }
    next();
};

router.use(isAuthenticated);
router.use(requireDesktopMode);

// 规则按连接绑定：列表 / 新增都要带 connectionId
router.get('/', Controller.list);
router.get('/status', Controller.status);
router.post('/', Controller.create);
// 改动规则后会自动重启，避免监听留在旧端口上
router.put('/:id', Controller.update);
router.delete('/:id', Controller.remove);
// 启停：start 会把 auto_start 置 1（下次启动自动恢复），stop 置 0
router.post('/:id/start', Controller.start);
router.post('/:id/stop', Controller.stop);

export default router;
