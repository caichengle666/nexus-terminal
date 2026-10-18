import WebSocket from 'ws';
import { AuthenticatedWebSocket, ClientState } from './types';
import { clientStates, sftpService, statusMonitorService } from './state';
import { cleanupClientConnection } from './utils';
import { startDockerStatusPolling } from './handlers/docker.handler';

/**
 * WebSocket 断线续连
 *
 * 浏览器网络抖动、休眠唤醒、反向代理重启都会让 WebSocket 断开。以前一断开就立即关闭
 * SSH 连接，前端自动重连时只能新建 SSH 会话，终端里正在跑的程序和输出全部丢失。
 *
 * 现在 WebSocket 断开后，SSH 会话进入“分离”状态，保留 WS_RESUME_GRACE_SECONDS 秒
 * （默认 180 秒，设为 0 关闭此功能）。期间终端输出写入一个有上限的缓冲区。
 * 同一用户带着同一 sessionId、同一连接重新发起 ssh:connect 时，直接接回原会话并补发缓冲输出；
 * 超过宽限期仍未重连，才真正清理 SSH 连接。
 */
const parseNonNegativeInt = (value: string | undefined, fallback: number): number => {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

export const RESUME_GRACE_MS = parseNonNegativeInt(process.env.WS_RESUME_GRACE_SECONDS, 180) * 1000;
export const RESUME_BUFFER_MAX_BYTES = parseNonNegativeInt(process.env.WS_RESUME_BUFFER_BYTES, 512 * 1024);
const REPLAY_CHUNK_BYTES = 64 * 1024;

export function isDetached(state: ClientState | undefined): boolean {
    return !!state?.detachedAt;
}

/** 分离期间缓存终端输出，超过上限时丢弃最旧的数据 */
export function appendDetachedOutput(state: ClientState, data: Buffer, maxBytes: number = RESUME_BUFFER_MAX_BYTES): void {
    if (!state.detachedAt || maxBytes <= 0) return;
    const chunks = state.detachedOutput ??= [];
    chunks.push(Buffer.from(data));
    state.detachedOutputBytes = (state.detachedOutputBytes ?? 0) + data.length;
    while ((state.detachedOutputBytes ?? 0) > maxBytes && chunks.length > 0) {
        const overflow = state.detachedOutputBytes! - maxBytes;
        const head = chunks[0];
        if (head.length <= overflow) {
            chunks.shift();
            state.detachedOutputBytes! -= head.length;
        } else {
            chunks[0] = head.subarray(overflow);
            state.detachedOutputBytes! -= overflow;
        }
        state.detachedOutputTruncated = true;
    }
}

/**
 * WebSocket 关闭/出错时调用：能保留就进入分离状态，否则立即清理。
 */
export function detachClientConnection(ws: AuthenticatedWebSocket, graceMs: number = RESUME_GRACE_MS): void {
    const sessionId = ws.sessionId;
    if (!sessionId) return;
    const state = clientStates.get(sessionId);
    // 会话已经被新的 WebSocket 接管，旧连接的 close 不能影响它
    if (!state || state.ws !== ws || state.isCleaningUp) return;
    if (state.detachedAt) return;

    const resumable = graceMs > 0
        && !state.isMarkedForSuspend // 用户主动挂起的会话走原有挂起服务流程
        && !state.isSuspendedByService
        && !!state.sshClient
        && !!state.sshShellStream;
    if (!resumable) {
        void cleanupClientConnection(sessionId);
        return;
    }

    state.detachedAt = Date.now();
    state.detachedOutput = [];
    state.detachedOutputBytes = 0;
    state.detachedOutputTruncated = false;
    if (state.detachTimer) clearTimeout(state.detachTimer);
    state.detachTimer = setTimeout(() => {
        const current = clientStates.get(sessionId);
        if (current === state && current.detachedAt) {
            console.log(`WebSocket: 会话 ${sessionId} 断开后 ${Math.round(graceMs / 1000)} 秒内未重连，清理 SSH 连接。`);
            void cleanupClientConnection(sessionId);
        }
    }, graceMs);
    console.log(`WebSocket: 会话 ${sessionId} 的 WebSocket 已断开，SSH 会话保留 ${Math.round(graceMs / 1000)} 秒等待重连。`);
}

export function canReattach(state: ClientState | undefined, requestedConnectionId: unknown): state is ClientState {
    if (!state || state.isCleaningUp || state.isSuspendedByService) return false;
    if (!state.sshClient || !state.sshShellStream || !state.isShellReady) return false;
    const requested = Number.parseInt(String(requestedConnectionId ?? ''), 10);
    return Number.isFinite(requested) && requested === state.dbConnectionId;
}

/**
 * 把一个新的 WebSocket 接到仍然存活的 SSH 会话上。
 * 调用方必须已经校验 ws.userId 与会话归属一致。
 */
export function reattachClientConnection(
    ws: AuthenticatedWebSocket,
    sessionId: string,
    state: ClientState,
    payload: any
): void {
    if (state.detachTimer) clearTimeout(state.detachTimer);
    state.detachTimer = undefined;

    const previousWs = state.ws;
    if (previousWs && previousWs !== ws) {
        // 旧连接可能还没被服务器察觉断开（半开 TCP）。先解除绑定，再关闭，
        // 这样它的 close 事件不会把刚接回的会话清理掉。
        if (previousWs.sessionId === sessionId) delete previousWs.sessionId;
        if (previousWs.readyState === WebSocket.OPEN || previousWs.readyState === WebSocket.CONNECTING) {
            try { previousWs.close(4001, 'Session resumed on another connection'); } catch { /* ignore */ }
        }
    }

    const buffered = state.detachedOutput ?? [];
    const truncated = !!state.detachedOutputTruncated;
    const detachedForMs = state.detachedAt ? Date.now() - state.detachedAt : 0;
    state.detachedAt = undefined;
    state.detachedOutput = undefined;
    state.detachedOutputBytes = 0;
    state.detachedOutputTruncated = false;

    state.ws = ws;
    ws.sessionId = sessionId;

    const send = (message: unknown) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };

    send({
        type: 'ssh:connected',
        payload: { connectionId: state.dbConnectionId, sessionId, resumed: true, detachedForMs, outputTruncated: truncated },
    });

    if (buffered.length > 0) {
        const all = Buffer.concat(buffered);
        for (let offset = 0; offset < all.length; offset += REPLAY_CHUNK_BYTES) {
            send({ type: 'ssh:output', payload: all.subarray(offset, offset + REPLAY_CHUNK_BYTES).toString('base64'), encoding: 'base64' });
        }
    }

    const cols = Number(payload?.cols);
    const rows = Number(payload?.rows);
    if (state.sshShellStream && Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) {
        try { state.sshShellStream.setWindow(rows, cols, 0, 0); } catch { /* ignore */ }
    }

    // 状态监控与 Docker 轮询在 WebSocket 断开时会自行停止，这里重新启动
    statusMonitorService.startStatusPolling(sessionId);
    void startDockerStatusPolling(sessionId);

    // SFTP：已就绪则重新告知前端，否则重新初始化
    sftpService.initializeSftpSession(sessionId).catch(error => {
        console.error(`WebSocket: 会话 ${sessionId} 恢复后初始化 SFTP 失败:`, error);
    });

    console.log(`WebSocket: 用户 ${ws.username} 已接回会话 ${sessionId}（断开 ${Math.round(detachedForMs / 1000)} 秒，补发 ${buffered.reduce((n, b) => n + b.length, 0)} 字节输出）。`);
}
