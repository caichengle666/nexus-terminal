import { ref, readonly, type Ref, ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { sessions as globalSessionsRef } from '../stores/session/state'; // +++ 导入全局 sessions state +++
// import { useWebSocketConnection } from './useWebSocketConnection'; // 移除全局导入
import type { Terminal } from '@xterm/xterm';
import type { SearchAddon, ISearchOptions } from '@xterm/addon-search'; // *** 移除 ISearchResult 导入 ***
import type { WebSocketMessage, MessagePayload } from '../types/websocket.types';
import { useWorkspaceEventEmitter } from './workspaceEvents';
import {
    scanSearchBuffer,
    type TerminalSearchMatch,
    type TerminalSearchOptions,
} from '../utils/terminalSearch';

// 定义与 WebSocket 相关的依赖接口
export interface SshTerminalDependencies {
    sendMessage: (message: WebSocketMessage) => void;
    onMessage: (type: string, handler: (payload: any, fullMessage?: WebSocketMessage) => void) => () => void;
    isConnected: ComputedRef<boolean>;
}

/**
 * 创建一个 SSH 终端管理器实例
 * @param sessionId 会话唯一标识符
 * @param wsDeps WebSocket 依赖对象
 * @param t i18n 翻译函数，从父组件传入
 * @returns SSH 终端管理器实例
 */
export function createSshTerminalManager(sessionId: string, wsDeps: SshTerminalDependencies, t: ReturnType<typeof useI18n>['t']) { // +++ Update type of t +++
    // 使用依赖注入的 WebSocket 函数
    const { sendMessage, onMessage, isConnected } = wsDeps;

    const terminalInstance = ref<Terminal | null>(null);
    const searchAddon = ref<SearchAddon | null>(null); // Keep searchAddon ref
    // Removed search result state refs
    // const searchResultCount = ref(0);
    // const currentSearchResultIndex = ref(-1);
    const terminalOutputBuffer = ref<(string | Uint8Array)[]>([]); // 缓冲 WebSocket 消息直到终端准备好
    const pendingTerminalWrites: (string | Uint8Array)[] = [];
    let terminalWriteTimer: ReturnType<typeof setTimeout> | null = null;
    const isSshConnected = ref(false); // 跟踪 SSH 连接状态
    const isReconnecting = ref(false);
    // WebSocket 意外断开（等待自动重连/恢复）期间为 true
    let wsDropped = false;
    let reattachNoticeShown = false; // 同一次断线只提示一次「正在接回」
    // 断线期间对用户输入的提示只显示一次，状态变化时重置
    let lastInputNotice: 'connecting' | 'disconnected' | null = null;

    const writeNotice = (text: string, color: 'yellow' | 'red' | 'green' = 'yellow') => {
        const code = color === 'red' ? 31 : color === 'green' ? 32 : 33;
        terminalInstance.value?.writeln(`\r\n\x1b[${code}m${text}\x1b[0m`);
    };

    const flushTerminalWrites = () => {
        terminalWriteTimer = null;
        const term = terminalInstance.value;
        if (!term || pendingTerminalWrites.length === 0) return;

        const writes = pendingTerminalWrites.splice(0, pendingTerminalWrites.length);
        writes.forEach(data => term.write(data));

        if (pendingTerminalWrites.length > 0) {
            terminalWriteTimer = setTimeout(flushTerminalWrites, 16);
        }
    };

    const writeToTerminal = (data: string | Uint8Array) => {
        if (!terminalInstance.value) {
            terminalOutputBuffer.value.push(data);
            return;
        }

        pendingTerminalWrites.push(data);
        if (terminalWriteTimer === null) {
            terminalWriteTimer = setTimeout(flushTerminalWrites, 16);
        }
    };

    // 辅助函数：获取终端消息文本
    const getTerminalText = (key: string, params?: Record<string, any>): string => {
        // 确保 i18n key 存在，否则返回原始 key
        const translationKey = `workspace.terminal.${key}`;
        const translated = t(translationKey, params || {});
        return translated === translationKey ? key : translated;
    };

    // --- 终端事件处理 ---

    // *** 更新 handleTerminalReady 签名以接收 searchAddon ***
    const handleTerminalReady = (payload: { terminal: Terminal; searchAddon: SearchAddon | null }) => {
        const { terminal: term, searchAddon: addon } = payload;
        console.log(`[会话 ${sessionId}][SSH终端模块] 终端实例已就绪。SearchAddon 实例:`, addon ? '存在' : '不存在');
        terminalInstance.value = term;
        searchAddon.value = addon; // *** 存储 searchAddon 实例 ***

        
        // 1. 处理 SessionState.pendingOutput (来自 SSH_OUTPUT_CACHED_CHUNK 的早期数据)
        const currentSessionState = globalSessionsRef.value.get(sessionId);
        if (currentSessionState && currentSessionState.pendingOutput && currentSessionState.pendingOutput.length > 0) {
            // console.log(`[会话 ${sessionId}][SSH终端模块] 发现 SessionState.pendingOutput，长度: ${currentSessionState.pendingOutput.length}。正在写入...`);
            currentSessionState.pendingOutput.forEach(data => {
                writeToTerminal(data);
            });
            currentSessionState.pendingOutput = []; // 清空
            // console.log(`[会话 ${sessionId}][SSH终端模块] SessionState.pendingOutput 处理完毕。`);
            // 如果之前因为 pendingOutput 而将 isResuming 保持为 true，现在可以考虑更新
            if (currentSessionState.isResuming) {
                // 检查 isLastChunk 是否已收到 (这部分逻辑在 handleSshOutputCachedChunk 中，这里仅作标记清除)
                // 假设所有缓存块都已处理完毕
                // console.log(`[会话 ${sessionId}][SSH终端模块] 所有 pendingOutput 已写入，清除 isResuming 标记。`);
                currentSessionState.isResuming = false;
            }
        }

        // 2. 将此管理器内部缓冲的输出 (terminalOutputBuffer, 来自 ssh:output) 写入终端
        if (terminalOutputBuffer.value.length > 0) {
            terminalOutputBuffer.value.forEach(data => {
                 writeToTerminal(data);
            });
            terminalOutputBuffer.value = []; // 清空内部缓冲区
        }
        
        // 可以在这里自动聚焦或执行其他初始化操作
        // term.focus(); // 也许在 ssh:connected 时聚焦更好
    };

    const handleTerminalData = (data: string) => {
        // console.debug(`[会话 ${sessionId}][SSH终端模块] 接收到终端输入:`, data);
        sendMessage({ type: 'ssh:input', sessionId, payload: { data } });
    };

    const handleTerminalResize = (dimensions: { cols: number; rows: number }) => {
        console.log(`[SSH ${sessionId}] handleTerminalResize called with:`, dimensions);
        // 只有在连接状态下才发送 resize 命令给后端
        if (isConnected.value) {
            sendMessage({ type: 'ssh:resize', sessionId, payload: dimensions });
        } else {
            console.log(`[SSH ${sessionId}] WebSocket not connected, skipping ssh:resize.`);
        }
    };

    // --- WebSocket 消息处理 ---

    const handleSshOutput = (payload: MessagePayload, message?: WebSocketMessage) => {
        // 检查消息是否属于此会话
        if (message?.sessionId && message.sessionId !== sessionId) {
            return; // 忽略不属于此会话的消息
        }

        let outputData = payload;
        // 检查是否为 Base64 编码 (需要后端配合发送 encoding 字段)
        if (message?.encoding === 'base64' && typeof outputData === 'string') {
            try {
                // 使用更安全的Base64解码方式，保证中文字符正确解码
                const base64String = outputData;
                // 先用atob获取二进制字符串
                const binaryString = atob(base64String);
                // 创建Uint8Array存储二进制数据
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }
                // 直接使用原始二进制数据作为 Uint8Array 写入终端，避免编码转换问题
                outputData = bytes;
            } catch (e) {
                console.error(`[会话 ${sessionId}][SSH终端模块] Base64 解码失败:`, e, '原始数据:', message.payload);
                outputData = `\r\n[${t('uxTerminal.terminal.decodeError', { error: String(e) })}]\r\n`; // 在终端显示解码错误
            }
        }
        // 如果不是 base64 或解码失败，确保它是字符串
        else if (typeof outputData !== 'string') {
             console.warn(`[会话 ${sessionId}][SSH终端模块] 收到非字符串 ssh:output payload:`, outputData);
             try {
                 outputData = JSON.stringify(outputData); // 尝试序列化
             } catch {
                 outputData = String(outputData); // 最后手段：强制转字符串
             }
        }

        // 由于直接使用原始二进制数据，不再需要过滤 OSC 184 序列
        // 相关代码已移除

        // --- 添加前端日志 ---
        // console.log(`[会话 ${sessionId}][SSH前端] 收到 ssh:output 原始 payload (解码前):`, payload);
        // console.log(`[会话 ${sessionId}][SSH前端] 解码后的数据 (尝试写入):`, outputData);
        // --------------------

        if (terminalInstance.value) {
            // console.log(`[会话 ${sessionId}][SSH前端] 终端实例存在，尝试写入...`);
            writeToTerminal(outputData);
            // console.log(`[会话 ${sessionId}][SSH前端] 写入完成。`);
        } else {
            // 如果终端还没准备好，先缓冲输出
            terminalOutputBuffer.value.push(outputData);
        }
    };

    const handleSshConnected = (payload: MessagePayload, message?: WebSocketMessage) => {
        // 检查消息是否属于此会话
        if (message?.sessionId && message.sessionId !== sessionId) {
            return; // 忽略不属于此会话的消息
        }

        console.log(`[会话 ${sessionId}][SSH终端模块] SSH 会话已连接。 Payload:`, payload, 'Full message:', message); // 更详细的日志
        isSshConnected.value = true; // 更新状态
        lastInputNotice = null;
        if (payload?.resumed) {
            // 后端在 WebSocket 断线期间保留了 SSH 会话，此处接回原会话，随后会补发断线期间的输出
            const note = payload?.outputTruncated ? t('uxTerminal.terminal.resumedTruncatedNote') : '';
            writeNotice(t('uxTerminal.terminal.sessionResumed', { note }), 'green');
            isReconnecting.value = false;
        } else if (isReconnecting.value) {
            writeNotice(t('uxTerminal.terminal.reconnectSucceeded'), 'green');
            isReconnecting.value = false;
        } else if (wsDropped) {
            // 断线时间超过后端保留期，原会话已结束，后端新建了 SSH 会话
            writeNotice(t('uxTerminal.terminal.reconnectedNewSession'), 'green');
        }
        wsDropped = false;
        // 连接成功后聚焦终端
        terminalInstance.value?.focus();

        if (terminalInstance.value) {
            const currentDimensions = { cols: terminalInstance.value.cols, rows: terminalInstance.value.rows };
            // 检查尺寸是否有效
            if (currentDimensions.cols > 0 && currentDimensions.rows > 0) {
                console.log(`[会话 ${sessionId}][SSH终端模块] SSH 连接成功，主动发送初始尺寸:`, currentDimensions);
                sendMessage({ type: 'ssh:resize', sessionId, payload: currentDimensions });
            } else {
                console.warn(`[会话 ${sessionId}][SSH终端模块] SSH 连接成功，但获取到的初始尺寸无效，跳过发送 resize:`, currentDimensions);
            }
        } else {
             console.warn(`[会话 ${sessionId}][SSH终端模块] SSH 连接成功，但 terminalInstance 不可用，无法发送初始 resize。`);
        }


        // 清空可能存在的旧缓冲（虽然理论上此时应该已经 ready 了）
        if (terminalOutputBuffer.value.length > 0) {
             console.warn(`[会话 ${sessionId}][SSH终端模块] SSH 连接时仍有缓冲数据，正在写入...`);
             terminalOutputBuffer.value.forEach(data => writeToTerminal(data));
             terminalOutputBuffer.value = [];
        }
    };

    const handleSshDisconnected = (payload: MessagePayload, message?: WebSocketMessage) => {
        // 检查消息是否属于此会话
        if (message?.sessionId && message.sessionId !== sessionId) {
            return; // 忽略不属于此会话的消息
        }

        const reason = payload || t('workspace.terminal.unknownReason'); // 使用 i18n 获取未知原因文本
        console.log(`[会话 ${sessionId}][SSH终端模块] SSH 会话已断开:`, reason);
        isSshConnected.value = false; // 更新状态
        terminalInstance.value?.writeln(`\r\n\x1b[31m${getTerminalText('disconnectMsg', { reason })}\x1b[0m`);
        // 可以在这里添加其他清理逻辑，例如禁用输入
    };

    const handleSshError = (payload: MessagePayload, message?: WebSocketMessage) => {
        // 检查消息是否属于此会话
        if (message?.sessionId && message.sessionId !== sessionId) {
            return; // 忽略不属于此会话的消息
        }

        const errorMsg = payload || t('workspace.terminal.unknownSshError'); // 使用 i18n
        console.error(`[会话 ${sessionId}][SSH终端模块] SSH 错误:`, errorMsg);
        isSshConnected.value = false; // 更新状态
        terminalInstance.value?.writeln(`\r\n\x1b[31m${getTerminalText('genericErrorMsg', { message: errorMsg })}\x1b[0m`);
    };

    const handleSshStatus = (payload: MessagePayload, message?: WebSocketMessage) => {
        // 检查消息是否属于此会话
        if (message?.sessionId && message.sessionId !== sessionId) {
            return; // 忽略不属于此会话的消息
        }

        // 这个消息现在由 useWebSocketConnection 处理以更新全局状态栏消息
        // 这里可以保留日志或用于其他特定于终端的 UI 更新（如果需要）
        const statusKey = payload?.key || 'unknown';
        const statusParams = payload?.params || {};
        console.log(`[会话 ${sessionId}][SSH终端模块] 收到 SSH 状态更新:`, statusKey, statusParams);
        // 可以在终端打印一些状态信息吗？
        // terminalInstance.value?.writeln(`\r\n\x1b[34m[状态: ${statusKey}]\x1b[0m`);
    };

    const handleInfoMessage = (payload: MessagePayload, message?: WebSocketMessage) => {
        // 检查消息是否属于此会话
        if (message?.sessionId && message.sessionId !== sessionId) {
            return; // 忽略不属于此会话的消息
        }

        console.log(`[会话 ${sessionId}][SSH终端模块] 收到后端信息:`, payload);
        terminalInstance.value?.writeln(`\r\n\x1b[34m${getTerminalText('infoPrefix')} ${payload}\x1b[0m`);
    };

    const handleErrorMessage = (payload: MessagePayload, message?: WebSocketMessage) => {
        // 检查消息是否属于此会话
        if (message?.sessionId && message.sessionId !== sessionId) {
            return; // 忽略不属于此会话的消息
        }

        // 通用错误也可能需要显示在终端
        const errorMsg = payload || t('workspace.terminal.unknownGenericError'); // 使用 i18n
        console.error(`[会话 ${sessionId}][SSH终端模块] 收到后端通用错误:`, errorMsg);
        terminalInstance.value?.writeln(`\r\n\x1b[31m${getTerminalText('errorPrefix')} ${errorMsg}\x1b[0m`);
    };

    const handleReconnectStatus = (payload: MessagePayload) => {
        lastInputNotice = null;
        if (payload?.phase === 'disconnecting') {
            isReconnecting.value = true;
            isSshConnected.value = false;
            writeNotice(t('uxTerminal.terminal.closingOldConnection'));
        } else if (payload?.phase === 'connecting') {
            isReconnecting.value = true;
            terminalInstance.value?.writeln(`\x1b[33m${t('uxTerminal.terminal.oldConnectionReleased')}\x1b[0m`);
        } else if (payload?.phase === 'failed') {
            isReconnecting.value = false;
            isSshConnected.value = false;
            writeNotice(t('uxTerminal.terminal.reconnectFailed', { message: payload?.message || t('uxTerminal.unknownError') }), 'red');
            writeNotice(t('uxTerminal.terminal.pressEnterToReconnect'));
        } else if (payload?.phase === 'auto-retry') {
            // WebSocket 意外断开，正在自动重连（后端会在保留期内保留 SSH 会话）。
            // 重连间隔只有 0.5~5s 且不设上限，每次重试都写一行会刷屏：同一次断线只提示一次。
            isSshConnected.value = false;
            if (!wsDropped) {
                wsDropped = true;
                reattachNoticeShown = false;
                writeNotice(t('uxTerminal.terminal.connectionLostReconnecting'));
            }
        } else if (payload?.phase === 'stopped') {
            // 不可重试的错误（错误详情已由 ssh:error 输出）：不再自动重连
            isSshConnected.value = false;
            isReconnecting.value = false;
            wsDropped = false;
            if (payload?.reason === 'auth') {
                writeNotice(t('uxTerminal.terminal.authExpiredStopReconnect'), 'red');
            }
            writeNotice(t('uxTerminal.terminal.pressEnterToReconnect'));
        } else if (payload?.phase === 'exhausted') {
            isSshConnected.value = false;
            isReconnecting.value = false;
            wsDropped = false;
            writeNotice(t('uxTerminal.terminal.autoReconnectGaveUp'), 'red');
            writeNotice(t('uxTerminal.terminal.pressEnterToReconnect'));
        }
    };

    const handleWsOpened = () => {
        // 断线后 ws 重新连上：网络已恢复，正在等待后端接回原 SSH 会话（ssh:connected 带 resumed）
        if (wsDropped && !isSshConnected.value && !reattachNoticeShown) {
            reattachNoticeShown = true;
            writeNotice(t('uxTerminal.terminal.reattaching'));
        }
    };

    const handleWsClosed = () => {
        // WebSocket 断开后 SSH 输入无法送达，标记为未连接
        // （提示文字由随后的 auto-retry / exhausted 状态事件输出）
        isSshConnected.value = false;
    };

    /**
     * 连接不可用时用户输入的提示（不静默丢弃）。同一断线状态下只提示一次。
     * @param state 'connecting' 正在自动重连；'disconnected' 已断开，需要按 Enter 重连
     */
    const notifyInputBlocked = (state: 'connecting' | 'disconnected') => {
        if (lastInputNotice === state) return;
        lastInputNotice = state;
        writeNotice(t(state === 'connecting'
            ? 'uxTerminal.terminal.inputIgnoredReconnecting'
            : 'uxTerminal.terminal.pressEnterToReconnect'));
    };


    // --- 注册 WebSocket 消息处理器 ---
    const unregisterHandlers: (() => void)[] = [];

    const registerSshHandlers = () => {
        unregisterHandlers.push(onMessage('ssh:output', handleSshOutput));
        unregisterHandlers.push(onMessage('ssh:connected', handleSshConnected));
        unregisterHandlers.push(onMessage('ssh:disconnected', handleSshDisconnected));
        unregisterHandlers.push(onMessage('ssh:error', handleSshError));
        unregisterHandlers.push(onMessage('ssh:status', handleSshStatus));
        unregisterHandlers.push(onMessage('info', handleInfoMessage));
        unregisterHandlers.push(onMessage('error', handleErrorMessage)); // 也处理通用错误
        unregisterHandlers.push(onMessage('internal:reconnect-status', handleReconnectStatus));
        unregisterHandlers.push(onMessage('internal:closed', handleWsClosed));
        unregisterHandlers.push(onMessage('internal:opened', handleWsOpened));
        console.log(`[会话 ${sessionId}][SSH终端模块] 已注册 SSH 相关消息处理器。`);
    };

    const unregisterAllSshHandlers = () => {
        console.log(`[会话 ${sessionId}][SSH终端模块] 注销 SSH 相关消息处理器...`);
        unregisterHandlers.forEach(unregister => unregister?.());
        unregisterHandlers.length = 0; // 清空数组
    };

    // 初始化时自动注册处理程序
    registerSshHandlers();

    // --- 清理函数 ---
    const cleanup = () => {
        unregisterAllSshHandlers();
        // 释放搜索状态（装饰 / viewport 监听 / 定时器）
        disposeSearchState();
        if (terminalWriteTimer !== null) {
            clearTimeout(terminalWriteTimer);
            terminalWriteTimer = null;
        }
        pendingTerminalWrites.length = 0;
        terminalOutputBuffer.value = [];
        // terminalInstance.value?.dispose(); // 终端实例的销毁由 TerminalComponent 负责
        terminalInstance.value = null;
        console.log(`[会话 ${sessionId}][SSH终端模块] 已清理。`);
    };

    /**
     * 直接发送数据到 SSH 会话 (例如，从命令输入栏)
     * @param data 要发送的字符串数据
     */
    const sendData = (data: string) => {
        // console.debug(`[会话 ${sessionId}][SSH终端模块] 直接发送数据:`, data);
        sendMessage({ type: 'ssh:input', sessionId, payload: { data } });
    };

    // --- 搜索相关方法（自研高亮，移植自上游 terminal-search） ---
    //
    // 不用 @xterm/addon-search 做高亮：它每次搜索词变化都全量扫 buffer，且不暴露命中行号，
    // 滚动条标记还得再扫一遍。这里"扫一次 → 自己建 decoration"：扫描分片可取消，
    // 装饰只覆盖可视区附近，翻页直接用已有的 matches，不再触发扫描。

    const emitWorkspaceEvent = useWorkspaceEventEmitter();

    /** 搜索词变化后的扫描防抖（输入栏本身也有 140ms 防抖，这里兜底选项切换等连续触发） */
    const SEARCH_DEBOUNCE_MS = 60;
    /*
     * xterm 的 decoration 只接受 `#RRGGBB`（DOM renderer 会丢掉 rgba 的 alpha，渲染成不透明纯色），
     * 所以用中等亮度的暗色：深色主题下白字可读，浅色主题下黑字也能辨认。
     * 黄褐 = 全部命中，红 = 当前命中（与滚动条标记同一套语义）。
     */
    const SEARCH_MATCH_BG = '#8a6d1f';
    const SEARCH_ACTIVE_BG = '#b91c1c';

    interface SearchState {
        term: string;
        options: TerminalSearchOptions;
        matches: TerminalSearchMatch[];
        matchLines: number[];
        totalLines: number;
        index: number;
        token: number;
        decorations: Array<{ dispose: () => void }>;
        viewport: HTMLElement | null;
        viewportListener: (() => void) | null;
        rebuildTimer: ReturnType<typeof setTimeout> | null;
        scanTimer: ReturnType<typeof setTimeout> | null;
    }

    let searchState: SearchState | null = null;

    /**
     * 清掉装饰并强制重绘一屏。只 dispose 不够：DOM renderer 把底色写在字符 span 上，
     * 要等下一次重绘才恢复；终端没有新输出时就会"关闭搜索后黄色还留着"。
     */
    const disposeSearchDecorations = (state: SearchState, term?: Terminal | null) => {
        state.decorations.forEach((d) => {
            try { d.dispose(); } catch { /* ignore */ }
        });
        state.decorations = [];
        if (term) {
            try { term.refresh(0, term.rows - 1); } catch { /* ignore */ }
        }
    };

    /** 只给"可视区上下各一屏"的命中建装饰；全 buffer 建几百上千个正是 addon 慢的原因 */
    const applySearchDecorations = (term: Terminal, state: SearchState) => {
        disposeSearchDecorations(state, term);
        const buffer = term.buffer.active;
        // 备用屏（vim / less / btop）坐标体系不同，不画
        if (buffer.type === 'alternate' || !state.matches.length) return;

        const cursorAbs = buffer.baseY + buffer.cursorY;
        const from = Math.max(0, buffer.viewportY - term.rows);
        const to = buffer.viewportY + term.rows * 2;

        for (let i = 0; i < state.matches.length; i++) {
            const m = state.matches[i];
            if (m.row < from || m.row > to) continue;
            // registerMarker 的入参是"相对光标的行偏移"
            const marker = term.registerMarker(m.row - cursorAbs);
            if (!marker) continue;
            const deco = term.registerDecoration({
                marker,
                x: m.col,
                width: m.length,
                backgroundColor: i === state.index ? SEARCH_ACTIVE_BG : SEARCH_MATCH_BG,
            });
            if (deco) {
                // marker 跟着 decoration 一起释放，避免长时间搜索累积 marker
                state.decorations.push({ dispose: () => { deco.dispose(); marker.dispose(); } });
            } else {
                marker.dispose();
            }
        }
    };

    const emitSearchState = (state: SearchState) => {
        emitWorkspaceEvent('search:markers', {
            sessionId,
            matchLines: state.matchLines,
            totalLines: state.totalLines,
            index: state.index,
        });
        emitWorkspaceEvent('search:results', {
            sessionId,
            index: state.index,
            count: state.matches.length,
        });
    };

    const jumpToSearchMatch = (term: Terminal, state: SearchState, index: number) => {
        if (!state.matches.length) return;
        const total = state.matches.length;
        // 循环翻页：-1 -> 最后一个，total -> 0
        state.index = ((index % total) + total) % total;
        const m = state.matches[state.index];
        // 让命中行尽量落在视口中间偏上，而不是贴着顶边
        term.scrollToLine(Math.max(0, m.row - Math.floor(term.rows / 3)));
        // 不调用 term.select()：选区渲染会盖住当前命中的红色
        applySearchDecorations(term, state);
        emitSearchState(state);
    };

    const ensureSearchState = (term: Terminal): SearchState => {
        if (searchState) return searchState;
        const state: SearchState = {
            term: '', options: {}, matches: [], matchLines: [], totalLines: 1, index: -1, token: 0,
            decorations: [], viewport: null, viewportListener: null, rebuildTimer: null, scanTimer: null,
        };
        searchState = state;
        // 滚轮滚动走 .xterm-viewport 的原生 scroll，不会触发 xterm 的 onScroll，
        // 所以可视区附近的高亮要靠这个元素的 scroll 重建。
        const viewport = term.element?.querySelector('.xterm-viewport') as HTMLElement | null;
        if (viewport) {
            const listener = () => {
                if (state.rebuildTimer) clearTimeout(state.rebuildTimer);
                state.rebuildTimer = setTimeout(() => {
                    state.rebuildTimer = null;
                    if (searchState === state && terminalInstance.value) {
                        applySearchDecorations(terminalInstance.value, state);
                    }
                }, 120);
            };
            viewport.addEventListener('scroll', listener, { passive: true });
            state.viewport = viewport;
            state.viewportListener = listener;
        }
        return state;
    };

    const disposeSearchState = () => {
        const state = searchState;
        if (!state) return;
        state.token++;
        if (state.scanTimer) clearTimeout(state.scanTimer);
        if (state.rebuildTimer) clearTimeout(state.rebuildTimer);
        disposeSearchDecorations(state, terminalInstance.value);
        if (state.viewport && state.viewportListener) {
            state.viewport.removeEventListener('scroll', state.viewportListener);
        }
        searchState = null;
    };

    /** 搜索入口：同一个词只翻页（不重扫），词/选项变化才重新扫描 */
    const runTerminalSearch = (term: string, options: TerminalSearchOptions, direction: 'next' | 'previous'): boolean => {
        const xterm = terminalInstance.value;
        if (!xterm) {
            console.warn(`[会话 ${sessionId}][SSH终端模块] 搜索失败，终端尚未就绪。`);
            return false;
        }
        const state = ensureSearchState(xterm);
        const sameQuery =
            state.term === term &&
            !!state.options.regex === !!options.regex &&
            !!state.options.wholeWord === !!options.wholeWord &&
            !!state.options.caseSensitive === !!options.caseSensitive;

        if (sameQuery && state.matches.length > 0) {
            jumpToSearchMatch(xterm, state, state.index + (direction === 'next' ? 1 : -1));
            return true;
        }
        // 同一个词但上次没有命中：终端可能有了新输出，重新扫描

        state.token++;
        const token = state.token;
        if (state.scanTimer) clearTimeout(state.scanTimer);
        disposeSearchDecorations(state, xterm);
        state.term = term;
        state.options = { ...options };
        state.matches = [];
        state.matchLines = [];
        state.index = -1;

        if (!term) {
            emitSearchState(state);
            return false;
        }

        state.scanTimer = setTimeout(async () => {
            state.scanTimer = null;
            const buffer = xterm.buffer?.active;
            if (!buffer) return;
            const result = await scanSearchBuffer(buffer, term, options, () => token !== state.token);
            if (token !== state.token || searchState !== state) return; // 已被更新的搜索取代
            state.matches = result.matches;
            state.matchLines = result.matchLines;
            // 标记画在整条滚动条轨道上，轨道代表整个 buffer，所以按 buffer 总行数换算
            state.totalLines = Math.max(1, buffer.length);
            if (!state.matches.length) {
                state.index = -1;
                emitSearchState(state);
                return;
            }
            // 从"当前视口顶部往后"的第一个命中开始，符合"从正在看的位置往下找"的直觉
            let start = direction === 'next'
                ? state.matches.findIndex((m) => m.row >= buffer.viewportY)
                : -1;
            if (start < 0) start = direction === 'next' ? 0 : state.matches.length - 1;
            jumpToSearchMatch(xterm, state, start);
        }, SEARCH_DEBOUNCE_MS);
        return true;
    };

    const toSearchOptions = (options?: ISearchOptions): TerminalSearchOptions => ({
        regex: options?.regex,
        wholeWord: options?.wholeWord,
        caseSensitive: options?.caseSensitive,
    });

    const searchNext = (term: string, options?: ISearchOptions): boolean =>
        runTerminalSearch(term, toSearchOptions(options), 'next');

    const searchPrevious = (term: string, options?: ISearchOptions): boolean =>
        runTerminalSearch(term, toSearchOptions(options), 'previous');

    const clearTerminalSearch = () => {
        disposeSearchState();
        terminalInstance.value?.clearSelection();
        // 兼容：老路径可能还在用 addon 的装饰
        searchAddon.value?.clearDecorations();
        emitWorkspaceEvent('search:markers', { sessionId, matchLines: [], totalLines: 1, index: -1 });
        emitWorkspaceEvent('search:results', { sessionId, index: -1, count: 0 });
    };


    // 返回工厂实例
    return {
        // 公共接口
        handleTerminalReady,
        handleTerminalData, // 这个处理来自 xterm.js 的输入
        handleTerminalResize,
        sendData, // 允许外部直接发送数据
        notifyInputBlocked, // 连接不可用时提示用户输入未发送
        cleanup,
        // --- 搜索方法 ---
        searchNext,
        searchPrevious,
        clearTerminalSearch,
        // --- 暴露状态 ---
        isSshConnected: readonly(isSshConnected), // 暴露 SSH 连接状态 (只读)
        terminalInstance, // 暴露 terminal 实例，以便 WorkspaceView 可以写入提示信息
    };
}

// 保留兼容旧代码的函数（将在完全迁移后移除）
export function useSshTerminal(t: (key: string) => string) {
    console.warn('⚠️ 使用已弃用的 useSshTerminal() 全局单例。请迁移到 createSshTerminalManager() 工厂函数。');
    
    const terminalInstance = ref<Terminal | null>(null);
    
    const handleTerminalReady = (term: Terminal) => {
        console.log('[SSH终端模块][旧] 终端实例已就绪，但使用了已弃用的单例模式。');
        terminalInstance.value = term;
    };
    
    const handleTerminalData = (data: string) => {
        console.warn('[SSH终端模块][旧] 收到终端数据，但使用了已弃用的单例模式，无法发送。');
    };
    
    const handleTerminalResize = (dimensions: { cols: number; rows: number }) => {
        console.warn('[SSH终端模块][旧] 收到终端大小调整，但使用了已弃用的单例模式，无法发送。');
    };
    
    // 返回与旧接口兼容的空函数，以避免错误
    return {
        terminalInstance,
        handleTerminalReady,
        handleTerminalData,
        handleTerminalResize,
        registerSshHandlers: () => console.warn('[SSH终端模块][旧] 调用了已弃用的 registerSshHandlers'),
        unregisterAllSshHandlers: () => console.warn('[SSH终端模块][旧] 调用了已弃用的 unregisterAllSshHandlers'),
    };
}
