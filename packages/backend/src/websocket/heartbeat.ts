import WebSocket, { WebSocketServer } from 'ws';
import { AuthenticatedWebSocket } from './types';
import { cleanupClientConnection } from './utils';

const HEARTBEAT_INTERVAL_MS = 5000; // 保持原始的心跳间隔

export function initializeHeartbeat(wss: WebSocketServer): NodeJS.Timeout {
    const heartbeatInterval = setInterval(() => {
        wss.clients.forEach((ws: WebSocket) => {
            const extWs = ws as AuthenticatedWebSocket;
            if (extWs.readyState !== WebSocket.OPEN) {
                return;
            }
            if (extWs.isAlive === false) {
                console.log(`WebSocket 心跳检测：用户 ${extWs.username} (会话: ${extWs.sessionId}) 连接无响应，正在终止...`);
                void cleanupClientConnection(extWs.sessionId).catch(error => {
                    console.error(`WebSocket 心跳清理会话 ${extWs.sessionId} 失败:`, error);
                });
                extWs.terminate();
                return;
            }
            extWs.isAlive = false;
            try {
                extWs.ping(() => {});
            } catch (error) {
                console.warn(`WebSocket 心跳发送失败 (会话: ${extWs.sessionId}):`, error);
                void cleanupClientConnection(extWs.sessionId).catch(cleanupError => {
                    console.error(`WebSocket 心跳失败后清理会话 ${extWs.sessionId} 失败:`, cleanupError);
                });
            }
        });
    }, HEARTBEAT_INTERVAL_MS);

    // 当 WebSocket 服务器关闭时，清除心跳定时器
    wss.on('close', () => {
        console.log('WebSocket 服务器正在关闭，清理心跳定时器...');
        clearInterval(heartbeatInterval);
    });

    console.log(`心跳检测已初始化，间隔: ${HEARTBEAT_INTERVAL_MS}ms`);
    return heartbeatInterval;
}
