import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import apiClient from '../utils/apiClient';
import { useSessionStore } from './session.store';
import {
  AI_REQUEST_COMPACT_BYTES,
  CONFIG_KEY,
  MAX_MODEL_RECENT_MESSAGES,
  MAX_MODEL_SUMMARY_LENGTH,
  MAX_TERMINAL_OUTPUT_CHARS,
  TAIL_CONTEXT_BUDGET_CHARS,
} from './ai/ai.constants';
import {
  compactSessionContext,
  estimateJsonBytes,
  formatMessagesForSummary,
  pruneToolMessages,
  removeOldestModelContextMessage,
  sanitizeToolMessages,
  selectTailMessages,
  shrinkModelMessagesToBudget,
} from './ai/ai.compression';
import {
  appendSummarySection,
  createEmptyMemory,
  loadStoredMemories,
  persistMemories,
  trimSummaryForStorage,
} from './ai/ai.memory';
import {
  aiTools,
  detectRiskyCommand,
  normalizeCommand,
  parseToolArgs,
  stringifyToolResultForModel,
  truncateForModel,
} from './ai/ai.tools';
import type {
  AiChatMessage,
  AiCompactResult,
  AiRunContext,
  AiRunMode,
  AiRuntimeState,
  AiSessionMemory,
  AiTaskStatus,
  AiToolCall,
  AiToolRun,
  CompactContextOptions,
  SendMessageOptions,
  TerminalInputArgs,
} from './ai/ai.types';
import type { SessionState } from './session/types';

export type { AiTaskStatus, AiToolRun } from './ai/ai.types';

const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));

export const useAiStore = defineStore('ai', () => {
  const sessionStore = useSessionStore();

  const sessionInputs = ref<Record<string, string>>({});
  const configMessage = ref('');
  const hasSavedApiKey = ref(false);
  const showConfig = ref(false);
  const sessionMemories = ref<Record<string, AiSessionMemory>>({});
  const sessionRuntimes = ref<Record<string, AiRuntimeState>>({});

  const config = ref({
    apiBaseUrl: '',
    apiKey: '',
    model: '',
    runMode: 'confirm' as AiRunMode,
  });

  const storeActiveSessionId = computed(() => sessionStore.activeSessionId || '');
  const activeSession = computed(() => sessionStore.activeSession);
  const activeSessionId = computed(() => storeActiveSessionId.value || activeSession.value?.sessionId || '');
  const activeMemoryKey = computed(() => activeSessionId.value || 'global');
  const getRuntimeBySessionId = (sessionId?: string) => {
    const key = sessionId || 'global';
    if (!sessionRuntimes.value[key]) {
      sessionRuntimes.value[key] = {
        isRunning: false,
        stopRequested: false,
        taskStatus: 'idle',
        errorMessage: '',
        abortController: null,
      };
    }
    return sessionRuntimes.value[key];
  };
  const currentMemory = computed(() => {
    const key = activeMemoryKey.value;
    if (!sessionMemories.value[key]) {
      sessionMemories.value[key] = createEmptyMemory();
    }
    return sessionMemories.value[key];
  });
  const currentRuntime = computed(() => getRuntimeBySessionId(activeMemoryKey.value));
  const userInput = computed({
    get: () => sessionInputs.value[activeMemoryKey.value] || '',
    set: (value: string) => {
      sessionInputs.value[activeMemoryKey.value] = value;
    },
  });
  const messages = computed(() => currentMemory.value.messages);
  const toolRuns = computed(() => currentMemory.value.toolRuns);
  const visibleMessages = computed(() => messages.value.filter(message => message.role !== 'tool'));
  const latestToolRuns = computed(() => toolRuns.value.slice(-20).reverse());
  const memorySummary = computed(() => currentMemory.value.summary);
  const isRunning = computed(() => currentRuntime.value.isRunning);
  const stopRequested = computed(() => currentRuntime.value.stopRequested);
  const taskStatus = computed({
    get: () => currentRuntime.value.taskStatus,
    set: (value: AiTaskStatus) => {
      currentRuntime.value.taskStatus = value;
    },
  });
  const errorMessage = computed({
    get: () => currentRuntime.value.errorMessage,
    set: (value: string) => {
      currentRuntime.value.errorMessage = value;
    },
  });
  const runMode = computed({
    get: () => config.value.runMode,
    set: (value: AiRunMode) => {
      config.value.runMode = value;
    },
  });
  const canSend = computed(() => !!userInput.value.trim() && !isRunning.value);
  const hasActiveTerminal = computed(() => !!activeSession.value?.terminalManager?.terminalInstance?.value);

  const persistableConfig = () => ({
    apiBaseUrl: config.value.apiBaseUrl,
    model: config.value.model,
    runMode: config.value.runMode,
  });

  const loadConfig = async () => {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      if (raw) {
        config.value = { ...config.value, ...JSON.parse(raw) };
        localStorage.setItem(CONFIG_KEY, JSON.stringify(persistableConfig()));
      }
    } catch (error) {
      console.warn('[AI Terminal] Failed to load config:', error);
    }

    try {
      const response = await apiClient.get('/ai/config');
      config.value.apiBaseUrl = response.data?.apiBaseUrl || config.value.apiBaseUrl;
      config.value.model = response.data?.model || config.value.model;
      hasSavedApiKey.value = !!response.data?.hasApiKey;
      if (hasSavedApiKey.value) {
        config.value.apiKey = '';
      }
    } catch (error) {
      console.warn('[AI Terminal] Failed to load server config:', error);
    }
  };

  watch(config, () => {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(persistableConfig()));
  }, { deep: true });

  watch(sessionMemories, (next) => {
    persistMemories(next);
  }, { deep: true });

  void loadConfig();
  sessionMemories.value = loadStoredMemories();

  const getMemoryBySessionId = (sessionId?: string) => {
    const key = sessionId || 'global';
    if (!sessionMemories.value[key]) {
      sessionMemories.value[key] = createEmptyMemory();
    }
    return sessionMemories.value[key];
  };

  const findSessionById = (sessionId?: string): SessionState | null => {
    if (!sessionId) return null;
    const directMatch = sessionStore.sessions.get(sessionId);
    if (directMatch) return directMatch;
    return Array.from(sessionStore.sessions.values()).find(session => session.sessionId === sessionId) || null;
  };

  const getTargetSession = (sessionId?: string) => {
    if (!sessionId) return activeSession.value || null;
    const resolved = findSessionById(sessionId);
    if (resolved) return resolved;
    const current = activeSession.value;
    if (current && (sessionId === storeActiveSessionId.value || sessionId === current.sessionId)) return current;
    return null;
  };

  const readTerminalOutput = (sessionId?: string, maxLines = 120) => {
    let session = getTargetSession(sessionId);
    if (!sessionId && !session?.terminalManager?.terminalInstance?.value) {
      session = activeSession.value;
    }
    const term = session?.terminalManager?.terminalInstance?.value;

    if (!session || !term) {
      return {
        ok: false,
        sessionId: sessionId || activeSessionId.value,
        output: '',
        error: 'No active terminal is available. Open or switch to a terminal session and retry.',
      };
    }

    const buffer = term.buffer.active;
    const end = buffer.baseY + buffer.cursorY;
    const start = Math.max(0, end - Math.max(1, Math.min(Number(maxLines) || 120, 500)) + 1);
    const lines: string[] = [];

    for (let i = start; i <= end; i += 1) {
      const line = buffer.getLine(i);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }

    const output = lines.join('\n').trimEnd();

    return {
      ok: true,
      sessionId: session.sessionId,
      connectionName: session.connectionName,
      output: output.length > MAX_TERMINAL_OUTPUT_CHARS
        ? `...<terminal output truncated>\n${output.slice(-MAX_TERMINAL_OUTPUT_CHARS)}`
        : output,
    };
  };

  const sendTerminalInput = async (args: TerminalInputArgs, context: AiRunContext, options?: SendMessageOptions) => {
    if (context.runtime.stopRequested) {
      return { ok: false, cancelled: true, error: 'AI run was stopped before terminal input.' };
    }

    if (runMode.value === 'readOnly') {
      return { ok: false, cancelled: true, error: '当前是只读模式，AI 不会向终端发送输入。' };
    }

    const risk = detectRiskyCommand(args);
    let session = getTargetSession(args.sessionId);
    if (!args.sessionId && !session?.terminalManager?.terminalInstance?.value) {
      session = activeSession.value;
    }
    const command = normalizeCommand(String(args.text || ''));
    const needsConfirmation = runMode.value === 'confirm' || !!risk;
    if (needsConfirmation && options?.confirmCommand) {
      context.runtime.taskStatus = 'awaitingConfirmation';
      const confirmed = await options.confirmCommand({
        command,
        reason: String(args.reason || 'AI 需要执行这一步来继续处理当前任务。'),
        riskReason: risk?.reason,
        riskLevel: risk ? 'risky' : 'normal',
        sessionId: session?.sessionId || args.sessionId || activeSessionId.value,
        connectionName: session?.connectionName,
      });
      if (!confirmed) {
        return {
          ok: false,
          cancelled: true,
          risk,
          error: 'User rejected terminal command.',
        };
      }
    }

    if (context.runtime.stopRequested) {
      return { ok: false, cancelled: true, error: 'AI run was stopped before terminal input.' };
    }

    if (!session?.terminalManager?.sendData) {
      return {
        ok: false,
        sessionId: args.sessionId || activeSessionId.value,
        error: 'No active terminal is available.',
      };
    }

    const data = `${String(args.text || '')}${args.pressEnter ? '\r' : ''}`;
    session.terminalManager.sendData(data);

    const waitMs = Math.max(0, Math.min(Number(args.waitMs) || 900, 10000));
    if (waitMs > 0) {
      context.runtime.taskStatus = 'waitingOutput';
      await sleep(waitMs);
    }

    return {
      ok: true,
      sessionId: session.sessionId,
      sent: args.text,
      pressEnter: !!args.pressEnter,
      outputAfter: readTerminalOutput(session.sessionId, 120).output,
    };
  };

  const sendInterruptToTerminal = (sessionId?: string) => {
    const session = getTargetSession(sessionId);
    if (!session?.terminalManager?.sendData) {
      const runtime = getRuntimeBySessionId(sessionId || activeMemoryKey.value);
      runtime.errorMessage = '当前没有可中断的活动终端。';
      return false;
    }

    session.terminalManager.sendData('\x03');
    return true;
  };

  const runTool = async (toolCall: AiToolCall, context: AiRunContext, options?: SendMessageOptions) => {
    const parsedArgs = parseToolArgs(toolCall);
    const args: Record<string, any> = {
      ...parsedArgs,
      sessionId: context.sessionId,
    };
    const toolRun: AiToolRun = {
      id: toolCall.id,
      name: toolCall.function.name,
      args,
      status: 'running',
      startedAt: Date.now(),
    };
    context.memory.toolRuns.push(toolRun);

    try {
      if (context.runtime.stopRequested) {
        toolRun.status = 'cancelled';
        return { ok: false, cancelled: true, error: 'AI run was stopped before tool execution.' };
      }

      context.runtime.taskStatus = 'runningTool';
      let result: unknown;
      if (toolCall.function.name === 'get_terminal_output') {
        result = readTerminalOutput(args.sessionId, args.maxLines);
      } else if (toolCall.function.name === 'terminal_input') {
        result = await sendTerminalInput(args as TerminalInputArgs, context, options);
      } else {
        result = { ok: false, error: `Unknown tool: ${toolCall.function.name}` };
      }

      toolRun.result = result;
      toolRun.status = (result as any)?.cancelled ? 'cancelled' : 'done';
      return result;
    } catch (error: any) {
      toolRun.status = 'error';
      toolRun.error = error.message || String(error);
      return { ok: false, error: toolRun.error };
    } finally {
      toolRun.finishedAt = Date.now();
    }
  };

  const formatDataSize = (value?: number, unit: 'MB' | 'KB' = 'MB') => {
    if (value === undefined || value === null || Number.isNaN(value)) return 'unknown';
    if (unit === 'KB') {
      if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} GB`;
      if (value >= 1024) return `${(value / 1024).toFixed(0)} MB`;
      return `${value.toFixed(0)} KB`;
    }
    if (value >= 1024) return `${(value / 1024).toFixed(1)} GB`;
    return `${value.toFixed(0)} MB`;
  };

  const formatRate = (value?: number) => {
    if (value === undefined || value === null || Number.isNaN(value)) return 'unknown';
    if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB/s`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KB/s`;
    return `${value.toFixed(0)} B/s`;
  };

  const formatServerProfileForPrompt = (sessionId?: string) => {
    const status = getTargetSession(sessionId)?.statusMonitorManager?.serverStatus?.value;
    if (!status) {
      return 'Known terminal environment: no status monitor snapshot is available yet.';
    }
    return [
      'Known terminal environment from Nexus status monitor:',
      `- OS: ${status.osName || 'unknown'}`,
      `- CPU model: ${status.cpuModel || 'unknown'}`,
      `- CPU usage: ${status.cpuPercent ?? 'unknown'}%`,
      `- Memory: ${status.memPercent ?? 'unknown'}% (${formatDataSize(status.memUsed)} / ${formatDataSize(status.memTotal)})`,
      `- Swap: ${status.swapPercent ?? 'unknown'}% (${formatDataSize(status.swapUsed)} / ${formatDataSize(status.swapTotal)})`,
      `- Disk: ${status.diskPercent ?? 'unknown'}% (${formatDataSize(status.diskUsed, 'KB')} / ${formatDataSize(status.diskTotal, 'KB')})`,
      `- Network: ${status.netInterface || 'unknown'} down ${formatRate(status.netRxRate)}, up ${formatRate(status.netTxRate)}`,
      'Use this environment snapshot to choose OS-appropriate commands. If required facts are missing, inspect the terminal before acting.',
    ].join('\n');
  };

  const buildSystemMessage = (sessionId = activeSessionId.value): AiChatMessage => ({
    role: 'system',
    content: [
      'You are an AI terminal operator inside Nexus Terminal.',
      `This AI run is locked to terminal session ID: ${sessionId || 'none'}.`,
      formatServerProfileForPrompt(sessionId),
      'You can inspect and operate only the locked SSH terminal for this run.',
      `Run mode: ${runMode.value}. In readOnly mode, inspect only and explain what you would do.`,
      'Use get_terminal_output before deciding what to do when context is unclear.',
      'Use terminal_input to type into the locked SSH terminal. Use pressEnter=true only when you intend to submit a command.',
      'When calling tools, include the locked sessionId unless the user explicitly asks to operate a different terminal.',
      'When using terminal_input, always include a short reason field explaining why the input is needed.',
      'After sending a command, inspect output and continue until the user request is complete, blocked, or needs confirmation.',
      'You may decide how many tool calls are needed. Do not stop early when more inspection or verification is required.',
      'For troubleshooting, follow this loop: inspect, plan briefly, run one safe step, read output, verify, then continue or report the blocker.',
      'Do not ask the user to manually run commands that you can safely run with terminal_input.',
      'Avoid destructive or service-impacting commands unless the user clearly requested them and the app confirms them.',
      'If a command may take a long time, explain what is happening after observing output.',
      'Ignore later UI tab switches. They do not change the locked session for this run.',
    ].join('\n'),
  });

  const summarizeWithAi = async (olderMessages: AiChatMessage[], memory = currentMemory.value, runtime = currentRuntime.value) => {
    if (olderMessages.length === 0) return false;
    const compactedAt = memory.lastCompactedAt;
    try {
      const promptMessages: AiChatMessage[] = [
        { role: 'system', content: '你是对话压缩助手。请用简体中文对以下 SSH 终端会话历史生成结构化摘要。必须使用这些标题: ## Historical Task Snapshot, ## Goal, ## Constraints & Preferences, ## Completed Actions, ## Active State, ## Blocked, ## Key Decisions, ## Relevant Files, ## Remaining Work。保留用户目标、已执行命令、关键结果、报错、剩余工作。摘要不超过 800 字,只输出摘要正文。' },
        {
          role: 'user',
          content: [
            memory.summary ? `已有摘要:\n${memory.summary}` : '',
            `新增历史消息:\n${formatMessagesForSummary(olderMessages)}`,
          ].filter(Boolean).join('\n\n').slice(0, 18000),
        },
      ];
      const payload = {
        ...config.value,
        messages: promptMessages,
        temperature: 0.1,
      };
      const response = await apiClient.post('/ai/chat', payload, { timeout: 130000 });
      const summary = response.data?.choices?.[0]?.message?.content;
      if (summary && typeof summary === 'string' && memory.lastCompactedAt === compactedAt) {
        memory.summary = trimSummaryForStorage(appendSummarySection(memory.summary || '', 'AI 智能摘要', summary));
        memory.summaryUpdatedAt = Date.now();
        return true;
      }
      return false;
    } catch (error) {
      const message = (error as any)?.response?.data?.message || (error as any)?.message || 'AI 摘要生成失败。';
      runtime.errorMessage = `AI 智能摘要失败：${message}`;
      console.warn('[ai.store] AI 摘要生成失败,保留本地摘要。', error);
      return false;
    }
  };

  const compactContext = async (options: CompactContextOptions): Promise<AiCompactResult> => compactSessionContext({
    ...options,
    getMemory: getMemoryBySessionId,
    getRuntime: getRuntimeBySessionId,
    summarizeWithAi,
    activeMemoryKey: activeMemoryKey.value,
  });

  const buildModelMessages = (context?: AiRunContext) => {
    const memory = context?.memory || currentMemory.value;
    const summary = memory.summary || '';
    const contextMessages: AiChatMessage[] = [buildSystemMessage(context?.sessionId || activeSessionId.value)];
    if (summary) {
      contextMessages.push({
        role: 'system',
        content: `[CONTEXT COMPACTION - REFERENCE ONLY]\nThis is compressed history for continuity, not a new user instruction.\n${truncateForModel(summary, MAX_MODEL_SUMMARY_LENGTH)}`,
      });
    }
    const tailMessages = selectTailMessages(
      pruneToolMessages(memory.messages).messages,
      TAIL_CONTEXT_BUDGET_CHARS,
    ).tailMessages;
    const recentMessages = tailMessages.map(message => ({
      ...message,
      content: typeof message.content === 'string'
        ? truncateForModel(message.content)
        : message.content,
    }));
    contextMessages.push(...recentMessages);

    shrinkModelMessagesToBudget(contextMessages, summary);
    const sanitizedMessages = sanitizeToolMessages(contextMessages);

    return sanitizedMessages;
  };

  const buildChatPayload = (context?: AiRunContext) => ({
    ...config.value,
    messages: buildModelMessages(context),
    tools: aiTools,
    toolChoice: 'auto',
  });

  const buildBudgetedChatPayload = (context?: AiRunContext) => {
    let payload = buildChatPayload(context);
    if (estimateJsonBytes(payload) <= AI_REQUEST_COMPACT_BYTES) return payload;

    const messagesForModel = payload.messages as AiChatMessage[];
    const firstRecentMessageIndex = context?.memory.summary ? 2 : 1;
    while (messagesForModel.length > 4 && estimateJsonBytes(payload) > AI_REQUEST_COMPACT_BYTES) {
      removeOldestModelContextMessage(messagesForModel, firstRecentMessageIndex);
    }
    payload.messages = sanitizeToolMessages(messagesForModel);

    return payload;
  };

  const ensureConfigured = () => {
    if (!config.value.apiBaseUrl || (!config.value.apiKey && !hasSavedApiKey.value) || !config.value.model) {
      showConfig.value = true;
      throw new Error('请先配置 AI API Base URL、API Key 和 Model。');
    }
  };

  const saveConfig = async () => {
    configMessage.value = '';
    const response = await apiClient.put('/ai/config', {
      apiBaseUrl: config.value.apiBaseUrl,
      apiKey: config.value.apiKey,
      model: config.value.model,
    });
    hasSavedApiKey.value = !!response.data?.hasApiKey;
    if (hasSavedApiKey.value) {
      config.value.apiKey = '';
    }
    configMessage.value = 'AI 配置已保存。';
  };

  const testConfig = async () => {
    configMessage.value = '';
    const response = await apiClient.post('/ai/config/test', {
      apiBaseUrl: config.value.apiBaseUrl,
      apiKey: config.value.apiKey,
      model: config.value.model,
    });
    hasSavedApiKey.value = !!response.data?.hasApiKey;
    if (hasSavedApiKey.value) {
      config.value.apiKey = '';
    }
    configMessage.value = 'AI 配置测试通过。';
  };

  const runAgentLoop = async (context: AiRunContext, options?: SendMessageOptions) => {
    ensureConfigured();

    while (!context.runtime.stopRequested) {
      const controller = context.runtime.abortController;
      context.runtime.taskStatus = 'thinking';
      await compactContext({
        title: '本次压缩摘要',
        awaitAiSummary: false,
        sessionId: context.sessionId,
        runtime: context.runtime,
      });
      context.runtime.taskStatus = 'thinking';
      const response = await apiClient.post('/ai/chat', buildBudgetedChatPayload(context), {
        signal: controller?.signal,
        timeout: 130000,
      });

      if (context.runtime.stopRequested) break;

      const assistantMessage = response.data?.choices?.[0]?.message as AiChatMessage | undefined;
      if (!assistantMessage) {
        throw new Error('AI 返回格式无效。');
      }

      context.memory.messages.push(assistantMessage);
      const toolCalls = assistantMessage.tool_calls || [];
      if (toolCalls.length === 0) {
        context.runtime.taskStatus = 'done';
        return;
      }

      for (const toolCall of toolCalls) {
        if (context.runtime.stopRequested) break;
        const result = await runTool(toolCall, context, options);
        context.memory.messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: stringifyToolResultForModel(result),
        });
      }
    }
  };

  const sendMessage = async (options?: SendMessageOptions) => {
    const content = userInput.value.trim();
    const lockedSession = getTargetSession(activeSessionId.value);
    const runSessionId = lockedSession?.sessionId || activeSessionId.value || 'global';
    const runtime = getRuntimeBySessionId(runSessionId);
    if (!content || runtime.isRunning) return;

    runtime.errorMessage = '';
    userInput.value = '';
    const context: AiRunContext = {
      sessionId: runSessionId,
      memory: getMemoryBySessionId(runSessionId),
      runtime,
    };
    context.memory.messages.push({ role: 'user', content });
    runtime.isRunning = true;
    runtime.stopRequested = false;
    runtime.abortController = new AbortController();

    try {
      await runAgentLoop(context, options);
      if (runtime.stopRequested) {
        context.memory.messages.push({ role: 'assistant', content: '已停止本轮 AI 操作。' });
        runtime.taskStatus = 'stopped';
      }
    } catch (error: any) {
      if (error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError' || runtime.stopRequested) {
        context.memory.messages.push({ role: 'assistant', content: '已停止本轮 AI 操作。' });
        runtime.taskStatus = 'stopped';
      } else {
        runtime.errorMessage = error.response?.data?.message || error.message || 'AI 请求失败。';
        runtime.taskStatus = 'error';
      }
    } finally {
      runtime.isRunning = false;
      runtime.abortController = null;
      runtime.stopRequested = false;
      if (runtime.taskStatus === 'thinking' || runtime.taskStatus === 'runningTool' || runtime.taskStatus === 'waitingOutput') {
        runtime.taskStatus = 'idle';
      }
    }
  };

  const stopRun = (sessionId?: string) => {
    const runtime = getRuntimeBySessionId(sessionId || activeMemoryKey.value);
    if (!runtime.isRunning) return;
    runtime.stopRequested = true;
    runtime.abortController?.abort();
  };

  const clearChat = () => {
    currentMemory.value.messages = [];
    currentMemory.value.toolRuns = [];
    currentMemory.value.summary = '';
    currentMemory.value.summaryUpdatedAt = undefined;
    currentMemory.value.lastCompactedAt = undefined;
    errorMessage.value = '';
  };

  const compactContextNow = async (force = false): Promise<AiCompactResult> => {
    const result = await compactContext({
      force,
      title: '手动压缩摘要',
      awaitAiSummary: true,
      sessionId: activeMemoryKey.value,
      runtime: currentRuntime.value,
    });
    if (currentRuntime.value.taskStatus === 'compressing') {
      currentRuntime.value.taskStatus = 'idle';
    }
    return result;
  };

  return {
    userInput,
    isRunning,
    stopRequested,
    taskStatus,
    errorMessage,
    configMessage,
    hasSavedApiKey,
    showConfig,
    messages,
    visibleMessages,
    toolRuns,
    latestToolRuns,
    memorySummary,
    runMode,
    config,
    activeSession,
    activeSessionId,
    canSend,
    hasActiveTerminal,
    saveConfig,
    testConfig,
    sendMessage,
    stopRun,
    clearChat,
    compactContextNow,
    sendInterruptToTerminal,
    sessionRuntimes,
  };
});
