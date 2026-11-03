import WebSocket from 'ws';
import { ClientChannel } from 'ssh2';
import { ClientState } from './types';
import { clientStates } from './state';
import { appendDetachedOutput } from './session-resume';
import { applyWsBackpressure, clearWsBackpressure } from './backpressure';
import { temporaryLogStorageService } from '../ssh-suspend/temporary-log-storage.service';
import { attachFallbackErrorListener, ListenerGroup } from '../utils/ssh-client-guard';

/**
 * 把一个 SSH Shell 通道 + SSH Client 绑定到 clientStates 里的某个会话。
 *
 * - 输出一律按原始字节 base64 发给前端（前端把 base64 还原成 Uint8Array 交给 xterm 做流式 UTF-8 解码），
 *   不在后端逐块 toString('utf8')：多字节字符被 SSH 数据块切开时逐块解码会变成 U+FFFD。
 * - 发送目标每次都取 state.ws（而不是绑定时的 ws），WebSocket 断线重连接回会话后输出跟着新连接走；
 *   分离期间输出写入断线缓冲。
 * - 返回的 ListenerGroup 记录了本次挂上的全部监听器，会话移交给挂起服务时只摘掉这些，
 *   不用 removeAllListeners（那会把兜底 error 监听、exec 限流器的 close/end 监听一起清掉）。
 */
export interface BindShellOptions {
    /** 通道关闭时发给前端的 ssh:disconnected payload */
    disconnectedPayload?: unknown;
    /** 清理本会话（只在 clientStates 里仍是这个 state 时才会真正清理） */
    cleanup: () => unknown;
    logPrefix?: string;
}

export function sendToSession(state: ClientState, message: unknown): boolean {
    const ws = state.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(message));
    return true;
}

export function bindShellSession(
    state: ClientState,
    sessionId: string,
    stream: ClientChannel,
    options: BindShellOptions
): ListenerGroup {
    // 重复绑定（例如再次恢复）时先摘掉旧的，避免监听器越积越多
    state.shellListeners?.removeAll();
    const group = new ListenerGroup();
    state.shellListeners = group;
    const logPrefix = options.logPrefix ?? `SSH: 会话 ${sessionId}`;
    const sshClient = state.sshClient;
    if (sshClient) attachFallbackErrorListener(sshClient, `${logPrefix} -`);

    const onOutput = (data: Buffer, isStderr: boolean) => {
        appendDetachedOutput(state, data);
        if (sendToSession(state, { type: 'ssh:output', payload: data.toString('base64'), encoding: 'base64' })) {
            applyWsBackpressure(() => state.ws, stream);
        }
        // 会话被标记为待挂起时，同时把原始字节写入挂起日志（读回时整体按 UTF-8 解码，不会切坏字符）
        const currentState = clientStates.get(sessionId);
        if (currentState?.isMarkedForSuspend && currentState.suspendLogPath) {
            const payload = isStderr ? Buffer.concat([Buffer.from('[STDERR] ', 'utf8'), data]) : data;
            temporaryLogStorageService.writeToLog(currentState.suspendLogPath, payload).catch(err => {
                console.error(`[SSH Handler] 写入标记会话 ${sessionId} 的日志失败 (路径: ${currentState.suspendLogPath}):`, err);
            });
        }
    };

    group.on(stream, 'data', (data: Buffer) => onOutput(data, false));
    group.on(stream.stderr, 'data', (data: Buffer) => onOutput(data, true));
    group.on(stream.stderr, 'error', (error: Error) => {
        console.error(`${logPrefix} 的 Shell stderr 错误:`, error);
    });
    group.on(stream, 'error', (error: Error) => {
        console.error(`${logPrefix} 的 Shell 通道错误:`, error);
        sendToSession(state, { type: 'ssh:error', payload: `Shell 通道错误: ${error.message}` });
        void options.cleanup();
    });
    group.on(stream, 'close', () => {
        clearWsBackpressure(stream);
        console.log(`${logPrefix} 的 Shell 通道已关闭。`);
        sendToSession(state, { type: 'ssh:disconnected', payload: options.disconnectedPayload ?? 'Shell 通道已关闭。' });
        void options.cleanup();
    });

    if (sshClient) {
        group.on(sshClient, 'close', () => {
            console.log(`${logPrefix} 的客户端连接已关闭。`);
            void options.cleanup();
        });
        group.on(sshClient, 'error', (err: Error) => {
            console.error(`${logPrefix} 的客户端连接错误:`, err);
            sendToSession(state, { type: 'ssh:error', payload: `SSH 连接错误: ${err.message}` });
            void options.cleanup();
        });
    }
    return group;
}

/** 摘掉 bindShellSession 挂上的监听（兜底 error 监听保留），并解除背压暂停 */
export function unbindShellSession(state: ClientState): void {
    state.shellListeners?.removeAll();
    state.shellListeners = undefined;
    if (state.sshShellStream) clearWsBackpressure(state.sshShellStream);
}
