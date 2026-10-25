/**
 * 端口转发的运行时：本地 -L、动态 SOCKS5 -D、远程 -R。
 *
 * 每条连接自己带一个「专用」的 SSH 客户端（不跟终端会话共用），
 * 这样不开终端也能跑转发，终端断线重连也不会把转发一起带走。
 * 同一条连接下的多条规则共用同一个 SSH 客户端。
 *
 * 只在桌面端（Electron，后端跑在用户本机）开放，路由层已做拦截。
 */
import net from 'net';
import { Client, ClientChannel } from 'ssh2';
import { establishSshConnection, getConnectionDetails } from '../services/ssh.service';
import { PortForwardRule } from './port-forward.repository';

const CONNECT_TIMEOUT_MS = 20000;
const RESTART_DELAY_MS = 5000;
const MAX_RESTART_ATTEMPTS = 3;
/** SOCKS 握手阶段最多缓冲这么多字节，防止畸形客户端无限喂数据 */
const SOCKS_HANDSHAKE_MAX_BYTES = 1024;

interface RunningRule {
    rule: PortForwardRule;
    server?: net.Server;
    /** 远程转发登记成功后的实际端口（bind_port=0 时由服务器分配） */
    remotePort?: number;
    remoteHost?: string;
    connCount: number;
    sockets: Set<net.Socket>;
    startedAt: number;
    error?: string;
    /** 用户主动停掉的，不参与自动恢复 */
    manualStop?: boolean;
    /** 已成功监听/登记；断线时置 false，靠 error 标记 */
    started?: boolean;
    restartAttempts: number;
    restartTimer?: NodeJS.Timeout;
}

export interface ForwardStatus {
    ruleId: number;
    running: boolean;
    error?: string;
    startedAt?: number;
    connCount?: number;
    /** 远程转发实际在服务器上登记的端口 */
    remotePort?: number;
    /** 断线后正在等待自动重连 */
    reconnecting?: boolean;
}

const clients = new Map<number, Client>();
/** 正在建立中的连接：并发启动同一连接下的多条规则时只建一个客户端 */
const pendingClients = new Map<number, Promise<Client>>();
const running = new Map<number, RunningRule>();
/** 启动失败（未在 running 里）的规则，记住最后一次错误给前端看 */
const lastErrors = new Map<number, string>();

const statusOf = (rule: PortForwardRule): ForwardStatus => {
    const rt = running.get(rule.id);
    if (!rt) {
        const error = lastErrors.get(rule.id);
        return error ? { ruleId: rule.id, running: false, error } : { ruleId: rule.id, running: false };
    }
    return {
        ruleId: rule.id,
        running: rt.started === true,
        error: rt.error,
        startedAt: rt.startedAt,
        connCount: rt.connCount,
        remotePort: rt.remotePort,
        reconnecting: !rt.started && !!rt.restartTimer,
    };
};

const closeQuietly = (sock: net.Socket | undefined) => {
    try { sock?.destroy(); } catch { /* ignore */ }
};

const closeChannelQuietly = (stream: ClientChannel | undefined) => {
    try { stream?.close(); } catch { /* ignore */ }
};

/** 把一条本地 socket 和一条 SSH 通道双向接起来，任一端结束都把另一端收掉 */
const bridge = (rt: RunningRule, socket: net.Socket, stream: ClientChannel) => {
    rt.connCount += 1;
    rt.sockets.add(socket);
    socket.pipe(stream).pipe(socket);
    const cleanup = () => {
        rt.sockets.delete(socket);
        closeQuietly(socket);
        closeChannelQuietly(stream);
    };
    socket.on('error', cleanup);
    socket.on('close', cleanup);
    stream.on('error', cleanup);
    stream.on('close', cleanup);
};

/** 拿到（或新建）某条连接专用的 SSH 客户端 */
const ensureClient = async (connectionId: number): Promise<Client> => {
    const existing = clients.get(connectionId);
    if (existing) return existing;
    const pending = pendingClients.get(connectionId);
    if (pending) return pending;

    const promise = (async () => {
        const details = await getConnectionDetails(connectionId);
        const client = await establishSshConnection(details, CONNECT_TIMEOUT_MS);

        client.on('error', (err: Error) => {
            console.warn(`[PortForward] 连接 ${connectionId} 出错:`, err.message);
            handleClientLost(connectionId, client, err.message);
        });
        client.on('close', () => {
            handleClientLost(connectionId, client, 'SSH 连接已断开');
        });
        // 远程转发的入站统一在这里分发（一个客户端可能挂了多条 -R），只挂一次
        client.on('tcp connection', (info, accept, reject) => {
            const candidate = [...running.values()].find(r =>
                r.rule.connection_id === connectionId && r.rule.type === 'remote' && r.started && r.remotePort === info.destPort
            );
            if (!candidate || !candidate.rule.target_host || !candidate.rule.target_port) {
                reject();
                return;
            }
            const stream = accept();
            const target = net.connect(candidate.rule.target_port, candidate.rule.target_host);
            bridge(candidate, target, stream);
        });

        clients.set(connectionId, client);
        return client;
    })();
    pendingClients.set(connectionId, promise);
    try {
        return await promise;
    } finally {
        pendingClients.delete(connectionId);
    }
};

/** 连接断了：把这条连接下所有规则标失败，必要时按 auto_start 重试 */
const handleClientLost = (connectionId: number, client: Client, message: string) => {
    // ssh2 的 error 和 close 会连着来；主动 end() 的客户端已从表里移除，也不处理
    if (clients.get(connectionId) !== client) return;
    clients.delete(connectionId);
    for (const [ruleId, rt] of running.entries()) {
        if (rt.rule.connection_id !== connectionId) continue;
        rt.started = false;
        rt.error = message;
        rt.server?.close();
        rt.server = undefined;
        rt.remotePort = undefined;
        rt.sockets.forEach(closeQuietly);
        rt.sockets.clear();
        if (rt.restartTimer) continue;
        if (!rt.manualStop && rt.rule.auto_start && rt.restartAttempts < MAX_RESTART_ATTEMPTS) {
            rt.restartAttempts += 1;
            rt.restartTimer = setTimeout(() => {
                rt.restartTimer = undefined;
                if (running.get(ruleId) !== rt || rt.manualStop) return;
                startRule(rt.rule).catch(err => {
                    console.warn(`[PortForward] 规则 ${ruleId} 自动恢复失败:`, err.message);
                });
            }, RESTART_DELAY_MS);
            rt.restartTimer.unref?.();
        } else {
            running.delete(ruleId);
            lastErrors.set(ruleId, message);
        }
    }
};

const listen = (server: net.Server, rule: PortForwardRule): Promise<void> => {
    return new Promise((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server.once('error', onError);
        server.listen(rule.bind_port, rule.bind_host || '127.0.0.1', () => {
            server.removeListener('error', onError);
            server.on('error', err => {
                const rt = running.get(rule.id);
                if (rt) rt.error = err.message;
            });
            resolve();
        });
    });
};

/** 本地监听：每条进来的 TCP 都开一条 direct-tcpip 通道 */
const startLocal = async (rule: PortForwardRule, client: Client, rt: RunningRule): Promise<void> => {
    const server = net.createServer(socket => {
        // 通道打开前客户端可能已经发了数据：先暂停，pipe 时会自动恢复
        socket.pause();
        socket.on('error', () => closeQuietly(socket));
        client.forwardOut(socket.remoteAddress || '127.0.0.1', socket.remotePort ?? 0, rule.target_host as string, rule.target_port as number, (err, stream) => {
            if (err) {
                closeQuietly(socket);
                return;
            }
            bridge(rt, socket, stream);
        });
    });
    await listen(server, rule);
    rt.server = server;
};

/**
 * 解析 SOCKS5 请求（RFC 1928，只支持 CONNECT、无认证）。
 * 返回 null 表示数据还不够；返回 { error } 表示要用该应答码拒绝。
 */
export const parseSocks5Request = (buffer: Buffer): { host: string; port: number; consumed: number } | { error: number } | null => {
    if (buffer.length < 5) return null;
    if (buffer[0] !== 0x05) return { error: 0x01 };
    if (buffer[1] !== 0x01) return { error: 0x07 }; // 只支持 CONNECT
    const atyp = buffer[3];
    if (atyp === 0x01) {
        if (buffer.length < 10) return null;
        return { host: `${buffer[4]}.${buffer[5]}.${buffer[6]}.${buffer[7]}`, port: buffer.readUInt16BE(8), consumed: 10 };
    }
    if (atyp === 0x03) {
        const len = buffer[4];
        if (len === 0) return { error: 0x01 };
        if (buffer.length < 5 + len + 2) return null;
        return { host: buffer.subarray(5, 5 + len).toString('utf8'), port: buffer.readUInt16BE(5 + len), consumed: 5 + len + 2 };
    }
    if (atyp === 0x04) {
        if (buffer.length < 22) return null;
        const parts: string[] = [];
        for (let i = 0; i < 16; i += 2) parts.push(buffer.readUInt16BE(4 + i).toString(16));
        return { host: parts.join(':'), port: buffer.readUInt16BE(20), consumed: 22 };
    }
    return { error: 0x08 };
};

/** 动态转发：本地起一个 SOCKS5（只支持 CONNECT，无认证） */
const startDynamic = async (rule: PortForwardRule, client: Client, rt: RunningRule): Promise<void> => {
    const server = net.createServer(socket => {
        let buffer = Buffer.alloc(0);
        let stage: 'greeting' | 'request' = 'greeting';

        const fail = (code = 0x01) => {
            try { socket.end(Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); } catch { /* ignore */ }
            setTimeout(() => closeQuietly(socket), 200).unref?.();
        };

        socket.on('error', () => closeQuietly(socket));

        const onData = (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length > SOCKS_HANDSHAKE_MAX_BYTES) {
                socket.removeListener('data', onData);
                closeQuietly(socket);
                return;
            }
            if (stage === 'greeting') {
                if (buffer.length < 2) return;
                if (buffer[0] !== 0x05) {
                    socket.removeListener('data', onData);
                    closeQuietly(socket);
                    return;
                }
                const nMethods = buffer[1];
                if (buffer.length < 2 + nMethods) return;
                const methods = buffer.subarray(2, 2 + nMethods);
                buffer = buffer.subarray(2 + nMethods);
                if (!methods.includes(0x00)) {
                    socket.removeListener('data', onData);
                    try { socket.end(Buffer.from([0x05, 0xff])); } catch { /* ignore */ }
                    return;
                }
                stage = 'request';
                socket.write(Buffer.from([0x05, 0x00])); // 无认证
                if (buffer.length === 0) return;
            }

            const parsed = parseSocks5Request(buffer);
            if (!parsed) return;
            // 握手结束：不再自己读数据，剩余数据交给 pipe（暂停期间到达的会留在 socket 缓冲里）
            socket.removeListener('data', onData);
            socket.pause();
            if ('error' in parsed) {
                fail(parsed.error);
                return;
            }
            const rest = buffer.subarray(parsed.consumed);
            buffer = Buffer.alloc(0);
            client.forwardOut(socket.remoteAddress || '127.0.0.1', socket.remotePort ?? 0, parsed.host, parsed.port, (err, stream) => {
                if (err) { fail(0x05); return; }
                socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                if (rest.length > 0) stream.write(rest);
                bridge(rt, socket, stream);
            });
        };
        socket.on('data', onData);
    });
    await listen(server, rule);
    rt.server = server;
};

/** 远程转发：在服务器上开端口，流量回送到本机目标 */
const startRemote = async (rule: PortForwardRule, client: Client, rt: RunningRule): Promise<void> => {
    const bindHost = rule.bind_host || '127.0.0.1';
    const port = await new Promise<number>((resolve, reject) => {
        client.forwardIn(bindHost, rule.bind_port, (err, boundPort) => {
            if (err) reject(err); else resolve(boundPort || rule.bind_port);
        });
    });
    rt.remoteHost = bindHost;
    rt.remotePort = port;
};

/** 这条连接已经没有任何规则在跑（或在等重启）了，就把专用连接关掉 */
const releaseClientIfIdle = (connectionId: number) => {
    const stillUsed = [...running.values()].some(r => r.rule.connection_id === connectionId);
    if (stillUsed) return;
    const c = clients.get(connectionId);
    clients.delete(connectionId);
    try { c?.end(); } catch { /* ignore */ }
};

/** 启动一条规则；已启动则直接返回 */
export const startRule = async (rule: PortForwardRule): Promise<ForwardStatus> => {
    const existing = running.get(rule.id);
    // 远程转发没有本地 server，只认 started 标记，否则重复调用会重复 forwardIn
    if (existing?.started) return statusOf(rule);
    if (existing?.restartTimer) {
        clearTimeout(existing.restartTimer);
        existing.restartTimer = undefined;
    }

    const rt: RunningRule = existing ?? {
        rule,
        connCount: 0,
        sockets: new Set(),
        startedAt: Date.now(),
        restartAttempts: 0,
    };
    rt.rule = rule;
    rt.error = undefined;
    rt.started = false;
    rt.manualStop = false;
    running.set(rule.id, rt);
    lastErrors.delete(rule.id);

    try {
        const client = await ensureClient(rule.connection_id);
        // 等连接期间被 stop 掉了
        if (running.get(rule.id) !== rt) throw new Error('规则已停止');
        if (rule.type === 'local') {
            if (!rule.target_host || !rule.target_port) throw new Error('本地转发缺少目标地址');
            await startLocal(rule, client, rt);
        } else if (rule.type === 'dynamic') {
            await startDynamic(rule, client, rt);
        } else {
            if (!rule.target_host || !rule.target_port) throw new Error('远程转发缺少目标地址');
            await startRemote(rule, client, rt);
        }
        rt.started = true;
        rt.startedAt = Date.now();
        rt.restartAttempts = 0;
    } catch (err: any) {
        const message = err?.message || String(err);
        if (running.get(rule.id) === rt) {
            running.delete(rule.id);
            lastErrors.set(rule.id, message);
        }
        rt.server?.close();
        rt.server = undefined;
        releaseClientIfIdle(rule.connection_id);
        throw err;
    }

    return statusOf(rule);
};

export const stopRule = async (ruleId: number, manual = true): Promise<void> => {
    const rt = running.get(ruleId);
    if (!rt) return;
    if (manual) rt.manualStop = true;
    if (rt.restartTimer) clearTimeout(rt.restartTimer);
    rt.restartTimer = undefined;
    running.delete(ruleId);

    rt.server?.close();
    rt.server = undefined;
    rt.sockets.forEach(closeQuietly);
    rt.sockets.clear();

    const client = clients.get(rt.rule.connection_id);
    if (rt.rule.type === 'remote' && client && rt.remotePort) {
        await new Promise<void>(resolve => {
            try {
                client.unforwardIn(rt.remoteHost || '127.0.0.1', rt.remotePort!, () => resolve());
            } catch {
                resolve();
            }
        });
        rt.remotePort = undefined;
    }

    releaseClientIfIdle(rt.rule.connection_id);
};

export const clearLastError = (ruleId: number): void => {
    lastErrors.delete(ruleId);
};

export const getStatuses = (rules: PortForwardRule[]): ForwardStatus[] => rules.map(statusOf);

/** 后端启动时把 auto_start 的规则拉起来（桌面端才需要） */
export const restoreAutoStart = async (rules: PortForwardRule[]): Promise<void> => {
    for (const rule of rules) {
        try {
            await startRule(rule);
            console.log(`[PortForward] 已恢复规则 #${rule.id} (${rule.type} ${rule.bind_port})`);
        } catch (err: any) {
            console.warn(`[PortForward] 恢复规则 #${rule.id} 失败:`, err.message);
        }
    }
};

/** 连接被删除时，先停掉内存里的规则 */
export const stopAllForConnection = async (connectionId: number): Promise<void> => {
    for (const [ruleId, rt] of [...running.entries()]) {
        if (rt.rule.connection_id === connectionId) {
            await stopRule(ruleId, true);
            lastErrors.delete(ruleId);
        }
    }
    const c = clients.get(connectionId);
    clients.delete(connectionId);
    try { c?.end(); } catch { /* ignore */ }
};

/** 进程退出 / 测试收尾：全部停掉 */
export const stopAll = async (): Promise<void> => {
    for (const ruleId of [...running.keys()]) {
        await stopRule(ruleId, true);
    }
    for (const [id, c] of [...clients.entries()]) {
        clients.delete(id);
        try { c.end(); } catch { /* ignore */ }
    }
    lastErrors.clear();
};
