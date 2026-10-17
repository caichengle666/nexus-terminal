import http from 'http';
import url from 'url';
import { Request, RequestHandler } from 'express';
import { WebSocketServer } from 'ws';
import { Duplex } from 'stream';
import { AuthenticatedWebSocket } from './types';
import { getClientIp } from '../utils/client-ip';
import { isIpAllowed } from '../auth/ipWhitelist.middleware';
import { checkWsOrigin } from './origin-check';

const rejectUpgrade = (socket: Duplex, status: number, message: string): void => {
    try {
        socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    } catch {
        /* ignore */
    }
    socket.destroy();
};

export function initializeUpgradeHandler(
    server: http.Server,
    wss: WebSocketServer,
    sessionParser: RequestHandler
): void {
    server.on('upgrade', async (request: Request, socket: Duplex, head: Buffer) => {

        const parsedUrl = url.parse(request.url || '', true); // Parse URL and query string
        const pathname = parsedUrl.pathname;

        // 客户端 IP：与 Express 的 trust proxy 规则一致 (TRUST_PROXY=true 时信任 1 跳代理，否则只用 socket 地址)，
        // 不再无条件信任 X-Forwarded-For / X-Real-IP，避免伪造 IP 绕过白名单或污染审计日志。
        const ipAddress = getClientIp(request) || 'unknown';

        console.log(`WebSocket: 升级请求来自 IP: ${ipAddress}, Path: ${pathname}`);

        // --- Origin 校验 (防止跨站 WebSocket 劫持) ---
        if (!checkWsOrigin(request)) {
            console.warn(`WebSocket: 已拒绝来自不允许的 Origin 的升级请求 (IP: ${ipAddress}, Path: ${pathname}, Origin: ${request.headers.origin}, Host: ${request.headers.host})。如需允许，请设置 ALLOWED_WS_ORIGINS。`);
            rejectUpgrade(socket, 403, 'Forbidden');
            return;
        }

        let ipAllowed: boolean;
        try {
            ipAllowed = await isIpAllowed(ipAddress === 'unknown' ? undefined : ipAddress);
        } catch (error) {
            console.error('WebSocket: IP 白名单校验出错，已拒绝升级请求:', error);
            rejectUpgrade(socket, 500, 'Internal Server Error');
            return;
        }
        if (!ipAllowed) {
            console.warn(`WebSocket: 已拒绝来自 IP ${ipAddress} 的升级请求 (不在白名单内)。`);
            rejectUpgrade(socket, 403, 'Forbidden');
            return;
        }

        // @ts-ignore Express-session 类型问题
        sessionParser(request, {} as any, () => {
            // --- 认证检查 ---
            if (!request.session || !request.session.userId || (request.session as any).requiresTwoFactor) {
                console.log(`WebSocket 认证失败 (Path: ${pathname})：未找到会话或用户未登录。`);
                rejectUpgrade(socket, 401, 'Unauthorized');
                return;
            }
            console.log(`WebSocket 认证成功 (Path: ${pathname})：用户 ${request.session.username} (ID: ${request.session.userId})`);

            // --- 根据路径处理升级 ---
            // 本地调试用/rdp-proxy，nginx反代用/ws/rdp-proxy
            if (pathname === '/rdp-proxy' || pathname === '/ws/rdp-proxy') {
                // RDP 代理路径 - 直接处理升级，连接逻辑在 'connection' 事件中处理
                console.log(`WebSocket: Handling RDP proxy upgrade for user ${request.session.username}`);
                wss.handleUpgrade(request, socket, head, (ws) => {
                    const extWs = ws as AuthenticatedWebSocket;
                    extWs.userId = request.session.userId;
                    extWs.username = request.session.username;
                    // 传递必要信息给 connection 事件
                    (request as any).clientIpAddress = ipAddress;
                    (request as any).isRdpProxy = true; // 标记为 RDP 代理连接
                    // 传递 RDP token 和其他参数
                    (request as any).rdpToken = parsedUrl.query.token;
                    (request as any).rdpWidth = parsedUrl.query.width;
                    (request as any).rdpHeight = parsedUrl.query.height;
                    (request as any).rdpDpi = parsedUrl.query.dpi;
                    wss.emit('connection', extWs, request);
                });
            } else {
                // 默认路径 (SSH, SFTP, Docker etc.) - 按原逻辑处理
                console.log(`WebSocket: Handling standard upgrade for user ${request.session.username}`);
                wss.handleUpgrade(request, socket, head, (ws) => {
                    const extWs = ws as AuthenticatedWebSocket;
                    extWs.userId = request.session.userId;
                    extWs.username = request.session.username;
                    (request as any).clientIpAddress = ipAddress;
                    (request as any).isRdpProxy = false; // 标记为非 RDP 代理连接
                    wss.emit('connection', extWs, request);
                });
            }
        });
    });
    console.log('WebSocket upgrade handler initialized.');
}