import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import apiClient from '../utils/apiClient';
import { useSessionStore } from './session.store';

export type AiChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type AiToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type AiChatMessage = {
  role: AiChatRole;
  content?: string | null;
  tool_calls?: AiToolCall[];
  tool_call_id?: string;
};

type TerminalInputArgs = {
  text: string;
  pressEnter?: boolean;
  sessionId?: string;
  waitMs?: number;
  reason?: string;
};

export type AiToolRunStatus = 'running' | 'done' | 'error' | 'cancelled';
export type AiRunMode = 'readOnly' | 'confirm' | 'auto';
export type AiTaskStatus = 'idle' | 'thinking' | 'awaitingConfirmation' | 'runningTool' | 'waitingOutput' | 'compressing' | 'done' | 'stopped' | 'error';

export type AiToolRun = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: AiToolRunStatus;
  startedAt: number;
  finishedAt?: number;
  result?: unknown;
  error?: string;
};

type RiskConfirmation = {
  command: string;
  reason: string;
};

export type CommandPreview = {
  command: string;
  reason: string;
  riskReason?: string;
  riskLevel: 'normal' | 'risky';
  sessionId: string;
  connectionName?: string;
};

type SendMessageOptions = {
  confirmCommand?: (preview: CommandPreview) => Promise<boolean>;
};

const CONFIG_KEY = 'nexus_ai_terminal_config';
const MEMORIES_KEY = 'nexus_ai_terminal_session_memories';
const LEGACY_MESSAGES_KEY = 'nexus_ai_terminal_messages';
const LEGACY_TOOL_RUNS_KEY = 'nexus_ai_terminal_tool_runs';
const MAX_SAVED_MESSAGES = 120;
const MAX_SAVED_TOOL_RUNS = 80;
const MAX_SAVED_CONTENT_LENGTH = 24000;
const MAX_MODEL_RECENT_MESSAGES = 16;
const COMPACT_MESSAGE_TRIGGER = 30;
const COMPACT_CHAR_TRIGGER = 32000;
const MAX_AI_REQUEST_BYTES = 256 * 1024;
const AI_REQUEST_COMPACT_BYTES = Math.floor(MAX_AI_REQUEST_BYTES * 0.8);
const MAX_MODEL_CONTEXT_CHARS = 90000;
const MAX_MODEL_MESSAGE_CONTENT_LENGTH = 8000;
const MAX_MODEL_SUMMARY_LENGTH = 8000;
const MAX_TERMINAL_OUTPUT_CHARS = 12000;
const MAX_TOOL_RESULT_CONTENT_LENGTH = 8000;

type AiSessionMemory = {
  messages: AiChatMessage[];
  toolRuns: AiToolRun[];
  summary: string;
  summaryUpdatedAt?: number;
  lastCompactedAt?: number;
};

const aiTools = [
  {
    type: 'function',
    function: {
      name: 'get_terminal_output',
      description: 'Read recent visible output from the active SSH terminal.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Optional target terminal session ID. Defaults to active session.' },
          maxLines: { type: 'number', description: 'Maximum lines to read. Default 120.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'terminal_input',
      description: 'Send text to the active SSH terminal immediately. Use pressEnter=true to submit a command.',
      parameters: {
        type: 'object',
        required: ['text'],
        properties: {
          sessionId: { type: 'string', description: 'Optional target terminal session ID. Defaults to active session.' },
          text: { type: 'string', description: 'Text or command to send to terminal.' },
          pressEnter: { type: 'boolean', description: 'Append Enter after text. Default false.' },
          waitMs: { type: 'number', description: 'Milliseconds to wait before reading output after input. Default 900.' },
          reason: { type: 'string', description: 'Short reason why this input is needed.' },
        },
      },
    },
  },
] as const;

const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));

const estimateJsonBytes = (value: unknown) => new Blob([JSON.stringify(value)]).size;

const normalizeMessagesForStorage = (items: AiChatMessage[]) => items
  .slice(-MAX_SAVED_MESSAGES)
  .map(message => ({
    ...message,
    content: typeof message.content === 'string'
      ? message.content.slice(0, MAX_SAVED_CONTENT_LENGTH)
      : message.content,
  }));

const normalizeToolRunsForStorage = (items: AiToolRun[]) => items.slice(-MAX_SAVED_TOOL_RUNS);

const stringifyToolResultForModel = (result: unknown) => {
  const content = JSON.stringify(result);
  if (content.length <= MAX_TOOL_RESULT_CONTENT_LENGTH) return content;
  return `${content.slice(0, MAX_TOOL_RESULT_CONTENT_LENGTH)}\n...<tool result truncated, ask get_terminal_output with narrower maxLines if needed>`;
};

const truncateForModel = (content: string, maxLength = MAX_MODEL_MESSAGE_CONTENT_LENGTH) => {
  if (content.length <= maxLength) return content;
  return `${content.slice(0, maxLength)}\n...<content truncated to keep the AI request small>`;
};

const createEmptyMemory = (): AiSessionMemory => ({
  messages: [],
  toolRuns: [],
  summary: '',
});

const normalizeMemoryForStorage = (memory: AiSessionMemory): AiSessionMemory => ({
  messages: normalizeMessagesForStorage(memory.messages || []),
  toolRuns: normalizeToolRunsForStorage(memory.toolRuns || []),
  summary: typeof memory.summary === 'string' ? memory.summary.slice(0, MAX_SAVED_CONTENT_LENGTH) : '',
  summaryUpdatedAt: memory.summaryUpdatedAt,
  lastCompactedAt: memory.lastCompactedAt,
});

const parseToolArgs = (toolCall: AiToolCall): Record<string, any> => {
  try {
    const parsed = JSON.parse(toolCall.function.arguments || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const normalizeCommand = (value: string) => value.trim().replace(/\s+/g, ' ');

const detectRiskyCommand = (args: TerminalInputArgs): RiskConfirmation | null => {
  if (!args.pressEnter) return null;

  const command = normalizeCommand(String(args.text || ''));
  if (!command) return null;

  const riskyPatterns: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /\brm\s+(-[^\s]*[rf][^\s]*|--recursive|--force)/i, reason: '删除文件或目录，且包含递归/强制参数' },
    { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: '会重启或关闭服务器' },
    { pattern: /\bmkfs(\.|$|\s)|\bdd\s+.*\bof=/i, reason: '可能格式化或直接写入磁盘设备' },
    { pattern: /\b(chmod|chown)\s+(-[^\s]*R[^\s]*|--recursive)\b/i, reason: '会递归修改权限或所有者' },
    { pattern: /\bapt(-get)?\s+(upgrade|dist-upgrade|full-upgrade|autoremove|remove|purge)\b/i, reason: '会修改系统软件包' },
    { pattern: /\byum\s+(update|remove|erase)|\bdnf\s+(upgrade|remove|erase)|\bpacman\s+-R/i, reason: '会修改系统软件包' },
    { pattern: /\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm|compose\s+down)\b/i, reason: '会删除或停止 Docker 资源' },
    { pattern: /\bsystemctl\s+(restart|stop|disable|mask)\b/i, reason: '会停止或重启系统服务' },
    { pattern: /\biptables\b|\bufw\s+(disable|reset|delete)|\bfirewall-cmd\b/i, reason: '会修改防火墙或网络访问规则' },
    { pattern: />\s*\/etc\/|tee\s+\/etc\/|\bsed\s+-i\b.*\/etc\//i, reason: '会修改系统配置文件' },
  ];

  const hit = riskyPatterns.find(item => item.pattern.test(command));
  return hit ? { command, reason: hit.reason } : null;
};

export const useAiStore = defineStore('ai', () => {
  const sessionStore = useSessionStore();

  const userInput = ref('');
  const isRunning = ref(false);
  const stopRequested = ref(false);
  const taskStatus = ref<AiTaskStatus>('idle');
  const errorMessage = ref('');
  const configMessage = ref('');
  const hasSavedApiKey = ref(false);
  const showConfig = ref(false);
  const sessionMemories = ref<Record<string, AiSessionMemory>>({});
  const abortController = ref<AbortController | null>(null);

  const config = ref({
    apiBaseUrl: '',
    apiKey: '',
    model: '',
    runMode: 'confirm' as AiRunMode,
  });

  const activeSession = computed(() => sessionStore.activeSession);
  const activeSessionId = computed(() => activeSession.value?.sessionId || '');
  const activeMemoryKey = computed(() => activeSessionId.value || 'global');
  const currentMemory = computed(() => {
    const key = activeMemoryKey.value;
    if (!sessionMemories.value[key]) {
      sessionMemories.value[key] = createEmptyMemory();
    }
    return sessionMemories.value[key];
  });
  const messages = computed(() => currentMemory.value.messages);
  const toolRuns = computed(() => currentMemory.value.toolRuns);
  const visibleMessages = computed(() => messages.value.filter(message => message.role !== 'tool'));
  const latestToolRuns = computed(() => toolRuns.value.slice(-20).reverse());
  const memorySummary = computed(() => currentMemory.value.summary);
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

  const loadMemories = () => {
    try {
      const raw = localStorage.getItem(MEMORIES_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          sessionMemories.value = Object.fromEntries(
            Object.entries(parsed).map(([key, value]) => [key, normalizeMemoryForStorage(value as AiSessionMemory)]),
          );
        }
      }
    } catch (error) {
      console.warn('[AI Terminal] Failed to load memories:', error);
    }

    if (Object.keys(sessionMemories.value).length > 0) return;

    try {
      const legacyMessages = JSON.parse(localStorage.getItem(LEGACY_MESSAGES_KEY) || '[]');
      const legacyToolRuns = JSON.parse(localStorage.getItem(LEGACY_TOOL_RUNS_KEY) || '[]');
      if (Array.isArray(legacyMessages) || Array.isArray(legacyToolRuns)) {
        sessionMemories.value.global = normalizeMemoryForStorage({
          messages: Array.isArray(legacyMessages) ? legacyMessages : [],
          toolRuns: Array.isArray(legacyToolRuns) ? legacyToolRuns : [],
          summary: '',
        });
        localStorage.removeItem(LEGACY_MESSAGES_KEY);
        localStorage.removeItem(LEGACY_TOOL_RUNS_KEY);
      }
    } catch (error) {
      console.warn('[AI Terminal] Failed to migrate legacy memories:', error);
    }
  };

  watch(config, () => {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(persistableConfig()));
  }, { deep: true });

  watch(sessionMemories, (next) => {
    const normalized = Object.fromEntries(
      Object.entries(next).map(([key, value]) => [key, normalizeMemoryForStorage(value)]),
    );
    localStorage.setItem(MEMORIES_KEY, JSON.stringify(normalized));
  }, { deep: true });

  void loadConfig();
  loadMemories();

  const getTargetSession = (sessionId?: string) => {
    if (sessionId) return sessionStore.sessions.get(sessionId) || null;
    return activeSession.value || null;
  };

  const readTerminalOutput = (sessionId?: string, maxLines = 120) => {
    const session = getTargetSession(sessionId);
    const term = session?.terminalManager?.terminalInstance?.value;

    if (!session || !term) {
      return {
        ok: false,
        sessionId: sessionId || activeSessionId.value,
        output: '',
        error: 'No active terminal is available.',
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

  const sendTerminalInput = async (args: TerminalInputArgs, options?: SendMessageOptions) => {
    if (stopRequested.value) {
      return { ok: false, cancelled: true, error: 'AI run was stopped before terminal input.' };
    }

    if (runMode.value === 'readOnly') {
      return { ok: false, cancelled: true, error: '当前是只读模式，AI 不会向终端发送输入。' };
    }

    const risk = detectRiskyCommand(args);
    const session = getTargetSession(args.sessionId);
    const command = normalizeCommand(String(args.text || ''));
    const needsConfirmation = runMode.value === 'confirm' || !!risk;
    if (needsConfirmation && options?.confirmCommand) {
      taskStatus.value = 'awaitingConfirmation';
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

    if (stopRequested.value) {
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
      taskStatus.value = 'waitingOutput';
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

  const sendInterruptToTerminal = () => {
    const session = activeSession.value;
    if (!session?.terminalManager?.sendData) {
      errorMessage.value = '当前没有可中断的活动终端。';
      return false;
    }

    session.terminalManager.sendData('\x03');
    return true;
  };

  const runTool = async (toolCall: AiToolCall, options?: SendMessageOptions) => {
    const args = parseToolArgs(toolCall);
    const toolRun: AiToolRun = {
      id: toolCall.id,
      name: toolCall.function.name,
      args,
      status: 'running',
      startedAt: Date.now(),
    };
    toolRuns.value.push(toolRun);

    try {
      if (stopRequested.value) {
        toolRun.status = 'cancelled';
        return { ok: false, cancelled: true, error: 'AI run was stopped before tool execution.' };
      }

      taskStatus.value = 'runningTool';
      let result: unknown;
      if (toolCall.function.name === 'get_terminal_output') {
        result = readTerminalOutput(args.sessionId, args.maxLines);
      } else if (toolCall.function.name === 'terminal_input') {
        result = await sendTerminalInput(args as TerminalInputArgs, options);
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

  const buildSystemMessage = (): AiChatMessage => ({
    role: 'system',
    content: [
      'You are an AI terminal operator inside Nexus Terminal.',
      'You can inspect the active terminal and operate it with tools.',
      `Run mode: ${runMode.value}. In readOnly mode, inspect only and explain what you would do.`,
      'Use get_terminal_output before deciding what to do when context is unclear.',
      'Use terminal_input to type into the active SSH terminal. Use pressEnter=true only when you intend to submit a command.',
      'When using terminal_input, always include a short reason field explaining why the input is needed.',
      'After sending a command, inspect output and continue until the user request is complete, blocked, or needs confirmation.',
      'You may decide how many tool calls are needed. Do not stop early when more inspection or verification is required.',
      'For troubleshooting, follow this loop: inspect, plan briefly, run one safe step, read output, verify, then continue or report the blocker.',
      'Do not ask the user to manually run commands that you can safely run with terminal_input.',
      'Avoid destructive or service-impacting commands unless the user clearly requested them and the app confirms them.',
      'If a command may take a long time, explain what is happening after observing output.',
      `Active session ID: ${activeSessionId.value || 'none'}.`,
    ].join('\n'),
  });

  const estimateMessageChars = (items: AiChatMessage[]) => items.reduce((total, message) => {
    const contentLength = typeof message.content === 'string' ? message.content.length : 0;
    const toolLength = message.tool_calls ? JSON.stringify(message.tool_calls).length : 0;
    return total + contentLength + toolLength;
  }, 0);

  const removeOldestModelContextMessage = (items: AiChatMessage[], startIndex: number) => {
    const [removed] = items.splice(startIndex, 1);
    const removedToolCallIds = new Set((removed?.tool_calls || []).map(call => call.id));

    for (let index = items.length - 1; index >= startIndex; index -= 1) {
      if (items[index].role === 'tool' && removedToolCallIds.has(String(items[index].tool_call_id || ''))) {
        items.splice(index, 1);
      }
    }

    while (items[startIndex]?.role === 'tool') {
      items.splice(startIndex, 1);
    }
  };

  const summarizeMessages = (items: AiChatMessage[]) => {
    const lines: string[] = [];
    for (const message of items) {
      if (message.role === 'user' && message.content) {
        lines.push(`用户目标: ${String(message.content).slice(0, 500)}`);
      } else if (message.role === 'assistant' && message.content) {
        lines.push(`AI 结论: ${String(message.content).slice(0, 700)}`);
      } else if (message.role === 'assistant' && message.tool_calls?.length) {
        const names = message.tool_calls.map(call => call.function.name).join(', ');
        lines.push(`AI 调用工具: ${names}`);
      } else if (message.role === 'tool' && message.content) {
        lines.push(`工具结果: ${String(message.content).slice(0, 700)}`);
      }
    }
    return lines.slice(-80).join('\n');
  };

  const compactContextIfNeeded = () => {
    const memory = currentMemory.value;
    const totalChars = estimateMessageChars(memory.messages);
    if (memory.messages.length <= COMPACT_MESSAGE_TRIGGER && totalChars <= COMPACT_CHAR_TRIGGER) return;

    taskStatus.value = 'compressing';
    const recentMessages = memory.messages.slice(-MAX_MODEL_RECENT_MESSAGES);
    const olderMessages = memory.messages.slice(0, -MAX_MODEL_RECENT_MESSAGES);
    const previousSummary = memory.summary ? `此前摘要:\n${memory.summary}\n\n` : '';
    memory.summary = `${previousSummary}本次压缩摘要:\n${summarizeMessages(olderMessages)}`.slice(-MAX_SAVED_CONTENT_LENGTH);
    memory.messages = recentMessages;
    memory.summaryUpdatedAt = Date.now();
    memory.lastCompactedAt = Date.now();
  };

  const shrinkModelMessagesToBudget = (items: AiChatMessage[]) => {
    const firstRecentMessageIndex = memorySummary.value ? 2 : 1;
    while (items.length > 6 && estimateMessageChars(items) > MAX_MODEL_CONTEXT_CHARS) {
      removeOldestModelContextMessage(items, firstRecentMessageIndex);
    }
  };

  const buildModelMessages = () => {
    compactContextIfNeeded();
    const contextMessages: AiChatMessage[] = [buildSystemMessage()];
    if (memorySummary.value) {
      contextMessages.push({
        role: 'system',
        content: `Memory summary for earlier conversation and terminal work:\n${truncateForModel(memorySummary.value, MAX_MODEL_SUMMARY_LENGTH)}`,
      });
    }
    const recentMessages = messages.value.slice(-MAX_MODEL_RECENT_MESSAGES).map(message => ({
      ...message,
      content: typeof message.content === 'string'
        ? truncateForModel(message.content)
        : message.content,
    }));
    contextMessages.push(...recentMessages);

    shrinkModelMessagesToBudget(contextMessages);

    return contextMessages;
  };

  const buildChatPayload = () => ({
    ...config.value,
    messages: buildModelMessages(),
    tools: aiTools,
    toolChoice: 'auto',
  });

  const buildBudgetedChatPayload = () => {
    let payload = buildChatPayload();
    if (estimateJsonBytes(payload) <= AI_REQUEST_COMPACT_BYTES) return payload;

    compactContextIfNeeded();
    compactContextNow();
    payload = buildChatPayload();

    const messagesForModel = payload.messages as AiChatMessage[];
    const firstRecentMessageIndex = memorySummary.value ? 2 : 1;
    while (messagesForModel.length > 4 && estimateJsonBytes(payload) > AI_REQUEST_COMPACT_BYTES) {
      removeOldestModelContextMessage(messagesForModel, firstRecentMessageIndex);
    }

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

  const runAgentLoop = async (options?: SendMessageOptions) => {
    ensureConfigured();

    while (!stopRequested.value) {
      const controller = abortController.value;
      taskStatus.value = 'thinking';
      const response = await apiClient.post('/ai/chat', buildBudgetedChatPayload(), {
        signal: controller?.signal,
        timeout: 130000,
      });

      if (stopRequested.value) break;

      const assistantMessage = response.data?.choices?.[0]?.message as AiChatMessage | undefined;
      if (!assistantMessage) {
        throw new Error('AI 返回格式无效。');
      }

      messages.value.push(assistantMessage);
      const toolCalls = assistantMessage.tool_calls || [];
      if (toolCalls.length === 0) {
        taskStatus.value = 'done';
        return;
      }

      for (const toolCall of toolCalls) {
        if (stopRequested.value) break;
        const result = await runTool(toolCall, options);
        messages.value.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: stringifyToolResultForModel(result),
        });
      }
    }
  };

  const sendMessage = async (options?: SendMessageOptions) => {
    const content = userInput.value.trim();
    if (!content || isRunning.value) return;

    errorMessage.value = '';
    userInput.value = '';
    messages.value.push({ role: 'user', content });
    isRunning.value = true;
    stopRequested.value = false;
    abortController.value = new AbortController();

    try {
      await runAgentLoop(options);
      if (stopRequested.value) {
        messages.value.push({ role: 'assistant', content: '已停止本轮 AI 操作。' });
        taskStatus.value = 'stopped';
      }
    } catch (error: any) {
      if (error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError' || stopRequested.value) {
        messages.value.push({ role: 'assistant', content: '已停止本轮 AI 操作。' });
        taskStatus.value = 'stopped';
      } else {
        errorMessage.value = error.response?.data?.message || error.message || 'AI 请求失败。';
        taskStatus.value = 'error';
      }
    } finally {
      isRunning.value = false;
      abortController.value = null;
      stopRequested.value = false;
      if (taskStatus.value === 'thinking' || taskStatus.value === 'runningTool' || taskStatus.value === 'waitingOutput') {
        taskStatus.value = 'idle';
      }
    }
  };

  const stopRun = () => {
    if (!isRunning.value) return;
    stopRequested.value = true;
    abortController.value?.abort();
  };

  const clearChat = () => {
    currentMemory.value.messages = [];
    currentMemory.value.toolRuns = [];
    currentMemory.value.summary = '';
    currentMemory.value.summaryUpdatedAt = undefined;
    currentMemory.value.lastCompactedAt = undefined;
    errorMessage.value = '';
  };

  const compactContextNow = () => {
    const memory = currentMemory.value;
    if (memory.messages.length <= MAX_MODEL_RECENT_MESSAGES) return false;

    const recentMessages = memory.messages.slice(-MAX_MODEL_RECENT_MESSAGES);
    const olderMessages = memory.messages.slice(0, -MAX_MODEL_RECENT_MESSAGES);
    const previousSummary = memory.summary ? `此前摘要:\n${memory.summary}\n\n` : '';
    memory.summary = `${previousSummary}手动压缩摘要:\n${summarizeMessages(olderMessages)}`.slice(-MAX_SAVED_CONTENT_LENGTH);
    memory.messages = recentMessages;
    memory.summaryUpdatedAt = Date.now();
    memory.lastCompactedAt = Date.now();
    return true;
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
  };
});
