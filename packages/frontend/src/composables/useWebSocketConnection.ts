import { ref, shallowRef, computed, readonly } from 'vue';
import { useI18n } from 'vue-i18n'; // +++ Add import for useI18n +++
// 从 websocket.types.ts 导入并重新导出 ConnectionStatus
import type { ConnectionStatus as WsConnectionStatusType, MessagePayload, WebSocketMessage, MessageHandler } from '../types/websocket.types';

// 导出类型别名，以便其他模块可以使用
export type WsConnectionStatus = WsConnectionStatusType;

/**
 * 创建并管理单个 WebSocket 连接实例。
 * 每个实例对应一个会话 (Session)。
 *
 * @param {string} sessionId - 此 WebSocket 连接关联的会话 ID (用于日志记录)。
 * @param {string} dbConnectionId - 此 WebSocket 连接关联的数据库连接 ID (用于后端识别)。
 * @param {Function} t - i18n 翻译函数，从父组件传入
 * @param {object} [options] - 可选参数对象
 * @param {boolean} [options.isResumeFlow=false] - 指示此连接是否用于 SSH 恢复流程
 * @returns 一个包含状态和方法的 WebSocket 连接管理器对象。
 */
export function createWebSocketConnectionManager(
    sessionId: string,
    dbConnectionId: string,
    t: ReturnType<typeof useI18n>['t'],
    options?: {
        isResumeFlow?: boolean;
        getIsMarkedForSuspend?: () => boolean;
        /**
         * 检查登录态：返回 false 表示已确认未登录（401），null/true 表示未知或仍已登录。
         * 默认请求 GET /api/v1/auth/status；测试可注入。
         */
        probeAuth?: () => Promise<boolean | null>;
    }
) {
    // --- Instance State ---
    // 每个实例拥有独立的 WebSocket 对象、状态和消息处理器
    const ws = shallowRef<WebSocket | null>(null); // WebSocket 实例
    const isResumeFlow = options?.isResumeFlow ?? false; // 获取恢复流程标志
    const connectionStatus = ref<WsConnectionStatus>('disconnected'); // 连接状态 (使用导出的类型)
    const statusMessage = ref<string>(''); // 状态描述文本
    const isSftpReady = ref<boolean>(false); // SFTP 是否就绪
    const messageHandlers = new Map<string, Set<MessageHandler>>(); // 此实例的消息处理器注册表
    const instanceSessionId = sessionId; // 保存会话 ID 用于日志
    const instanceDbConnectionId = dbConnectionId; // 保存数据库连接 ID
    const getIsMarkedForSuspend = options?.getIsMarkedForSuspend; // +++ 获取回调函数 +++
    let reconnectAttempts = 0; // 本轮断线的重连次数（只决定退避时长）
    /**
     * 重连等待：500ms 起步、指数翻倍、封顶 5s（0.5/1/2/4/5/5…）。
     *
     * ws 断开绝大多数是网络抖动（切 WiFi、休眠唤醒、代理抽风），几秒内就恢复；
     * 后端在 WS_RESUME_GRACE_SECONDS（默认 180 秒）内保留 SSH 会话，重连越快越能接回原 shell。
     * 网络层失败（ws 根本没打开 / 已连上后掉线）不设次数上限，永不放弃。
     */
    const RECONNECT_BASE_DELAY_MS = 500;
    const RECONNECT_MAX_DELAY_MS = 5000;
    /** 强制立即重试的最小间隔：狂敲键盘时不要每个键都重建一条 ws */
    const FORCED_RETRY_MIN_GAP_MS = 1200;
    let lastForcedRetryAt = 0;
    /**
     * SSH 层失败上限：ws 已打开、但在 ssh:connected 之前就被关闭（非 1008）——说明网络是通的，
     * 是 SSH 目标连不上 / 握手失败。这类失败连续达到上限就停止自动重连，避免无限循环
     * （v0.9.22.49 无限重连修复的语义保持不变；1008 / 主机密钥不匹配仍然立即停止）。
     */
    const maxSshFailureAttempts = 8;
    let sshFailureAttempts = 0;
    /**
     * ws 连续握手失败（从未 open）的次数。浏览器无法区分「断网」与「登录已失效（升级被 401 拒绝）」，
     * 所以每连续失败 AUTH_PROBE_EVERY 次查一次登录态：确认 401 就停止自动重连，而不是永远空转。
     */
    const AUTH_PROBE_EVERY = 4;
    let preOpenFailures = 0;
    let authProbeInFlight = false;
    let reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null; // 重连定时器 ID
    let lastUrl = ''; // 保存上次连接的 URL
    let intentionalDisconnect = false; // 标记是否为用户主动断开
    let reconnectInProgress = false;
    let sftpReconnectRequested = false;
    let sftpFullReconnectAttempts = 0;
    const maxSftpFullReconnectAttempts = 2;
    let sftpStableResetTimeoutId: ReturnType<typeof setTimeout> | null = null;

    const clearSftpStableReset = () => {
        if (sftpStableResetTimeoutId) clearTimeout(sftpStableResetTimeoutId);
        sftpStableResetTimeoutId = null;
    };


    /**
     * 安全地获取状态文本的辅助函数
     * @param {string} statusKey - i18n 键名 (例如 'connectingWs')
     * @param {Record<string, unknown>} [params] - i18n 插值参数
     * @returns {string} 翻译后的文本或键名本身 (如果翻译失败)
     */
    const getStatusText = (statusKey: string, params?: Record<string, unknown>): string => {
        try {
            const translated = t(`workspace.status.${statusKey}`, params || {});
            return translated === `workspace.status.${statusKey}` ? statusKey : translated;
        } catch (e) {
            console.warn(`[WebSocket ${instanceSessionId}] i18n 错误 (键: workspace.status.${statusKey}):`, e);
            return statusKey;
        }
    };

    /**
     * 将收到的消息分发给已注册的处理器
     * @param {string} type - 消息类型
     * @param {MessagePayload} payload - 消息负载
     * @param {WebSocketMessage} fullMessage - 完整的消息对象
     */
    const dispatchMessage = (type: string, payload: MessagePayload, fullMessage: WebSocketMessage) => {
        if (messageHandlers.has(type)) {
            messageHandlers.get(type)?.forEach(handler => {
                try {
                    handler(payload, fullMessage);
                } catch (e) {
                    console.error(`[WebSocket ${instanceSessionId}] 消息处理器错误 (类型: "${type}"):`, e);
                }
            });
        }
    };

    const clearReconnectTimer = () => {
        if (reconnectTimeoutId) {
            clearTimeout(reconnectTimeoutId);
            reconnectTimeoutId = null;
        }
    };

    /**
     * 安排 WebSocket 重连尝试（指数退避，封顶 5s）
     */
    const scheduleReconnect = () => {
        if (intentionalDisconnect) {
            return; // 如果是主动断开，则不重连
        }

        // +++ 检查是否标记为待挂起 +++
        if (getIsMarkedForSuspend && getIsMarkedForSuspend()) {
            statusMessage.value = getStatusText('markedForSuspendNoReconnect'); // 可以为此添加新的i18n文本
            connectionStatus.value = 'disconnected'; // 保持断开状态或设为特定状态
            return;
        }

        // 允许最多 maxSshFailureAttempts 次重试，第 maxSshFailureAttempts+1 次失败后放弃
        if (sshFailureAttempts > maxSshFailureAttempts) {
            clearReconnectTimer();
            reconnectInProgress = false;
            statusMessage.value = getStatusText('reconnectFailed');
            connectionStatus.value = 'error'; // 标记为错误状态
            // 通知终端层：自动重连已放弃，需要用户手动 (Enter) 重连
            dispatchMessage('internal:reconnect-status', { phase: 'exhausted', max: maxSshFailureAttempts }, { type: 'internal:reconnect-status' });
            return;
        }

        // 已经排了一次就不再重排：否则一次断连可能把退避推两格，越抖越慢
        if (reconnectTimeoutId) {
            return;
        }

        reconnectAttempts++;
        const delay = Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempts - 1), RECONNECT_MAX_DELAY_MS);
        // 0.5 / 1 / 2 / 4 / 5 …；整数秒不显示成 "5.0"
        const delaySeconds = delay % 1000 === 0 ? delay / 1000 : Number((delay / 1000).toFixed(1));
        statusMessage.value = getStatusText('reconnecting', { attempt: reconnectAttempts, delay: delaySeconds });
        connectionStatus.value = 'connecting'; // 更新状态为正在连接
        dispatchMessage(
            'internal:reconnect-status',
            { phase: 'auto-retry', attempt: reconnectAttempts, delay: delaySeconds },
            { type: 'internal:reconnect-status' }
        );

        reconnectTimeoutId = setTimeout(() => {
            reconnectTimeoutId = null;
            if (!intentionalDisconnect && lastUrl) { // 再次检查是否主动断开
                connect(lastUrl);
            }
        }, delay);
    };

    const defaultProbeAuth = async (): Promise<boolean | null> => {
        if (typeof fetch !== 'function') return null;
        try {
            const res = await fetch('/api/v1/auth/status', { credentials: 'same-origin', cache: 'no-store' });
            if (res.status === 401) return false;
            return res.ok ? true : null;
        } catch {
            return null; // 网络仍不通：未知，继续重试
        }
    };
    const probeAuth = options?.probeAuth ?? defaultProbeAuth;

    /** 连续握手失败时查一次登录态；确认已退出登录就停止自动重连（等用户重新登录后按 Enter） */
    const maybeProbeAuth = () => {
        if (authProbeInFlight || preOpenFailures === 0 || preOpenFailures % AUTH_PROBE_EVERY !== 0) return;
        authProbeInFlight = true;
        void probeAuth().then(authenticated => {
            authProbeInFlight = false;
            if (authenticated !== false) return;
            // 期间已经连上、被主动断开或已切到别的停止状态：不处理
            if (intentionalDisconnect || connectionStatus.value === 'connected' || !reconnectTimeoutId) return;
            clearReconnectTimer();
            reconnectAttempts = 0;
            preOpenFailures = 0;
            reconnectInProgress = false;
            connectionStatus.value = 'error';
            statusMessage.value = getStatusText('error', { message: 'Unauthorized' });
            console.warn(`[WebSocket ${instanceSessionId}] 登录态已失效 (401)，停止自动重连。`);
            dispatchMessage('internal:reconnect-status', { phase: 'stopped', reason: 'auth' }, { type: 'internal:reconnect-status' });
        }, () => { authProbeInFlight = false; });
    };

    /**
     * 跳过退避等待立即重连。只在「正在等待自动重连」时生效：
     * 已停止自动重连（1008、主机密钥不匹配、SSH 失败达到上限、登录失效）的会话必须由用户按 Enter 手动重连，
     * 不能被键盘输入 / 网络恢复事件悄悄重新拉起，否则又会变成无限重连。
     *
     * 触发源：系统 online 事件、页面重新可见、断线期间用户在终端里敲键。
     * @returns 是否真的发起了一次重连
     */
    const retryNow = (reason: string): boolean => {
        if (intentionalDisconnect || !lastUrl || !reconnectTimeoutId) return false;
        if (connectionStatus.value === 'connected') return false;
        if (ws.value && (ws.value.readyState === WebSocket.OPEN || ws.value.readyState === WebSocket.CONNECTING)) return false;
        const now = Date.now();
        if (now - lastForcedRetryAt < FORCED_RETRY_MIN_GAP_MS) return false;
        lastForcedRetryAt = now;
        clearReconnectTimer();
        console.log(`[WebSocket ${instanceSessionId}] 立即重连（触发：${reason}）`);
        connect(lastUrl);
        return true;
    };

    // --- 浏览器层面的「网络可能恢复了」信号 ---
    const onBrowserOnline = () => { retryNow('online'); };
    const onVisibilityChange = () => {
        // 锁屏 / 切后台 / 合盖回来时定时器可能被节流，回到前台立即补一次
        if (typeof document !== 'undefined' && document.visibilityState === 'visible') retryNow('visibilitychange');
    };
    const canListen = typeof window !== 'undefined' && typeof window.addEventListener === 'function'
        && typeof document !== 'undefined' && typeof document.addEventListener === 'function';
    if (canListen) {
        window.addEventListener('online', onBrowserOnline);
        document.addEventListener('visibilitychange', onVisibilityChange);
    }

    /** 会话关闭时调用：摘掉全局监听器与定时器，避免开关连接后不断累积 */
    const dispose = () => {
        if (canListen) {
            window.removeEventListener('online', onBrowserOnline);
            document.removeEventListener('visibilitychange', onVisibilityChange);
        }
        clearReconnectTimer();
        clearSftpStableReset();
    };

    /**
     * 移除旧 socket 上的所有事件处理器，防止被替换掉的 (半开) socket 之后触发
     * onopen (在新 socket 上重复发送 ssh:connect) 或 onclose (清空正在使用的 ws.value 并安排重连)。
     */
    const detachSocket = (socket: WebSocket) => {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
    };

    /** 移除处理器后关闭一个被替换掉的 socket (CONNECTING 状态也可安全关闭)。 */
    const discardSocket = (socket: WebSocket, reason: string) => {
        detachSocket(socket);
        try {
            if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
                socket.close(1000, reason);
            }
        } catch (e) {
            console.warn(`[WebSocket ${instanceSessionId}] 关闭旧连接失败:`, e);
        }
    };

    /**
     * 建立 WebSocket 连接
     * @param {string} url - WebSocket 服务器 URL
     */
    const connect = (url: string) => {
        lastUrl = url; // 保存 URL 以便重连
        intentionalDisconnect = false; // 重置主动断开标记
        if (reconnectTimeoutId) {
            clearTimeout(reconnectTimeoutId); // 清除可能存在的重连定时器
            reconnectTimeoutId = null;
        }

        // --- 修改后的检查逻辑 ---
        // 只有当 ws 实例存在，且其状态为 OPEN 或 CONNECTING，
        // 并且我们自己维护的状态也是 connected 或 connecting 时，才阻止连接。
        if (ws.value &&
            (ws.value.readyState === WebSocket.OPEN || ws.value.readyState === WebSocket.CONNECTING) &&
            (connectionStatus.value === 'connected' || connectionStatus.value === 'connecting')
           ) {
            console.warn(`[WebSocket ${instanceSessionId}] 连接已打开或正在连接中 (readyState: ${ws.value.readyState}, status: ${connectionStatus.value})。 阻止重复连接。`);
            return;
        }

        // 处理状态不一致或旧连接未完全关闭的情况
        if (ws.value && (ws.value.readyState === WebSocket.OPEN || ws.value.readyState === WebSocket.CONNECTING)) {
             // readyState 是 OPEN/CONNECTING 但 connectionStatus 是 disconnected/error
             console.warn(`[WebSocket ${instanceSessionId}] 检测到状态不一致 (readyState: ${ws.value.readyState}, status: ${connectionStatus.value})。尝试关闭旧连接并继续...`);
             // 临时标记为主动断开，防止 onclose 触发 scheduleReconnect
             const oldWs = ws.value; // 保存旧 ws 引用
             const previousIntentionalDisconnect = intentionalDisconnect;
             intentionalDisconnect = true;
             // 在关闭前移除监听器，防止旧的 onclose 干扰
             if (oldWs) {
                 console.log(`[WebSocket ${instanceSessionId}] 移除旧连接的事件监听器...`);
                 oldWs.onopen = null;
                 oldWs.onmessage = null;
                 oldWs.onerror = null;
                 oldWs.onclose = null; // 阻止旧的 onclose 干扰
                 console.log(`[WebSocket ${instanceSessionId}] 关闭旧连接 (强制)...`);
                 oldWs.close(1000, '状态不一致，强制重连');
             }
             ws.value = null; // 清理 shallowRef 中的引用
             intentionalDisconnect = previousIntentionalDisconnect; // 恢复标记
             console.log(`[WebSocket ${instanceSessionId}] 旧连接处理完毕。`);
        } else if (ws.value && ws.value.readyState === WebSocket.CLOSING) {
             console.log(`[WebSocket ${instanceSessionId}] 检测到旧连接正在关闭 (readyState: ${ws.value.readyState})。清理引用并继续创建新连接...`);
             detachSocket(ws.value); // 其迟到的 onclose 不得影响新连接
             ws.value = null; // 清理引用，让后续逻辑创建新的
        }
        // 如果 ws.value 存在且 readyState 是 CLOSED，它应该已经在 onclose 中被设为 null

        statusMessage.value = getStatusText('connectingWs', { url });
        connectionStatus.value = 'connecting'; // 确保状态设置为 connecting
        isSftpReady.value = false; // 重置 SFTP 状态

        try {
            // --- 根据页面协议调整 WebSocket URL ---
            let secureUrl = url;
            if (window.location.protocol === 'https:') {
                secureUrl = url.replace(/^ws:/, 'wss:');
                console.log(`[WebSocket ${instanceSessionId}] HTTPS detected, upgrading WebSocket URL to: ${secureUrl}`);
            } else {
                 console.log(`[WebSocket ${instanceSessionId}] HTTP detected, using WebSocket URL: ${secureUrl}`);
            }
            // --- 使用调整后的 URL ---
            const socket = new WebSocket(secureUrl);
            ws.value = socket;
            let socketOpened = false; // 本 socket 是否成功打开过（区分网络层失败与 SSH 层失败）
            let sshConnectedOnSocket = false;
            // 每个处理器只对"当前" socket 生效：被替换掉的 socket 的事件一律忽略。
            const isCurrentSocket = () => ws.value === socket;

            socket.onopen = () => {
                if (!isCurrentSocket()) {
                    discardSocket(socket, '连接已被替换');
                    return;
                }
                socketOpened = true;
                preOpenFailures = 0;
                // 注意：WebSocket 打开不代表 SSH 已连上（SSH 握手/认证可能随后失败并关闭连接），
                // 重连计数只在收到 ssh:connected（或恢复流程打开）后才重置，否则会无限重试且计数一直停在 1。
                statusMessage.value = getStatusText('wsConnected');
                // 状态保持 'connecting' 直到收到 ssh:connected
                if (!isResumeFlow) {
                    // 对于普通连接，发送 ssh:connect 并等待 ssh:connected 来更新状态
                    sendMessage({
                        type: 'ssh:connect',
                        payload: {
                            connectionId: instanceDbConnectionId,
                            sessionId: instanceSessionId,
                        },
                    });
                } else {
                    // 对于恢复流程，WebSocket 打开即表示连接基础已建立
                    // 后续的 SSH_SUSPEND_RESUME_REQUEST 会完成会话的恢复
                    reconnectAttempts = 0;
                    connectionStatus.value = 'connected';
                }
                dispatchMessage('internal:opened', {}, { type: 'internal:opened' }); // 触发内部打开事件
            };

            socket.onmessage = (event: MessageEvent) => {
                if (!isCurrentSocket()) return;
                try {
                    const rawData = event.data;
                    const message: WebSocketMessage = JSON.parse(rawData.toString());

                    // --- 更新此实例的连接状态 ---
                    if (message.type === 'ssh:connected') {
                        sshConnectedOnSocket = true;
                        reconnectAttempts = 0; // SSH 真正连接成功，重置重连计数
                        sshFailureAttempts = 0;
                        sftpReconnectRequested = false;
                        if (connectionStatus.value !== 'connected') {
                            connectionStatus.value = 'connected';
                            statusMessage.value = getStatusText('connected');
                        }
                        if (reconnectInProgress) {
                            reconnectInProgress = false;
                            dispatchMessage('internal:reconnect-status', { phase: 'connected' }, { type: 'internal:reconnect-status' });
                        }
                    } else if (message.type === 'ssh:disconnected') {
                        if (connectionStatus.value !== 'disconnected') {
                            connectionStatus.value = 'disconnected';
                            statusMessage.value = getStatusText('disconnected', { reason: message.payload || t('uxTerminal.status.unknownReason') });
                            isSftpReady.value = false; // SSH 断开，SFTP 也应不可用
                        }
                    } else if (message.type === 'ssh:hostkey:mismatch') {
                        // 主机密钥不匹配：后端已拒绝连接。停止自动重连，避免反复连接可疑主机，
                        // 由会话层弹出确认对话框，用户确认信任新密钥后再手动重连。
                        intentionalDisconnect = true;
                        if (reconnectTimeoutId) {
                            clearTimeout(reconnectTimeoutId);
                            reconnectTimeoutId = null;
                        }
                        reconnectInProgress = false;
                        connectionStatus.value = 'error';
                        try {
                            statusMessage.value = t('hostKey.mismatchStatus');
                        } catch {
                            statusMessage.value = getStatusText('error', { message: 'Host key mismatch' });
                        }
                        isSftpReady.value = false;
                    } else if (message.type === 'ssh:error' || message.type === 'error') {
                        if (connectionStatus.value !== 'disconnected' && connectionStatus.value !== 'error') {
                            connectionStatus.value = 'error';
                            let errorMsg = message.payload || t('uxTerminal.unknownError');
                            if (typeof errorMsg === 'object' && errorMsg.message) errorMsg = errorMsg.message;
                            statusMessage.value = getStatusText('error', { message: errorMsg });
                            isSftpReady.value = false;
                        }
                    } else if (message.type === 'sftp_ready') {
                        console.log(`[WebSocket ${instanceSessionId}] SFTP 会话已就绪。`);
                        isSftpReady.value = true;
                        sftpReconnectRequested = false;
                        clearSftpStableReset();
                        sftpStableResetTimeoutId = setTimeout(() => {
                            sftpFullReconnectAttempts = 0;
                            sftpStableResetTimeoutId = null;
                        }, 120000);
                    } else if (message.type === 'sftp_unavailable'
                        || (message.type === 'sftp_error' && !message.payload?.requestId && !message.requestId)) {
                        // 只有通道级错误（无 requestId）才表示 SFTP 不可用；
                        // 带 requestId 的 sftp_error 只是单个操作失败，不能把整个文件管理器标记为未就绪。
                        isSftpReady.value = false;
                        clearSftpStableReset();
                    } else if (message.type === 'sftp_reconnect_required') {
                        isSftpReady.value = false;
                        clearSftpStableReset();
                        if (!intentionalDisconnect && !reconnectInProgress && !sftpReconnectRequested) {
                            const reason = typeof message.payload?.message === 'string' ? message.payload.message : t('uxTerminal.status.sftpHealthCheckFailed');
                            if (sftpFullReconnectAttempts >= maxSftpFullReconnectAttempts) {
                                connectionStatus.value = 'error';
                                statusMessage.value = reason;
                                console.error(`[WebSocket ${instanceSessionId}] SFTP 完整重连已达到上限，需要用户检查 VPS 的 SSH/SFTP 服务。`);
                                dispatchMessage('internal:reconnect-status', { phase: 'failed', message: reason }, { type: 'internal:reconnect-status' });
                            } else {
                                sftpFullReconnectAttempts += 1;
                                sftpReconnectRequested = true;
                                console.warn(`[WebSocket ${instanceSessionId}] ${reason}，正在执行完整连接恢复 (${sftpFullReconnectAttempts}/${maxSftpFullReconnectAttempts})。`);
                                setTimeout(() => {
                                    void reconnect(lastUrl).then(success => {
                                        if (!success) sftpReconnectRequested = false;
                                    });
                                }, 0);
                            }
                        }
                    }
                    // --- 状态更新结束 ---

                    // 分发消息给此实例的处理器
                    dispatchMessage(message.type, message.payload, message);

                } catch (e) {
                    console.error(`[WebSocket ${instanceSessionId}] 处理消息时出错:`, e, '原始数据:', event.data);
                    dispatchMessage('internal:raw', event.data, { type: 'internal:raw' });
                }
            };

            socket.onerror = (event) => {
                if (!isCurrentSocket()) return;
                // 即将自动重连时不把状态打成 error（状态灯不再 黄→红→黄 闪），由 onclose 统一调度
                if (intentionalDisconnect && connectionStatus.value !== 'disconnected' && connectionStatus.value !== 'error') {
                    connectionStatus.value = 'error';
                }
                statusMessage.value = getStatusText('wsError');
                dispatchMessage('internal:error', event, { type: 'internal:error' });
                isSftpReady.value = false;
                ws.value = null; // 清理实例 (之后的 onclose 仍视为当前 socket，见下)
                // 不在此处安排重连：浏览器在 error 之后总会触发 close (1006)，
                // 由 onclose 统一调度，避免每次失败重连计数 +2、提前放弃。
            };

            socket.onclose = (event) => {
                // ws.value 为 null 表示本 socket 已被 onerror / disconnect() 清理，但尚未被新 socket 替换；
                // 若 ws.value 已指向另一个 socket，则本事件来自过期连接，不得影响新连接的状态或安排重连。
                if (ws.value !== null && ws.value !== socket) return;
                // 只有在非错误、非断开、也不在重连排期中时才更新为 disconnected（保留「正在重连」状态，避免闪烁）
                if (connectionStatus.value !== 'error' && connectionStatus.value !== 'disconnected' && connectionStatus.value !== 'connecting') {
                    connectionStatus.value = 'disconnected';
                    // 如果不是主动断开，显示尝试重连的消息
                    if (!intentionalDisconnect && event.code !== 1000) { // 1000 is normal closure
                         statusMessage.value = getStatusText('wsClosedWillRetry', { code: event.code });
                    } else {
                         statusMessage.value = getStatusText('wsClosed', { code: event.code });
                    }
                }
                dispatchMessage('internal:closed', { code: event.code, reason: event.reason }, { type: 'internal:closed' });
                isSftpReady.value = false;
                ws.value = null; // 清理实例引用

                // 1008：后端判定重试无效（算法不匹配、认证失败、连接不存在等），停止自动重连，等用户按 Enter 手动重连
                if (!intentionalDisconnect && event.code === 1008) {
                    if (reconnectTimeoutId) {
                        clearTimeout(reconnectTimeoutId);
                        reconnectTimeoutId = null;
                    }
                    reconnectAttempts = 0;
                    sshFailureAttempts = 0;
                    preOpenFailures = 0;
                    reconnectInProgress = false;
                    connectionStatus.value = 'error';
                    dispatchMessage('internal:reconnect-status', { phase: 'stopped' }, { type: 'internal:reconnect-status' });
                    return;
                }

                // 如果不是主动断开 (code 1000)，尝试重连
                if (!intentionalDisconnect && event.code !== 1000) { // 1000 is normal closure
                    if (!socketOpened) {
                        preOpenFailures++; // 网络层失败：不计入 SSH 失败上限
                    } else if (!sshConnectedOnSocket && !isResumeFlow) {
                        sshFailureAttempts++; // ws 通了但 SSH 没连上：计入上限
                    }
                    scheduleReconnect();
                    maybeProbeAuth();
                }
            };
        } catch (err) {
             connectionStatus.value = 'error';
             statusMessage.value = getStatusText('wsError');
             isSftpReady.value = false;
             ws.value = null;
             // 构造阶段同步抛错时不会有 onerror / onclose，这里补排一次重连，否则会话会永远停在出错
             if (!intentionalDisconnect) {
                 preOpenFailures++;
                 scheduleReconnect();
             }
        }
    };

    /**
     * 手动断开此 WebSocket 连接
     */
    const disconnect = () => {
        intentionalDisconnect = true; // 标记为主动断开
        clearSftpStableReset();
        if (reconnectTimeoutId) {
            clearTimeout(reconnectTimeoutId); // 清除重连定时器
            reconnectTimeoutId = null;
        }
        if (ws.value) {
            if (connectionStatus.value !== 'disconnected') {
                 connectionStatus.value = 'disconnected';
                 statusMessage.value = getStatusText('disconnected', { reason: t('uxTerminal.status.manualDisconnect') });
            }
             ws.value.close(1000, '客户端主动断开'); // 使用标准代码和原因
             ws.value = null;
             isSftpReady.value = false;
             // 手动断开时可以考虑清除处理器，取决于是否需要重连逻辑
             // messageHandlers.clear();
        }
    };

    const reconnect = (url = lastUrl): Promise<boolean> => {
        if (!url) {
            connectionStatus.value = 'error';
            statusMessage.value = getStatusText('wsError');
            return Promise.resolve(false);
        }

        intentionalDisconnect = true;
        if (reconnectTimeoutId) {
            clearTimeout(reconnectTimeoutId);
            reconnectTimeoutId = null;
        }

        const oldWs = ws.value;
        if (!oldWs || oldWs.readyState !== WebSocket.OPEN) {
            // 半开 (CONNECTING) 或正在关闭的旧 socket：先移除处理器再关闭，
            // 否则它稍后的 onopen/onclose 会干扰新连接 (重复会话、丢输入)。
            if (oldWs) discardSocket(oldWs, '客户端请求重新连接');
            ws.value = null;
            reconnectAttempts = 0;
            sshFailureAttempts = 0;
            preOpenFailures = 0;
            isSftpReady.value = false;
            intentionalDisconnect = false;
            reconnectInProgress = true;
            dispatchMessage('internal:reconnect-status', { phase: 'connecting' }, { type: 'internal:reconnect-status' });
            connect(url);
            return Promise.resolve(true);
        }

        const shouldRequestBackendDisconnect = connectionStatus.value === 'connected';
        connectionStatus.value = 'disconnected';
        statusMessage.value = getStatusText('disconnected', { reason: t('uxTerminal.status.preparingReconnect') });
        dispatchMessage('internal:reconnect-status', { phase: 'disconnecting' }, { type: 'internal:reconnect-status' });

        return new Promise<boolean>((resolve) => {
            let finished = false;
            let unregisterAck: () => void = () => undefined;
            let ackTimeoutId: ReturnType<typeof setTimeout> | null = null;
            let closeTimeoutId: ReturnType<typeof setTimeout> | null = null;

            const finish = (success: boolean) => {
                if (finished) return;
                finished = true;
                unregisterAck();
                if (ackTimeoutId) clearTimeout(ackTimeoutId);
                if (closeTimeoutId) clearTimeout(closeTimeoutId);
                resolve(success);
            };

            let closeRequested = false;

            const fail = (message: string) => {
                if (finished) return;
                reconnectInProgress = false;
                // 恢复自动重连能力：否则 intentionalDisconnect 会一直保持 true，之后的掉线不再自动重连。
                intentionalDisconnect = false;
                if (closeRequested) {
                    // 旧连接关闭超时：放弃它 (移除处理器)，以便用户之后可以手动重连。
                    detachSocket(oldWs);
                    if (ws.value === oldWs) ws.value = null;
                    isSftpReady.value = false;
                }
                connectionStatus.value = 'error';
                statusMessage.value = message;
                dispatchMessage('internal:reconnect-status', { phase: 'failed', message }, { type: 'internal:reconnect-status' });
                finish(false);
            };

            const connectAfterClose = () => {
                oldWs.onopen = null;
                oldWs.onmessage = null;
                oldWs.onerror = null;
                oldWs.onclose = () => {
                    if (ws.value === oldWs) ws.value = null;
                    reconnectAttempts = 0;
                    sshFailureAttempts = 0;
                    preOpenFailures = 0;
                    isSftpReady.value = false;
                    intentionalDisconnect = false;
                    reconnectInProgress = true;
                    dispatchMessage('internal:reconnect-status', { phase: 'connecting' }, { type: 'internal:reconnect-status' });
                    connect(url);
                    finish(true);
                };

                closeRequested = true;
                closeTimeoutId = setTimeout(() => fail(t('uxTerminal.status.oldConnectionCloseFailed')), 5000);
                oldWs.close(1000, '客户端请求重新连接');
            };

            // The SSH shell may already be gone while its WebSocket remains open.
            // In that state the backend has no session left to release.
            if (!shouldRequestBackendDisconnect) {
                connectAfterClose();
                return;
            }

            unregisterAck = onMessage('ssh:disconnect:ack', (payload) => {
                if (!payload?.success) {
                    fail(payload?.message || t('uxTerminal.status.backendReleaseFailed'));
                    return;
                }
                connectAfterClose();
            });

            ackTimeoutId = setTimeout(() => fail(t('uxTerminal.status.releaseTimeout')), 5000);
            oldWs.send(JSON.stringify({ type: 'ssh:disconnect', sessionId: instanceSessionId }));
        });
    };

    /**
     * 发送 WebSocket 消息
     * @param {WebSocketMessage} message - 要发送的消息对象
     */
    const sendMessage = (message: WebSocketMessage) => {
        if (ws.value && ws.value.readyState === WebSocket.OPEN) {
            try {
                const messageString = JSON.stringify(message);
                ws.value.send(messageString);
            } catch (e) {
                console.error(`[WebSocket ${instanceSessionId}] 序列化或发送消息失败:`, e, message);
            }
        } else {
            console.warn(`[WebSocket ${instanceSessionId}] 无法发送消息，连接未打开。状态: ${connectionStatus.value}, ReadyState: ${ws.value?.readyState}`);
        }
    };

    /**
     * 注册一个消息处理器
     * @param {string} type - 要监听的消息类型
     * @param {MessageHandler} handler - 处理函数
     * @returns {Function} 一个用于注销此处理器的函数
     */
    const onMessage = (type: string, handler: MessageHandler): (() => void) => {
        if (!messageHandlers.has(type)) {
            messageHandlers.set(type, new Set());
        }
        const handlersSet = messageHandlers.get(type);
        if (handlersSet) {
             handlersSet.add(handler);
             // console.debug(`[WebSocket ${instanceSessionId}] 已注册处理器: ${type}`);
        }

        // 返回注销函数
        return () => {
            const currentSet = messageHandlers.get(type);
            if (currentSet) {
                currentSet.delete(handler);
                // console.debug(`[WebSocket ${instanceSessionId}] 已注销处理器: ${type}`);
                if (currentSet.size === 0) {
                    messageHandlers.delete(type);
                }
            }
        };
    };

    // 注意：没有在此处使用 onUnmounted。
    // disconnect 方法需要由外部调用者 (例如 WorkspaceView) 在会话关闭时显式调用。

    // 返回此实例的状态和方法
    return {
        // 状态 (只读引用)
        isConnected: computed(() => connectionStatus.value === 'connected'),
        isSftpReady: readonly(isSftpReady),
        connectionStatus: readonly(connectionStatus),
        statusMessage: readonly(statusMessage),

        // 方法
        connect,
        disconnect,
        reconnect,
        sendMessage,
        onMessage,
        /** 跳过退避等待立即重连（网络恢复 / 页面重新可见 / 断线时键盘输入） */
        retryNow,
        /** 会话关闭时调用：摘掉全局监听器与定时器 */
        dispose,
    };
}
