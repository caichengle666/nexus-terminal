import WebSocket from 'ws';

/**
 * WebSocket 发送背压控制
 *
 * SSH Shell 输出直接 ws.send() 时，如果浏览器标签页停止读取（卡死、后台节流、网络拥塞），
 * ws.bufferedAmount 会无限增长，最终耗尽服务端内存（例如 `yes` 或 `cat` 大文件）。
 *
 * 这里在发送后检查 bufferedAmount：超过高水位就暂停 SSH 流（ssh2 会停止补充窗口，
 * 远端因此被流控），然后轮询直到缓冲降到低水位以下再恢复。
 */
const parsePositiveInt = (value: string | undefined, fallback: number): number => {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const WS_BACKPRESSURE_HIGH_WATER_BYTES = parsePositiveInt(process.env.WS_BACKPRESSURE_HIGH_WATER_BYTES, 1024 * 1024);
export const WS_BACKPRESSURE_LOW_WATER_BYTES = Math.min(
    parsePositiveInt(process.env.WS_BACKPRESSURE_LOW_WATER_BYTES, 256 * 1024),
    WS_BACKPRESSURE_HIGH_WATER_BYTES
);
const DRAIN_POLL_INTERVAL_MS = 50;

export interface PausableStream {
    pause(): unknown;
    resume(): unknown;
    isPaused?(): boolean;
}

type BackpressureTarget = PausableStream & { __wsBackpressureTimer?: NodeJS.Timeout };

/**
 * 发送后调用：如果 WebSocket 发送缓冲超过高水位，暂停 stream，并在缓冲排空（或连接关闭）后恢复。
 * getWs 每次轮询都会重新取当前 WebSocket，这样会话被重连接管后，背压跟随新的连接。
 * 连接不再处于 OPEN 状态时会立即恢复 stream，交由分离缓冲 / 清理逻辑处理输出。
 */
export function applyWsBackpressure(
    getWs: () => WebSocket | undefined,
    stream: PausableStream | undefined,
    highWater: number = WS_BACKPRESSURE_HIGH_WATER_BYTES,
    lowWater: number = WS_BACKPRESSURE_LOW_WATER_BYTES
): boolean {
    if (!stream) return false;
    const target = stream as BackpressureTarget;
    if (target.__wsBackpressureTimer) return true; // 已在等待排空
    const ws = getWs();
    if (!ws || ws.readyState !== WebSocket.OPEN || (ws.bufferedAmount ?? 0) <= highWater) return false;

    try { target.pause(); } catch { return false; }
    const timer = setInterval(() => {
        const current = getWs();
        const drained = !current
            || current.readyState !== WebSocket.OPEN
            || (current.bufferedAmount ?? 0) <= lowWater;
        if (!drained) return;
        clearInterval(timer);
        target.__wsBackpressureTimer = undefined;
        try { target.resume(); } catch { /* stream 可能已关闭 */ }
    }, DRAIN_POLL_INTERVAL_MS);
    // 不要因为轮询定时器阻止进程退出
    if (typeof timer.unref === 'function') timer.unref();
    target.__wsBackpressureTimer = timer;
    return true;
}

/** 清理挂起的背压轮询（stream 关闭时调用，可选） */
export function clearWsBackpressure(stream: PausableStream | undefined): void {
    const target = stream as BackpressureTarget | undefined;
    if (target?.__wsBackpressureTimer) {
        clearInterval(target.__wsBackpressureTimer);
        target.__wsBackpressureTimer = undefined;
    }
}
