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
 *
 * 后台轮询 (状态监控、Docker 轮询) 通过 execBackground() 发起，最多只能占用
 * max - SSH_EXEC_RESERVED_USER_CHANNELS（默认保留 2 个）个通道，
 * 这样远端卡住的轮询命令不会把通道耗尽，用户发起的 AI 执行 / SFTP 压缩等仍有可用通道。
 */
const parsePositiveInt = (value: string | undefined, fallback: number): number => {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const DEFAULT_MAX_EXEC_CHANNELS = parsePositiveInt(process.env.SSH_MAX_EXEC_CHANNELS, 6);
export const DEFAULT_EXEC_QUEUE_TIMEOUT_MS = parsePositiveInt(process.env.SSH_EXEC_QUEUE_TIMEOUT_MS, 30000);
const parseNonNegativeInt = (value: string | undefined, fallback: number): number => {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};
export const DEFAULT_RESERVED_USER_CHANNELS = parseNonNegativeInt(process.env.SSH_EXEC_RESERVED_USER_CHANNELS, 2);

type ExecCallback = (err: Error | undefined, channel: ClientChannel) => void;

interface QueuedExec {
    command: string;
    options?: ExecOptions;
    callback: ExecCallback;
    timer: NodeJS.Timeout;
    background: boolean;
}

export interface ExecLimiterHandle {
    readonly active: number;
    readonly queued: number;
    readonly max: number;
    readonly maxBackground: number;
    readonly activeBackground: number;
}

const LIMITER = Symbol.for('nexus.sshExecLimiter');
const BACKGROUND_EXEC = Symbol.for('nexus.sshExecBackground');

/**
 * 以“后台”优先级执行命令 (轮询类)。未安装限流器时退化为普通 exec。
 */
export function execBackground(client: Client, command: string, options: ExecOptions | undefined, callback: ExecCallback): void {
    const backgroundExec = (client as any)[BACKGROUND_EXEC];
    if (typeof backgroundExec === 'function') {
        backgroundExec(command, options, callback);
        return;
    }
    if (options) (client.exec as any)(command, options, callback);
    else (client.exec as any)(command, callback);
}

export function getExecChannelLimiter(client: Client): ExecLimiterHandle | undefined {
    return (client as any)[LIMITER];
}

export function installExecChannelLimiter(
    client: Client,
    maxConcurrent: number = DEFAULT_MAX_EXEC_CHANNELS,
    queueTimeoutMs: number = DEFAULT_EXEC_QUEUE_TIMEOUT_MS,
    reservedUserChannels: number = DEFAULT_RESERVED_USER_CHANNELS
): ExecLimiterHandle {
    const existing = getExecChannelLimiter(client);
    if (existing) return existing;

    const originalExec = client.exec.bind(client) as unknown as (command: string, ...rest: any[]) => unknown;
    const queue: QueuedExec[] = [];
    let active = 0;
    let activeBackground = 0;
    let closed = false;
    // 后台任务至少保留 1 个通道，至多 maxConcurrent - reserved 个
    const maxBackground = Math.max(1, maxConcurrent - Math.min(reservedUserChannels, maxConcurrent - 1));

    const handle: ExecLimiterHandle = {
        get active() { return active; },
        get queued() { return queue.length; },
        max: maxConcurrent,
        maxBackground,
        get activeBackground() { return activeBackground; },
    };

    const canStart = (background: boolean): boolean =>
        active < maxConcurrent && (!background || activeBackground < maxBackground);

    const pump = () => {
        let index = 0;
        while (!closed && active < maxConcurrent && index < queue.length) {
            const next = queue[index];
            if (!canStart(next.background)) {
                index += 1; // 后台配额已满：跳过，让排在后面的用户请求先执行
                continue;
            }
            queue.splice(index, 1);
            clearTimeout(next.timer);
            start(next.command, next.options, next.callback, next.background);
        }
    };

    const start = (command: string, options: ExecOptions | undefined, callback: ExecCallback, background: boolean) => {
        active += 1;
        if (background) activeBackground += 1;
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            active -= 1;
            if (background) activeBackground -= 1;
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

    const enqueue = (command: string, options: ExecOptions | undefined, callback: ExecCallback, background: boolean): void => {
        if (closed) {
            process.nextTick(() => callback(new Error('SSH 连接已关闭'), undefined as any));
            return;
        }
        if (canStart(background)) {
            start(command, options, callback, background);
            return;
        }
        const entry: QueuedExec = {
            command,
            options,
            callback,
            background,
            timer: setTimeout(() => {
                const index = queue.indexOf(entry);
                if (index !== -1) queue.splice(index, 1);
                callback(new Error(`SSH 通道繁忙：等待可用 exec 通道超过 ${Math.round(queueTimeoutMs / 1000)} 秒`), undefined as any);
            }, queueTimeoutMs),
        };
        entry.timer.unref?.();
        queue.push(entry);
    };

    (client as any).exec = (command: string, optionsOrCallback: ExecOptions | ExecCallback, maybeCallback?: ExecCallback): Client => {
        const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
        const callback = (typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback) as ExecCallback;
        enqueue(command, options, callback, false);
        return client;
    };
    Object.defineProperty(client, BACKGROUND_EXEC, {
        value: (command: string, options: ExecOptions | undefined, callback: ExecCallback) => enqueue(command, options, callback, true),
        enumerable: false,
    });

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
