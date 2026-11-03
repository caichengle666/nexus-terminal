/**
 * 桌面端：后端是 Electron 主进程的子进程。主进程被强杀或崩溃时（Windows 上子进程
 * 不会被连带结束），后端会一直占着固定端口，之后每次启动都失败。
 * 这里在三个信号上检测父进程消失，任意一个触发就调用 onParentGone（只调用一次）：
 *  1. stdin 被关闭（主进程以 stdio: 'pipe' 启动后端，主进程退出时管道关闭）；
 *  2. IPC 通道断开（如果是用 fork/ipc 启动的）；
 *  3. 轮询父进程 PID 是否还活着（防止 stdin 被继承到别处而迟迟不关闭）。
 */

export interface ParentWatchOptions {
    /** 要监视的父进程 PID。 */
    parentPid: number;
    onParentGone: (reason: string) => void;
    /** 默认 process.stdin；传 null 表示不监听。 */
    stdin?: NodeJS.ReadableStream | null;
    /** 默认 process（用于 IPC disconnect）；传 null 表示不监听。 */
    ipc?: NodeJS.EventEmitter | null;
    pollIntervalMs?: number;
    /** 判断进程是否存活，默认 process.kill(pid, 0)。 */
    isProcessAlive?: (pid: number) => boolean;
}

export const isProcessAlive = (pid: number): boolean => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: any) {
        // EPERM：进程存在，只是没有权限发信号
        return error?.code === 'EPERM';
    }
};

/** 解析 NEXUS_PARENT_PID；无效时返回 null（例如 Docker / Web 部署不设置它）。 */
export const parseParentPid = (value: string | undefined): number | null => {
    const pid = Number((value || '').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
};

export function watchParentProcess(options: ParentWatchOptions): () => void {
    const alive = options.isProcessAlive ?? isProcessAlive;
    type StdinLike = NodeJS.EventEmitter & { resume?: () => unknown; pause?: () => unknown; unref?: () => unknown };
    const stdin = (options.stdin === undefined ? process.stdin : options.stdin) as unknown as StdinLike | null;
    const ipc = options.ipc === undefined ? (typeof process.send === 'function' ? process : null) : options.ipc;
    const pollIntervalMs = options.pollIntervalMs ?? 2000;
    let fired = false;
    let timer: NodeJS.Timeout | null = null;

    const cleanups: Array<() => void> = [];
    const stop = () => {
        if (timer) clearInterval(timer);
        timer = null;
        for (const cleanup of cleanups.splice(0)) {
            try { cleanup(); } catch { /* ignore */ }
        }
    };
    const fire = (reason: string) => {
        if (fired) return;
        fired = true;
        stop();
        options.onParentGone(reason);
    };

    if (stdin) {
        const onEnd = () => fire('stdin 已关闭');
        const onError = () => fire('stdin 出错');
        stdin.on('end', onEnd);
        stdin.on('close', onEnd);
        stdin.on('error', onError);
        // 只有处于流动状态才会收到 'end'。主进程不会往 stdin 写数据，读到的内容直接丢弃。
        const onData = () => { /* discard */ };
        stdin.on('data', onData);
        stdin.resume?.();
        cleanups.push(() => {
            stdin.removeListener('end', onEnd);
            stdin.removeListener('close', onEnd);
            stdin.removeListener('error', onError);
            stdin.removeListener('data', onData);
            stdin.pause?.();
            // 不再持有事件循环
            stdin.unref?.();
        });
        // stdin 是管道句柄时会让事件循环一直存活；后端本来就是常驻服务，这里不额外 unref。
    }

    if (ipc) {
        const onDisconnect = () => fire('IPC 通道已断开');
        ipc.on('disconnect', onDisconnect);
        cleanups.push(() => ipc.removeListener('disconnect', onDisconnect));
    }

    if (pollIntervalMs > 0) {
        timer = setInterval(() => {
            if (!alive(options.parentPid)) fire(`父进程 ${options.parentPid} 已不存在`);
        }, pollIntervalMs);
        timer.unref?.();
    }

    return stop;
}

/** server.listen 失败时的退出码：端口被占用。Electron 主进程据此换端口重试。 */
export const EXIT_CODE_ADDRESS_IN_USE = 98;

export const describeListenError = (error: NodeJS.ErrnoException, port: string | number, host?: string): string => {
    const where = `${host || '0.0.0.0'}:${port}`;
    switch (error?.code) {
        case 'EADDRINUSE':
            return `端口 ${where} 已被占用，后端无法启动。可能是上次未正常退出的 Nexus Terminal 后端仍在运行，或其他程序占用了该端口。请结束占用该端口的进程，或通过 PORT 环境变量换一个端口。`;
        case 'EACCES':
            return `没有权限监听 ${where}（1024 以下端口通常需要管理员权限），请换一个端口。`;
        case 'EADDRNOTAVAIL':
            return `监听地址 ${where} 不可用，请检查 BIND_ADDRESS/HOST 设置。`;
        default:
            return `监听 ${where} 失败: ${error?.message || error}`;
    }
};
