import { EventEmitter } from 'events';

/**
 * ssh2 Client / 任意 EventEmitter 的「兜底 error 监听」。
 *
 * EventEmitter emit('error') 时没有任何监听器会直接抛出，变成 uncaughtException，
 * 后端整体退出（所有用户的 SSH/SFTP 会话一起断）。ssh2 在保活超时、ECONNRESET、
 * 协议解析异常时都会 emit 'error'，而业务代码在 ready 之后、各自挂监听之前，
 * 或者把会话交给挂起服务时，都可能出现「一个监听器都没有」的窗口。
 *
 * 这里给 client 挂一个只记日志的常驻监听，同一个对象只挂一次；业务方自己的监听照常生效。
 */
const FALLBACK_ERROR_LISTENER = Symbol.for('nexus.sshFallbackErrorListener');

export function attachFallbackErrorListener(emitter: EventEmitter, logPrefix = 'SshService:'): void {
    const anyEmitter = emitter as any;
    if (anyEmitter[FALLBACK_ERROR_LISTENER]) return;
    const listener = (err: Error) => {
        console.warn(`${logPrefix} SSH client error (fallback listener): ${(err as any)?.code || err?.message || err}`);
    };
    Object.defineProperty(anyEmitter, FALLBACK_ERROR_LISTENER, { value: listener, enumerable: false, configurable: true });
    emitter.on('error', listener);
}

export function isFallbackErrorListener(emitter: EventEmitter, listener: unknown): boolean {
    return (emitter as any)[FALLBACK_ERROR_LISTENER] === listener;
}

/**
 * 记录一组 on() 的监听器，之后一次性 off()；只移除自己挂的，不影响别人（兜底监听、
 * exec 通道限流器的 close/end 监听等）。
 */
export class ListenerGroup {
    private readonly entries: Array<[EventEmitter, string, (...args: any[]) => void]> = [];

    on(emitter: EventEmitter | undefined | null, event: string, listener: (...args: any[]) => void): this {
        if (!emitter) return this;
        emitter.on(event, listener);
        this.entries.push([emitter, event, listener]);
        return this;
    }

    removeAll(): void {
        for (const [emitter, event, listener] of this.entries.splice(0)) {
            try { emitter.removeListener(event, listener); } catch { /* ignore */ }
        }
    }

    get size(): number {
        return this.entries.length;
    }
}
