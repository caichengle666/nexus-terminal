import http from 'http';
import type { WebSocketServer } from 'ws';

/**
 * 收到 SIGTERM / SIGINT 时有序退出：
 *   1. 停止接受新连接（http server close，空闲 keep-alive 连接立即断开）；
 *   2. 关闭所有 WebSocket（1001 Going Away），前端会显示断开并自动重连；
 *   3. 结束全部 SSH 会话（ssh 连接正常关闭，远端不会残留半开会话）；
 *   4. 关闭数据库；
 *   5. exit(0)。
 * 任一步骤卡住时，timeoutMs 后强制退出，保证 `docker stop` 不用等到 SIGKILL。
 *
 * Docker 里 node 是 PID 1，没有处理器的 SIGTERM 会被直接忽略，所以这个处理器是必须的；
 * compose 另外加了 `init: true`。
 */
export interface GracefulShutdownDeps {
    server?: http.Server;
    getWss?: () => WebSocketServer | undefined;
    cleanupSessions?: () => Promise<unknown>;
    closeDb?: () => Promise<unknown>;
    exit?: (code: number) => void;
    timeoutMs?: number;
    log?: (message: string) => void;
}

export function createGracefulShutdown(deps: GracefulShutdownDeps) {
    let shuttingDown = false;
    const exit = deps.exit ?? ((code: number) => process.exit(code));
    const log = deps.log ?? ((message: string) => console.log(message));
    const timeoutMs = deps.timeoutMs ?? 8000;

    return async (signal: string): Promise<void> => {
        if (shuttingDown) {
            log(`[Shutdown] 再次收到 ${signal}，立即退出。`);
            exit(1);
            return;
        }
        shuttingDown = true;
        log(`[Shutdown] 收到 ${signal}，正在关闭后端...`);
        const forceTimer = setTimeout(() => {
            log(`[Shutdown] 清理超过 ${Math.round(timeoutMs / 1000)} 秒，强制退出。`);
            exit(1);
        }, timeoutMs);
        forceTimer.unref?.();

        const step = async (name: string, fn: () => unknown) => {
            try {
                await fn();
            } catch (error: any) {
                log(`[Shutdown] ${name} 出错: ${error?.message || error}`);
            }
        };

        const server = deps.server;
        const serverClosed = server
            ? new Promise<void>(resolve => {
                if (!server.listening) return resolve();
                server.close(() => resolve());
                (server as any).closeIdleConnections?.();
            })
            : Promise.resolve();

        await step('关闭 WebSocket', () => {
            const wss = deps.getWss?.();
            wss?.clients.forEach(client => {
                try { client.close(1001, 'Server shutting down'); } catch { /* ignore */ }
            });
        });
        await step('结束 SSH 会话', () => deps.cleanupSessions?.());
        await step('关闭 WebSocket 服务', () => {
            const wss = deps.getWss?.();
            wss?.clients.forEach(client => { try { client.terminate(); } catch { /* ignore */ } });
            wss?.close();
        });
        // 剩余的活动 HTTP 连接（长轮询 / 下载）直接断开，不等它们自然结束
        await step('关闭 HTTP 服务', async () => {
            (server as any)?.closeAllConnections?.();
            await serverClosed;
        });
        await step('关闭数据库', () => deps.closeDb?.());

        clearTimeout(forceTimer);
        log('[Shutdown] 后端已正常关闭。');
        exit(0);
    };
}
