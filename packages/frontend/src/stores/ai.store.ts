import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import apiClient from '../utils/apiClient';
import { useSessionStore } from './session.store';
import { useConnectionsStore } from './connections.store';
import {
  CONFIG_KEY,
  DEFAULT_AUTO_COMPACTS_PER_TASK,
  MAX_AUTO_COMPACTS_PER_TASK,
  MAX_CONFIGURABLE_AI_REQUEST_BYTES,
  MAX_IMPORT_FILE_BYTES,
  MAX_COMPACT_TRIGGER_PERCENT,
  MAX_MODEL_RECENT_MESSAGES,
  MAX_MODEL_SUMMARY_LENGTH,
  MAX_TERMINAL_OUTPUT_CHARS,
  MIN_AUTO_COMPACTS_PER_TASK,
  MIN_COMPACT_TRIGGER_PERCENT,
  MIN_AI_REQUEST_BYTES,
  TAIL_CONTEXT_BUDGET_CHARS,
} from './ai/ai.constants';
import {
  compactSessionContext,
  estimateJsonBytes,
  estimateMemoryRequestBytes,
  formatMessagesForSummary,
  pruneToolMessages,
  removeOldestModelContextMessage,
  sanitizeToolMessages,
  selectTailMessages,
  shrinkModelMessagesToBudget,
} from './ai/ai.compression';
import {
  createEmptyMemory,
  loadStoredMemories,
  mergeSummarySections,
  normalizeMemoryForStorage,
  persistMemories,
  trimSummaryForStorage,
} from './ai/ai.memory';
import {
  aiTools,
  detectRiskyCommand,
  normalizeCommand,
  parseToolArgs,
  stringifyToolResultForModel,
  summarizeToolResultContent,
  truncateForModel,
} from './ai/ai.tools';
import type {
  AiChatMessage,
  AiActivityEvent,
  AiCompactResult,
  AiRunContext,
  AiRunMode,
  AiRuntimeState,
  AiSessionExport,
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
  const connectionsStore = useConnectionsStore();

  const sessionInputs = ref<Record<string, string>>({});
  const configMessage = ref('');
  const hasSavedApiKey = ref(false);
  const showConfig = ref(false);
  const sessionMemories = ref<Record<string, AiSessionMemory>>({});
  const sessionRuntimes = ref<Record<string, AiRuntimeState>>({});
  const availableModels = ref<string[]>([]);
  const isFetchingModels = ref(false);
  const modelFetchMessage = ref('');
  const storageWarning = ref('');
  let memoryPersistTimer: ReturnType<typeof setTimeout> | null = null;

  const config = ref({
    apiBaseUrl: '',
    apiKey: '',
    model: '',
    runMode: 'confirm' as AiRunMode,
    compactTriggerPercent: 80,
    maxRequestKb: 256,
    maxAutoCompactsPerTask: DEFAULT_AUTO_COMPACTS_PER_TASK,
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
        activityEvents: [],
        continuationAvailable: false,
        autoCompactCount: 0,
      };
    } else if (typeof sessionRuntimes.value[key].autoCompactCount !== 'number') {
      sessionRuntimes.value[key].autoCompactCount = 0;
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
  const activeActivities = computed(() => currentRuntime.value.activityEvents);
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
  const continuationAvailable = computed(() => currentRuntime.value.continuationAvailable);

  const addActivity = (runtime: AiRuntimeState, title: string, detail?: string, state: AiActivityEvent['state'] = 'active') => {
    runtime.activityEvents.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      detail,
      state,
      createdAt: Date.now(),
    });
    if (runtime.activityEvents.length > 6) runtime.activityEvents.shift();
  };

  const isRetryableAiError = (error: any) => {
    const status = error?.response?.status;
    return !status || status === 408 || status === 409 || status === 429 || status >= 500;
  };

  const requestStreamedChat = async (context: AiRunContext, payload: Record<string, any>, signal?: AbortSignal) => {
    const response = await fetch('/api/v1/ai/chat', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ ...payload, stream: true }),
      signal,
    });
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok) {
      const body = await response.text();
      let message = body;
      try {
        message = JSON.parse(body)?.message || body;
      } catch {
        // Keep the provider response as the error message when it is not JSON.
      }
      const error: any = new Error(message || `AI 请求失败（${response.status}）。`);
      error.response = { status: response.status, data: { message } };
      throw error;
    }

    if (!contentType.includes('text/event-stream') || !response.body) {
      return response.json().then(data => ({
        message: data?.choices?.[0]?.message as AiChatMessage,
        finishReason: data?.choices?.[0]?.finish_reason,
        streamed: false,
      }));
    }

    const partialMessage: AiChatMessage = { role: 'assistant', content: '' };
    context.memory.messages.push(partialMessage);
    const toolCalls: AiToolCall[] = [];
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finishReason: string | undefined;
    let completed = false;

    const processLine = (line: string) => {
      if (!line.startsWith('data:')) return;
      const value = line.slice(5).trim();
      if (!value) return;
      if (value === '[DONE]') {
        completed = true;
        return;
      }
      const chunk = JSON.parse(value);
      const choice = chunk?.choices?.[0];
      const delta = choice?.delta;
      if (typeof delta?.content === 'string') partialMessage.content = `${partialMessage.content || ''}${delta.content}`;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (Array.isArray(delta?.tool_calls)) {
        delta.tool_calls.forEach((part: any) => {
          const index = Number(part.index || 0);
          if (!toolCalls[index]) {
            toolCalls[index] = {
              id: part.id || `stream-tool-${index}`,
              type: 'function',
              function: { name: '', arguments: '' },
            };
          }
          const target = toolCalls[index];
          if (part.id) target.id = part.id;
          if (part.function?.name) target.function.name += part.function.name;
          if (part.function?.arguments) target.function.arguments += part.function.arguments;
        });
        partialMessage.tool_calls = toolCalls.filter(Boolean);
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (value) {
          buffer += decoder.decode(value, { stream: !done });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';
          lines.forEach(processLine);
        }
        if (done) break;
      }
      if (buffer.trim()) processLine(buffer.trim());
      if (!completed && !finishReason) {
        const error: any = new Error('AI 流式输出中途断开。');
        error.partial = true;
        throw error;
      }
    } catch (error: any) {
      if ((partialMessage.content || partialMessage.tool_calls?.length) && !context.runtime.stopRequested) {
        error.partial = true;
        error.partialMessage = partialMessage;
      }
      throw error;
    }

    return { message: partialMessage, finishReason, streamed: true };
  };

  const requestChatCompletion = async (context: AiRunContext, payload: Record<string, any>, signal?: AbortSignal) => {
    try {
      return await requestStreamedChat(context, payload, signal);
    } catch (error: any) {
      const status = error?.response?.status;
      const streamUnsupported = [400, 404, 405, 415, 422].includes(status);
      if (error?.partial || !streamUnsupported) throw error;
      const { stream: _stream, ...normalPayload } = payload;
      const response = await apiClient.post('/ai/chat', normalPayload, { signal, timeout: 130000 });
      return {
        message: response.data?.choices?.[0]?.message as AiChatMessage,
        finishReason: response.data?.choices?.[0]?.finish_reason,
        streamed: false,
      };
    }
  };

  const persistableConfig = () => ({
    apiBaseUrl: config.value.apiBaseUrl,
    model: config.value.model,
    runMode: config.value.runMode,
    compactTriggerPercent: Math.min(
      MAX_COMPACT_TRIGGER_PERCENT,
      Math.max(MIN_COMPACT_TRIGGER_PERCENT, Number(config.value.compactTriggerPercent) || 80),
    ),
    maxRequestKb: Math.round(Math.min(
      MAX_CONFIGURABLE_AI_REQUEST_BYTES / 1024,
      Math.max(MIN_AI_REQUEST_BYTES / 1024, Number(config.value.maxRequestKb) || 256),
    )),
    maxAutoCompactsPerTask: Math.round(Math.min(
      MAX_AUTO_COMPACTS_PER_TASK,
      Math.max(MIN_AUTO_COMPACTS_PER_TASK, Number(config.value.maxAutoCompactsPerTask) || DEFAULT_AUTO_COMPACTS_PER_TASK),
    )),
  });

  const maxRequestBytes = computed(() => Math.round(Math.min(
    MAX_CONFIGURABLE_AI_REQUEST_BYTES,
    Math.max(MIN_AI_REQUEST_BYTES, (Number(config.value.maxRequestKb) || 256) * 1024),
  )));

  const compactTriggerBytes = computed(() => Math.floor(
    maxRequestBytes.value * Math.min(
      MAX_COMPACT_TRIGGER_PERCENT,
      Math.max(MIN_COMPACT_TRIGGER_PERCENT, Number(config.value.compactTriggerPercent) || 80),
    ) / 100,
  ));

  const maxAutoCompactsPerTask = computed(() => Math.round(Math.min(
    MAX_AUTO_COMPACTS_PER_TASK,
    Math.max(MIN_AUTO_COMPACTS_PER_TASK, Number(config.value.maxAutoCompactsPerTask) || DEFAULT_AUTO_COMPACTS_PER_TASK),
  )));

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
    if (memoryPersistTimer) return;
    memoryPersistTimer = setTimeout(() => {
      memoryPersistTimer = null;
      const result = persistMemories(next, activeMemoryKey.value);
      storageWarning.value = result.ok
        ? result.droppedSessionCount > 0 ? `本地存储空间有限，已移除 ${result.droppedSessionCount} 个最旧 AI 会话。` : ''
        : 'AI 历史保存失败，本地存储空间可能已满。请先导出会话后删除旧历史。';
    }, 300);
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
      addActivity(context.runtime, '等待你确认终端命令');
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
      addActivity(context.runtime, '命令已发送，正在等待终端输出');
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
      if (toolCall.function.name === 'terminal_input' && (typeof parsedArgs.text !== 'string' || !parsedArgs.text.trim())) {
        toolRun.status = 'error';
        toolRun.error = 'AI 返回的终端输入参数不完整，已阻止执行。';
        addActivity(context.runtime, '工具参数不完整，已阻止执行', toolRun.error, 'error');
        return { ok: false, error: toolRun.error };
      }
      if (context.runtime.stopRequested) {
        toolRun.status = 'cancelled';
        return { ok: false, cancelled: true, error: 'AI run was stopped before tool execution.' };
      }

      context.runtime.taskStatus = 'runningTool';
      addActivity(
        context.runtime,
        toolCall.function.name === 'get_terminal_output' ? '正在读取当前终端输出' : '正在准备发送终端命令',
        toolCall.function.name === 'get_terminal_output' ? `读取最近 ${args.maxLines || 120} 行` : undefined,
      );
      let result: unknown;
      if (toolCall.function.name === 'get_terminal_output') {
        result = readTerminalOutput(args.sessionId, args.maxLines);
      } else if (toolCall.function.name === 'terminal_input') {
        result = await sendTerminalInput(args as TerminalInputArgs, context, options);
      } else {
        result = { ok: false, error: `Unknown tool: ${toolCall.function.name}` };
      }

      toolRun.result = result;
      toolRun.status = (result as any)?.cancelled
        ? 'cancelled'
        : (result as any)?.ok === false
          ? 'error'
          : 'done';
      if (toolRun.status === 'error') toolRun.error = String((result as any)?.error || '工具调用失败。');
      if (toolRun.status === 'done') {
        addActivity(
          context.runtime,
          toolCall.function.name === 'get_terminal_output' ? '终端输出已读取，正在分析' : '命令已发送，正在读取结果',
          undefined,
          'done',
        );
      } else if (toolRun.status === 'error') {
        addActivity(context.runtime, '工具调用失败', toolRun.error, 'error');
      }
      return result;
    } catch (error: any) {
      toolRun.status = 'error';
      toolRun.error = error.message || String(error);
      addActivity(context.runtime, '工具调用失败', toolRun.error, 'error');
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
        memory.summary = trimSummaryForStorage(mergeSummarySections(memory.summary, summary));
        memory.summaryUpdatedAt = Date.now();
        if (memory.compression) {
          memory.compression.summaryMode = 'ai';
          memory.compression.afterBytes = estimateJsonBytes({
            messages: memory.messages,
            summary: memory.summary,
            tools: aiTools,
          });
          memory.compression.at = Date.now();
        }
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
    compactTriggerBytes: compactTriggerBytes.value,
    maxRequestBytes: maxRequestBytes.value,
  });

  const buildModelMessages = (context?: AiRunContext, extraMessages: AiChatMessage[] = []) => {
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
    contextMessages.push(...extraMessages);

    shrinkModelMessagesToBudget(contextMessages, summary);
    const sanitizedMessages = sanitizeToolMessages(contextMessages);

    return sanitizedMessages;
  };

  const buildChatPayload = (context?: AiRunContext, extraMessages: AiChatMessage[] = []) => ({
    ...config.value,
    stream: true,
    messages: buildModelMessages(context, extraMessages),
    tools: aiTools,
    toolChoice: 'auto',
  });

  const buildBudgetedChatPayload = (context?: AiRunContext, extraMessages: AiChatMessage[] = []) => {
    let payload = buildChatPayload(context, extraMessages);
    const initialBytes = estimateJsonBytes(payload);
    if (initialBytes <= maxRequestBytes.value) {
      if (context?.memory.compression) context.memory.compression.afterBytes = initialBytes;
      return payload;
    }

    const messagesForModel = payload.messages as AiChatMessage[];
    const firstRecentMessageIndex = context?.memory.summary ? 2 : 1;
    while (messagesForModel.length > 4 && estimateJsonBytes(payload) > maxRequestBytes.value) {
      removeOldestModelContextMessage(messagesForModel, firstRecentMessageIndex);
    }
    payload.messages = sanitizeToolMessages(messagesForModel);

    if (estimateJsonBytes(payload) > maxRequestBytes.value) {
      for (const message of payload.messages as AiChatMessage[]) {
        // Only shrink free-form content. Tool arguments must stay unmodified JSON.
        if (message.role !== 'tool' && typeof message.content === 'string' && message.content.length > 1200) {
          message.content = `${message.content.slice(-1200)}\n...<message truncated>`;
        }
        if (message.role === 'tool' && typeof message.content === 'string' && message.content.length > 2400) {
          message.content = summarizeToolResultContent(message.content);
        }
      }
      payload.messages = sanitizeToolMessages(payload.messages as AiChatMessage[]);
    }

    const finalBytes = estimateJsonBytes(payload);
    if (finalBytes > maxRequestBytes.value) {
      throw new Error(`AI 请求仍超过 ${Math.ceil(maxRequestBytes.value / 1024)}KB 上限（当前约 ${Math.ceil(finalBytes / 1024)}KB），已阻止发送。请先压缩上下文或删除历史会话。`);
    }

    if (context?.memory.compression) context.memory.compression.afterBytes = finalBytes;

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

  const testStreaming = async () => {
    configMessage.value = '';
    const response = await apiClient.post('/ai/config/test-streaming', {
      apiBaseUrl: config.value.apiBaseUrl,
      apiKey: config.value.apiKey,
      model: config.value.model,
    });
    configMessage.value = response.data?.message || '流式输出测试通过。';
  };

  const fetchModels = async () => {
    isFetchingModels.value = true;
    modelFetchMessage.value = '';
    try {
      const response = await apiClient.post('/ai/config/models', {
        apiBaseUrl: config.value.apiBaseUrl,
        apiKey: config.value.apiKey,
      });
      availableModels.value = Array.isArray(response.data?.models) ? response.data.models : [];
      modelFetchMessage.value = availableModels.value.length > 0
        ? `已获取 ${availableModels.value.length} 个模型。`
        : '服务商没有返回可用模型。';
    } catch (error: any) {
      availableModels.value = [];
      modelFetchMessage.value = error.response?.data?.message || error.message || '获取模型列表失败。';
    } finally {
      isFetchingModels.value = false;
    }
  };

  const maybeAutoCompact = async (context: AiRunContext, reason: 'beforeRequest' | 'afterTool') => {
    if (context.runtime.autoCompactCount >= maxAutoCompactsPerTask.value) {
      return {
        compacted: false,
        reason: 'underBudget' as const,
        requestBytes: estimateMemoryRequestBytes(context.memory),
        thresholdBytes: compactTriggerBytes.value,
        finalRequestBytes: estimateMemoryRequestBytes(context.memory),
        hardLimitBytes: maxRequestBytes.value,
      };
    }

    if (reason === 'beforeRequest') {
      addActivity(context.runtime, '正在检查上下文体积');
    } else {
      addActivity(context.runtime, '工具结果后检查上下文体积');
    }

    const result = await compactContext({
      title: reason === 'afterTool' ? '工具结果后压缩摘要' : '本次压缩摘要',
      awaitAiSummary: false,
      sessionId: context.sessionId,
      runtime: context.runtime,
    });

    if (result.compacted && result.reason === 'compacted') {
      context.runtime.autoCompactCount += 1;
      addActivity(
        context.runtime,
        reason === 'afterTool' ? '工具结果后已压缩上下文' : '发送前已压缩上下文',
        `体积 ${Math.ceil((result.requestBytes || 0) / 1024)}KB → ${Math.ceil((result.finalRequestBytes || 0) / 1024)}KB · 本轮 ${context.runtime.autoCompactCount}/${maxAutoCompactsPerTask.value}`,
        'done',
      );
    }

    return result;
  };

  const runAgentLoop = async (context: AiRunContext, options?: SendMessageOptions, continuation = false) => {
    ensureConfigured();

    // One size-based check before the first model request of this user task.
    await maybeAutoCompact(context, 'beforeRequest');

    while (!context.runtime.stopRequested) {
      const controller = context.runtime.abortController;
      context.runtime.taskStatus = 'thinking';
      addActivity(context.runtime, '正在请求 AI 决定下一步操作');
      const continuationMessages: AiChatMessage[] = continuation
        ? [{
          role: 'user',
          content: '请从上一条 AI 回复被截断的位置继续输出。不要重复已经输出的内容，只输出后续内容；如果下一步需要工具调用，请完整返回工具调用参数。',
        }]
        : [];
      let response;
      for (let attempt = 0; attempt <= 2; attempt += 1) {
        try {
          response = await requestChatCompletion(context, buildBudgetedChatPayload(context, continuationMessages), controller?.signal);
          break;
        } catch (error: any) {
          if (error?.partial) {
            const partial = error.partialMessage as AiChatMessage | undefined;
            const last = context.memory.messages[context.memory.messages.length - 1];
            if (continuation && partial && last === partial) {
              context.memory.messages.pop();
              const previous = context.memory.messages[context.memory.messages.length - 1];
              if (previous?.role === 'assistant') {
                previous.content = `${previous.content || ''}${previous.content && partial.content ? '\n' : ''}${partial.content || ''}`;
                if (partial.tool_calls?.length) previous.tool_calls = partial.tool_calls;
              }
            }
            context.runtime.continuationAvailable = true;
            context.runtime.errorMessage = 'AI 流式输出中途断开，已保存当前已收到的内容。';
            context.runtime.taskStatus = 'interrupted';
            addActivity(context.runtime, 'AI 流式输出中断，可继续生成', '已保存当前已收到的内容', 'error');
            return;
          }
          if (context.runtime.stopRequested || !isRetryableAiError(error) || attempt === 2) throw error;
          const retryNumber = attempt + 1;
          addActivity(context.runtime, `AI 请求中断，正在自动重试（${retryNumber}/2）`, error.message || '网络连接中断');
          await sleep(700 * retryNumber);
        }
      }

      if (context.runtime.stopRequested) break;

      const assistantMessage = response?.message as AiChatMessage | undefined;
      if (!assistantMessage) {
        throw new Error('AI 返回格式无效。');
      }

      const finishReason = response?.finishReason;
      const wasTruncated = finishReason === 'length' || finishReason === 'max_tokens';
      let previous = context.memory.messages[context.memory.messages.length - 1];
      if (response?.streamed && continuation && previous === assistantMessage) {
        context.memory.messages.pop();
        previous = context.memory.messages[context.memory.messages.length - 1];
      }
      if (response?.streamed && continuation && previous?.role === 'assistant') {
        previous.content = `${previous.content || ''}${previous.content ? '\n' : ''}${assistantMessage.content}`;
        if (assistantMessage.tool_calls?.length) previous.tool_calls = assistantMessage.tool_calls;
      } else if (!response?.streamed && continuation && assistantMessage.content && previous?.role === 'assistant') {
        previous.content = `${previous.content || ''}${previous.content ? '\n' : ''}${assistantMessage.content}`;
        if (assistantMessage.tool_calls?.length) previous.tool_calls = assistantMessage.tool_calls;
      } else if (!response?.streamed) {
        context.memory.messages.push(assistantMessage);
      }
      const toolCalls = assistantMessage.tool_calls || [];
      continuation = false;
      if (wasTruncated) {
        context.runtime.continuationAvailable = true;
        context.runtime.errorMessage = 'AI 输出达到模型上限，内容被截断。';
        context.runtime.taskStatus = 'interrupted';
        addActivity(
          context.runtime,
          toolCalls.length > 0 ? '工具调用参数未完整返回，已阻止执行' : 'AI 输出被截断，可继续生成',
          '已保存当前已收到的内容，请继续生成后再执行后续操作',
          'error',
        );
        return;
      }
      context.runtime.continuationAvailable = false;
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

      // Allow one more compaction if tool output re-inflated the request body.
      if (!context.runtime.stopRequested) {
        await maybeAutoCompact(context, 'afterTool');
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
    runtime.continuationAvailable = false;
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
    runtime.activityEvents = [];
    runtime.autoCompactCount = 0;
    addActivity(runtime, '正在理解你的请求');

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
      runtime.activityEvents = [];
      if (runtime.taskStatus === 'thinking' || runtime.taskStatus === 'runningTool' || runtime.taskStatus === 'waitingOutput') {
        runtime.taskStatus = 'idle';
      }
    }
  };

  const continueLastResponse = async (options?: SendMessageOptions) => {
    const runSessionId = activeSessionId.value || 'global';
    const runtime = getRuntimeBySessionId(runSessionId);
    if (runtime.isRunning || !runtime.continuationAvailable) return;
    const context: AiRunContext = {
      sessionId: runSessionId,
      memory: getMemoryBySessionId(runSessionId),
      runtime,
    };
    runtime.isRunning = true;
    runtime.stopRequested = false;
    runtime.errorMessage = '';
    runtime.continuationAvailable = false;
    runtime.abortController = new AbortController();
    runtime.activityEvents = [];
    runtime.autoCompactCount = 0;
    addActivity(runtime, '正在从中断位置继续生成');
    try {
      await runAgentLoop(context, options, true);
    } catch (error: any) {
      if (error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError' || runtime.stopRequested) {
        runtime.taskStatus = 'stopped';
      } else {
        runtime.errorMessage = error.response?.data?.message || error.message || '继续生成失败。';
        runtime.taskStatus = 'error';
      }
    } finally {
      runtime.isRunning = false;
      runtime.abortController = null;
      runtime.stopRequested = false;
      runtime.activityEvents = [];
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

  watch(() => sessionStore.sessionTabsWithStatus, (tabs) => {
    tabs.forEach(tab => {
      if (tab.status !== 'disconnected' && tab.status !== 'error') return;
      const runtime = sessionRuntimes.value[tab.sessionId];
      if (!runtime?.isRunning) return;
      stopRun(tab.sessionId);
      runtime.errorMessage = '终端连接已断开，AI 任务已停止。';
      runtime.taskStatus = 'error';
    });
  }, { deep: true });

  const clearChat = () => {
    if (currentRuntime.value.isRunning) return;
    currentMemory.value.messages = [];
    currentMemory.value.toolRuns = [];
    currentMemory.value.summary = '';
    currentMemory.value.summaryUpdatedAt = undefined;
    currentMemory.value.lastCompactedAt = undefined;
    currentMemory.value.compression = undefined;
    currentRuntime.value.continuationAvailable = false;
    errorMessage.value = '';
  };

  const getConnectionIdentity = (sessionId: string) => {
    const session = getTargetSession(sessionId);
    const connection = session
      ? connectionsStore.connections.find(item => String(item.id) === String(session.connectionId))
      : undefined;
    if (!session || !connection?.host) throw new Error('当前终端连接信息不完整，无法导出 AI 会话。');
    return {
      name: session.connectionName.trim(),
      host: String(connection.host).trim().toLowerCase(),
      port: String(connection.port || 22),
    };
  };

  const checkSessionImport = (data: unknown) => {
    const payload = data as Partial<AiSessionExport>;
    if (payload.format !== 'nexus-terminal-ai-session' || payload.version !== 3 || !payload.connection) {
      throw new Error('不是新版 Nexus Terminal AI 会话文件，或文件版本不受支持。');
    }
    const current = getConnectionIdentity(activeMemoryKey.value);
    const imported = {
      name: String(payload.connection.name || '').trim(),
      host: String(payload.connection.host || '').trim().toLowerCase(),
      port: String(payload.connection.port || ''),
    };
    if (!imported.host || !imported.port) throw new Error('会话文件缺少终端地址或端口。');
    if (current.host !== imported.host || current.port !== imported.port) {
      return {
        compatible: false,
        nameMismatch: false,
        message: `会话目标是 ${imported.host}:${imported.port}，当前终端是 ${current.host}:${current.port}，为避免串台已拒绝导入。`,
      };
    }
    if (current.name !== imported.name) {
      return {
        compatible: true,
        nameMismatch: true,
        message: `名称不同：导出会话为「${imported.name}」，当前终端为「${current.name}」，但 IP 和端口一致。`,
      };
    }
    return { compatible: true, nameMismatch: false, message: '' };
  };

  const exportSessionData = (sessionId = activeMemoryKey.value): AiSessionExport => {
    const memory = getMemoryBySessionId(sessionId);
    const session = getTargetSession(sessionId);
    const connection = getConnectionIdentity(sessionId);
    return {
      format: 'nexus-terminal-ai-session',
      version: 3,
      exportedAt: new Date().toISOString(),
      sessionId,
      connectionName: session?.connectionName || '未命名终端',
      connection,
      memory: normalizeMemoryForStorage(JSON.parse(JSON.stringify(memory)) as AiSessionMemory),
    };
  };

  const importSessionData = (data: unknown, mode: 'replace' | 'merge' = 'replace', allowNameMismatch = false) => {
    if (currentRuntime.value.isRunning) throw new Error('AI 正在运行，请先停止当前任务后再导入会话。');
    if (!data || typeof data !== 'object') throw new Error('导入文件格式无效。');
    const payload = data as Partial<AiSessionExport>;
    if (payload.format !== 'nexus-terminal-ai-session' || payload.version !== 3 || !payload.memory || !payload.connection) {
      throw new Error('不是 Nexus Terminal AI 会话文件，或文件版本不受支持。');
    }
    const compatibility = checkSessionImport(payload);
    if (!compatibility.compatible || (compatibility.nameMismatch && !allowNameMismatch)) throw new Error(compatibility.message || '会话与当前终端不匹配。');
    if (!Array.isArray(payload.memory.messages) || !Array.isArray(payload.memory.toolRuns)) {
      throw new Error('会话文件缺少有效的消息或工具记录。');
    }
    if (payload.memory.messages.length > 120 || payload.memory.toolRuns.length > 80) {
      throw new Error('会话文件包含过多记录，请先在原客户端压缩或导出较小的会话。');
    }
    const validRoles = new Set(['system', 'user', 'assistant', 'tool']);
    for (const message of payload.memory.messages) {
      if (!message || typeof message !== 'object' || !validRoles.has(message.role)) {
        throw new Error('会话文件包含无效的消息角色。');
      }
      if (message.content !== undefined && message.content !== null && typeof message.content !== 'string') {
        throw new Error('会话文件包含无效的消息内容。');
      }
      if (message.tool_calls && (!Array.isArray(message.tool_calls) || message.tool_calls.some(call => (
        !call || typeof call.id !== 'string' || call.type !== 'function'
        || !call.function || typeof call.function.name !== 'string' || typeof call.function.arguments !== 'string'
      )))) {
        throw new Error('会话文件包含无效的工具调用结构。');
      }
    }
    const validToolStatuses = new Set(['running', 'done', 'error', 'cancelled']);
    for (const run of payload.memory.toolRuns) {
      if (!run || typeof run !== 'object' || typeof run.id !== 'string' || typeof run.name !== 'string'
        || !validToolStatuses.has(run.status) || !run.args || typeof run.args !== 'object'
        || typeof run.startedAt !== 'number' || !Number.isFinite(run.startedAt)) {
        throw new Error('会话文件包含无效的工具记录。');
      }
    }
    const imported = normalizeMemoryForStorage(payload.memory);

    if (mode === 'merge') {
      const current = currentMemory.value;
      current.messages = normalizeMemoryForStorage({
        ...current,
        messages: [...current.messages, ...imported.messages],
        toolRuns: [...current.toolRuns, ...imported.toolRuns],
        summary: mergeSummarySections(current.summary, imported.summary),
      }).messages;
      current.toolRuns = normalizeMemoryForStorage({ ...current, toolRuns: [...current.toolRuns, ...imported.toolRuns] }).toolRuns;
      current.summary = mergeSummarySections(current.summary, imported.summary);
      current.summaryUpdatedAt = imported.summaryUpdatedAt || current.summaryUpdatedAt;
      current.compression = imported.compression || current.compression;
    } else {
      sessionMemories.value[activeMemoryKey.value] = imported;
    }
    return {
      messageCount: imported.messages.length,
      toolRunCount: imported.toolRuns.length,
    };
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
    activeActivities,
    storageWarning,
    memorySummary,
    compression: computed(() => currentMemory.value.compression),
    compactTriggerPercent: computed(() => Math.min(
      MAX_COMPACT_TRIGGER_PERCENT,
      Math.max(MIN_COMPACT_TRIGGER_PERCENT, Number(config.value.compactTriggerPercent) || 80),
    )),
    maxRequestKb: computed(() => Math.round(maxRequestBytes.value / 1024)),
    maxAutoCompactsPerTask,
    runMode,
    config,
    activeSession,
    activeSessionId,
    canSend,
    hasActiveTerminal,
    saveConfig,
    testConfig,
    testStreaming,
    fetchModels,
    availableModels,
    isFetchingModels,
    modelFetchMessage,
    sendMessage,
    stopRun,
    clearChat,
    continueLastResponse,
    continuationAvailable,
    exportSessionData,
    importSessionData,
    checkSessionImport,
    compactContextNow,
    sendInterruptToTerminal,
    sessionRuntimes,
  };
});
