import http from 'http';
import { WebSocketServer } from 'ws';
import { RequestHandler } from 'express';
import { initializeHeartbeat } from './websocket/heartbeat';
import { initializeUpgradeHandler } from './websocket/upgrade';
import { initializeConnectionHandler } from './websocket/connection';
import { clientStates, sftpService } from './websocket/state';
import { sshSuspendService } from './ssh-suspend/ssh-suspend.service';
import { cleanupClientConnection } from './websocket/utils';
import { isConnectionRevoked, onSessionRevoked } from './auth/session-version';
import { AuthenticatedWebSocket } from './websocket/types';


export {
    ClientState,
    AuthenticatedWebSocket,
    DockerContainer,
    DockerStats,
    PortInfo,
    SshSuspendClientToServerMessages,
    SshSuspendServerToClientMessages,
    SuspendedSessionInfo
} from './websocket/types'; // Re-export essential types

export const initializeWebSocket = async (server: http.Server, sessionParser: RequestHandler): Promise<WebSocketServer> => {
    // Environment variables are expected to be loaded by index.ts

    // 单帧上限：分片上传每片 256KB (base64 约 350KB)，sftp:writefile 内联最多 2MB 内容 (JSON 转义后可能膨胀)，
    // 默认 8MB 留足余量；ws 默认的 100MB 太大，恶意帧可直接占满内存。
    const maxPayloadEnv = Number.parseInt(process.env.WS_MAX_PAYLOAD_BYTES ?? '', 10);
    const maxPayload = Number.isFinite(maxPayloadEnv) && maxPayloadEnv >= 1024 * 1024 ? maxPayloadEnv : 8 * 1024 * 1024;
    const wss = new WebSocketServer({ noServer: true, maxPayload });
    // const db = await getDbInstance(); // db instance might not be directly needed here anymore if all DB interactions are in services/handlers

    // 1. Initialize Heartbeat
    const heartbeatTimer = initializeHeartbeat(wss); // Store timer to potentially clear it, though heartbeat.ts handles its own wss.on('close')

    // 2. Initialize Upgrade Handler (handles authentication and protocol upgrade)
    initializeUpgradeHandler(server, wss, sessionParser);

    // 3. Initialize Connection Handler (handles 'connection' event and message routing)
    initializeConnectionHandler(wss, sshSuspendService, sftpService); // +++ 传递 sftpService 实例 +++

    // 4. 会话撤销 (登出 / 修改密码 / 2FA 变更)：关闭对应的 WebSocket 及其 SSH 会话
    onSessionRevoked((revocation) => {
        let closedSessions = 0;
        let closedSockets = 0;
        clientStates.forEach((state, sessionId) => {
            if (state.ws && isConnectionRevoked(state.ws, revocation)) {
                closedSessions += 1;
                void cleanupClientConnection(sessionId, { forceClose: true });
            }
        });
        wss.clients.forEach((client) => {
            const extWs = client as AuthenticatedWebSocket;
            if (isConnectionRevoked(extWs, revocation)) {
                closedSockets += 1;
                try { extWs.close(4401, 'Session revoked'); } catch { /* ignore */ }
            }
        });
        if (closedSessions || closedSockets) {
            console.log(`WebSocket: 用户 ${revocation.userId} 会话撤销 (${revocation.reason})，已关闭 ${closedSockets} 个 WebSocket、${closedSessions} 个 SSH 会话。`);
        }
    });

    // --- WebSocket 服务器关闭处理 ---
    wss.on('close', () => {
        console.log('WebSocket 服务器正在关闭，清理心跳定时器和所有活动会话...');
        clearInterval(heartbeatTimer); // Clear heartbeat started by this function
        
        clientStates.forEach((_state, sessionId) => {
            cleanupClientConnection(sessionId);
        });
        console.log('所有活动会话已清理。');
    });


    console.log('WebSocket 服务器初始化完成。');
    return wss;
};

export { clientStates };
