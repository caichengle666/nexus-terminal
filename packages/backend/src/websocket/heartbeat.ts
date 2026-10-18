import WebSocket, { WebSocketServer } from 'ws';
import { AuthenticatedWebSocket } from './types';

/**
 * 心跳策略：
 * - 每 HEARTBEAT_INTERVAL_MS 发送一次 ping；
 * - 连续 HEARTBEAT_MAX_MISSED 次未收到 pong 才判定连接失效（约 45 秒），
 *   避免网络短暂抖动、反向代理缓冲或服务器忙时误杀整个 SSH/SFTP 会话；
 * - 若服务端发送缓冲区仍有积压（例如正在向慢速客户端推送大目录列表/文件内容），
 *   pong 会排在这些数据之后，此时不计为丢失。
 * 可通过 WS_HEARTBEAT_INTERVAL_MS / WS_HEARTBEAT_MAX_MISSED 环境变量调整。
 */
const parsePositiveInt = (value: string | undefined, fallback: number, min: number): number => {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
};

export const HEARTBEAT_INTERVAL_MS = parsePositiveInt(process.env.WS_HEARTBEAT_INTERVAL_MS, 15000, 1000);
export const HEARTBEAT_MAX_MISSED = parsePositiveInt(process.env.WS_HEARTBEAT_MAX_MISSED, 3, 1);
/** 发送缓冲区超过该字节数时，认为链路正忙于传输数据，本轮不计丢失 */
const BUSY_BUFFERED_BYTES = 64 * 1024;

type HeartbeatSocket = AuthenticatedWebSocket & { missedPongs?: number };

export function evaluateHeartbeat(ws: HeartbeatSocket, maxMissed: number = HEARTBEAT_MAX_MISSED): 'ping' | 'terminate' | 'skip' {
    if (ws.isAlive !== false) {
        ws.missedPongs = 0;
        return 'ping';
    }
    if ((ws.bufferedAmount ?? 0) > BUSY_BUFFERED_BYTES) {
        // 链路忙：保持当前计数，但不再累加
        return 'skip';
    }
    ws.missedPongs = (ws.missedPongs ?? 0) + 1;
    return ws.missedPongs >= maxMissed ? 'terminate' : 'ping';
}

export function initializeHeartbeat(wss: WebSocketServer): NodeJS.Timeout {
    const heartbeatInterval = setInterval(() => {
        wss.clients.forEach((ws: WebSocket) => {
            const extWs = ws as HeartbeatSocket;
            if (extWs.readyState !== WebSocket.OPEN) {
                return;
            }
            const decision = evaluateHeartbeat(extWs);
            if (decision === 'skip') return;
            if (decision === 'terminate') {
                console.log(`WebSocket 心跳检测：用户 ${extWs.username} (会话: ${extWs.sessionId}) 连续 ${extWs.missedPongs} 次无响应，正在终止...`);
                // terminate 会触发 close 事件，由 close 处理器决定分离（等待重连）还是清理
                extWs.terminate();
                return;
            }
            extWs.isAlive = false;
            try {
                extWs.ping(() => {});
            } catch (error) {
                // ping 失败通常意味着底层 socket 已关闭，close 事件会负责清理
                console.warn(`WebSocket 心跳发送失败 (会话: ${extWs.sessionId}):`, error);
            }
        });
    }, HEARTBEAT_INTERVAL_MS);

    // 当 WebSocket 服务器关闭时，清除心跳定时器
    wss.on('close', () => {
        console.log('WebSocket 服务器正在关闭，清理心跳定时器...');
        clearInterval(heartbeatInterval);
    });

    console.log(`心跳检测已初始化，间隔: ${HEARTBEAT_INTERVAL_MS}ms，最多允许连续丢失 ${HEARTBEAT_MAX_MISSED} 次`);
    return heartbeatInterval;
}
