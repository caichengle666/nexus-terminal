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
};

export type AiToolRunStatus = 'running' | 'done' | 'error' | 'cancelled';

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

type SendMessageOptions = {
  confirmRiskCommand?: (risk: RiskConfirmation) => Promise<boolean>;
};

const CONFIG_KEY = 'nexus_ai_terminal_config';
const MESSAGES_KEY = 'nexus_ai_terminal_messages';
const TOOL_RUNS_KEY = 'nexus_ai_terminal_tool_runs';
const MAX_SAVED_MESSAGES = 120;
const MAX_SAVED_TOOL_RUNS = 80;
const MAX_SAVED_CONTENT_LENGTH = 24000;

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
        },
      },
    },
  },
] as const;

const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));

const normalizeMessagesForStorage = (items: AiChatMessage[]) => items
  .slice(-MAX_SAVED_MESSAGES)
  .map(message => ({
    ...message,
    content: typeof message.content === 'string'
      ? message.content.slice(0, MAX_SAVED_CONTENT_LENGTH)
      : message.content,
  }));

const normalizeToolRunsForStorage = (items: AiToolRun[]) => items.slice(-MAX_SAVED_TOOL_RUNS);

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
  const errorMessage = ref('');
  const showConfig = ref(false);
  const messages = ref<AiChatMessage[]>([]);
  const toolRuns = ref<AiToolRun[]>([]);
  const abortController = ref<AbortController | null>(null);

  const config = ref({
    apiBaseUrl: '',
    apiKey: '',
    model: '',
  });

  const activeSession = computed(() => sessionStore.activeSession);
  const activeSessionId = computed(() => activeSession.value?.sessionId || '');
  const visibleMessages = computed(() => messages.value.filter(message => message.role !== 'tool'));
  const latestToolRuns = computed(() => toolRuns.value.slice(-20).reverse());
  const canSend = computed(() => !!userInput.value.trim() && !isRunning.value);
  const hasActiveTerminal = computed(() => !!activeSession.value?.terminalManager?.terminalInstance?.value);

  const loadConfig = () => {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      if (raw) {
        config.value = { ...config.value, ...JSON.parse(raw) };
      }
    } catch (error) {
      console.warn('[AI Terminal] Failed to load config:', error);
    }
  };

  const loadMessages = () => {
    try {
      const raw = localStorage.getItem(MESSAGES_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          messages.value = normalizeMessagesForStorage(parsed);
        }
      }
    } catch (error) {
      console.warn('[AI Terminal] Failed to load messages:', error);
    }
  };

  const loadToolRuns = () => {
    try {
      const raw = localStorage.getItem(TOOL_RUNS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          toolRuns.value = normalizeToolRunsForStorage(parsed);
        }
      }
    } catch (error) {
      console.warn('[AI Terminal] Failed to load tool runs:', error);
    }
  };

  watch(config, (next) => {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
  }, { deep: true });

  watch(messages, (next) => {
    localStorage.setItem(MESSAGES_KEY, JSON.stringify(normalizeMessagesForStorage(next)));
  }, { deep: true });

  watch(toolRuns, (next) => {
    localStorage.setItem(TOOL_RUNS_KEY, JSON.stringify(normalizeToolRunsForStorage(next)));
  }, { deep: true });

  loadConfig();
  loadMessages();
  loadToolRuns();

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

    return {
      ok: true,
      sessionId: session.sessionId,
      connectionName: session.connectionName,
      output: lines.join('\n').trimEnd(),
    };
  };

  const sendTerminalInput = async (args: TerminalInputArgs, options?: SendMessageOptions) => {
    if (stopRequested.value) {
      return { ok: false, cancelled: true, error: 'AI run was stopped before terminal input.' };
    }

    const risk = detectRiskyCommand(args);
    if (risk && options?.confirmRiskCommand) {
      const confirmed = await options.confirmRiskCommand(risk);
      if (!confirmed) {
        return {
          ok: false,
          cancelled: true,
          risk,
          error: 'User rejected risky terminal command.',
        };
      }
    }

    if (stopRequested.value) {
      return { ok: false, cancelled: true, error: 'AI run was stopped before terminal input.' };
    }

    const session = getTargetSession(args.sessionId);
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
      'Use get_terminal_output before deciding what to do when context is unclear.',
      'Use terminal_input to type into the active SSH terminal. Use pressEnter=true only when you intend to submit a command.',
      'After sending a command, inspect output and continue until the user request is complete, blocked, or needs confirmation.',
      'Do not ask the user to manually run commands that you can safely run with terminal_input.',
      'Avoid destructive or service-impacting commands unless the user clearly requested them and the app confirms them.',
      'If a command may take a long time, explain what is happening after observing output.',
      `Active session ID: ${activeSessionId.value || 'none'}.`,
    ].join('\n'),
  });

  const ensureConfigured = () => {
    if (!config.value.apiBaseUrl || !config.value.apiKey || !config.value.model) {
      showConfig.value = true;
      throw new Error('请先配置 AI API Base URL、API Key 和 Model。');
    }
  };

  const runAgentLoop = async (options?: SendMessageOptions) => {
    ensureConfigured();

    while (!stopRequested.value) {
      const controller = abortController.value;
      const response = await apiClient.post('/ai/chat', {
        ...config.value,
        messages: [buildSystemMessage(), ...messages.value],
        tools: aiTools,
        toolChoice: 'auto',
      }, {
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
      if (toolCalls.length === 0) return;

      for (const toolCall of toolCalls) {
        if (stopRequested.value) break;
        const result = await runTool(toolCall, options);
        messages.value.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
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
      }
    } catch (error: any) {
      if (error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError' || stopRequested.value) {
        messages.value.push({ role: 'assistant', content: '已停止本轮 AI 操作。' });
      } else {
        errorMessage.value = error.response?.data?.message || error.message || 'AI 请求失败。';
      }
    } finally {
      isRunning.value = false;
      abortController.value = null;
      stopRequested.value = false;
    }
  };

  const stopRun = () => {
    if (!isRunning.value) return;
    stopRequested.value = true;
    abortController.value?.abort();
  };

  const clearChat = () => {
    messages.value = [];
    toolRuns.value = [];
    errorMessage.value = '';
    localStorage.removeItem(MESSAGES_KEY);
    localStorage.removeItem(TOOL_RUNS_KEY);
  };

  return {
    userInput,
    isRunning,
    stopRequested,
    errorMessage,
    showConfig,
    messages,
    visibleMessages,
    toolRuns,
    latestToolRuns,
    config,
    activeSession,
    activeSessionId,
    canSend,
    hasActiveTerminal,
    sendMessage,
    stopRun,
    clearChat,
    sendInterruptToTerminal,
  };
});
