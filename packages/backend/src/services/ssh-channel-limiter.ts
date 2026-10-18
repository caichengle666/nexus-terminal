import type { Client, ClientChannel, ExecOptions } from 'ssh2';

/**
 * 每个 SSH 连接的 exec 通道并发上限。
 *
 * OpenSSH 默认 `MaxSessions 10`：一个 TCP 连接上同时最多 10 个会话通道。
 * 终端 shell 占 1 个、SFTP 占 1 个（恢复时可能短暂占 2 个），
 * 状态监控 / Docker 轮询 / AI 执行 / 压缩解压都通过 exec 打开新通道。
 * 不加限制时这些通道叠加会把配额用完，导致 SFTP 重建失败、文件管理器断开。
 *
 * 这里把 exec 通道限制在 SSH_MAX_EXEC_CHANNELS（默认 6）个以内，超出的请求排队，
 * 排队超过 SSH_EXEC_QUEUE_TIMEOUT_MS（默认 30 秒）则返回错误。
 */
const parsePositiveInt = (value: string | undefined, fallback: number): number => {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const DEFAULT_MAX_EXEC_CHANNELS = parsePositiveInt(process.env.SSH_MAX_EXEC_CHANNELS, 6);
export const DEFAULT_EXEC_QUEUE_TIMEOUT_MS = parsePositiveInt(process.env.SSH_EXEC_QUEUE_TIMEOUT_MS, 30000);

type ExecCallback = (err: Error | undefined, channel: ClientChannel) => void;

interface QueuedExec {
    command: string;
    options?: ExecOptions;
    callback: ExecCallback;
    timer: NodeJS.Timeout;
}

export interface ExecLimiterHandle {
    readonly active: number;
    readonly queued: number;
    readonly max: number;
}

const LIMITER = Symbol.for('nexus.sshExecLimiter');

export function getExecChannelLimiter(client: Client): ExecLimiterHandle | undefined {
    return (client as any)[LIMITER];
}

export function installExecChannelLimiter(
    client: Client,
    maxConcurrent: number = DEFAULT_MAX_EXEC_CHANNELS,
    queueTimeoutMs: number = DEFAULT_EXEC_QUEUE_TIMEOUT_MS
): ExecLimiterHandle {
    const existing = getExecChannelLimiter(client);
    if (existing) return existing;

    const originalExec = client.exec.bind(client) as unknown as (command: string, ...rest: any[]) => unknown;
    const queue: QueuedExec[] = [];
    let active = 0;
    let closed = false;

    const handle: ExecLimiterHandle = {
        get active() { return active; },
        get queued() { return queue.length; },
        max: maxConcurrent,
    };

    const pump = () => {
        while (!closed && active < maxConcurrent && queue.length > 0) {
            const next = queue.shift()!;
            clearTimeout(next.timer);
            start(next.command, next.options, next.callback);
        }
    };

    const start = (command: string, options: ExecOptions | undefined, callback: ExecCallback) => {
        active += 1;
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            active -= 1;
            pump();
        };
        const wrapped: ExecCallback = (err, channel) => {
            if (err || !channel) {
                release();
            } else {
                channel.once('close', release);
            }
            callback(err, channel);
        };
        try {
            if (options) originalExec(command, options, wrapped);
            else originalExec(command, wrapped);
        } catch (error: any) {
            release();
            callback(error instanceof Error ? error : new Error(String(error)), undefined as any);
        }
    };

    (client as any).exec = (command: string, optionsOrCallback: ExecOptions | ExecCallback, maybeCallback?: ExecCallback): Client => {
        const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
        const callback = (typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback) as ExecCallback;
        if (closed) {
            process.nextTick(() => callback(new Error('SSH 连接已关闭'), undefined as any));
            return client;
        }
        if (active < maxConcurrent) {
            start(command, options, callback);
            return client;
        }
        const entry: QueuedExec = {
            command,
            options,
            callback,
            timer: setTimeout(() => {
                const index = queue.indexOf(entry);
                if (index !== -1) queue.splice(index, 1);
                callback(new Error(`SSH 通道繁忙：等待可用 exec 通道超过 ${Math.round(queueTimeoutMs / 1000)} 秒`), undefined as any);
            }, queueTimeoutMs),
        };
        entry.timer.unref?.();
        queue.push(entry);
        return client;
    };

    const failQueue = () => {
        closed = true;
        while (queue.length > 0) {
            const entry = queue.shift()!;
            clearTimeout(entry.timer);
            entry.callback(new Error('SSH 连接已关闭'), undefined as any);
        }
    };
    client.once('close', failQueue);
    client.once('end', failQueue);

    Object.defineProperty(client, LIMITER, { value: handle, enumerable: false });
    return handle;
}
