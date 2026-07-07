<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import apiClient from '../utils/apiClient';
import { useSessionStore } from '../stores/session.store';

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

type ToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

type TerminalInputArgs = {
  text: string;
  pressEnter?: boolean;
  sessionId?: string;
  waitMs?: number;
};

const CONFIG_KEY = 'nexus_ai_terminal_config';
const MESSAGES_KEY = 'nexus_ai_terminal_messages';
const MAX_SAVED_MESSAGES = 80;
const MAX_SAVED_CONTENT_LENGTH = 16000;
const MAX_TOOL_STEPS = 10;

const sessionStore = useSessionStore();
const userInput = ref('');
const isLoading = ref(false);
const errorMessage = ref('');
const showConfig = ref(false);
const messages = ref<ChatMessage[]>([]);

const config = ref({
  apiBaseUrl: '',
  apiKey: '',
  model: '',
});

const activeSession = computed(() => sessionStore.activeSession);
const activeSessionId = computed(() => activeSession.value?.sessionId || '');
const visibleMessages = computed(() => messages.value.filter(message => message.role !== 'tool'));

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

const normalizeMessagesForStorage = (items: ChatMessage[]) => items
  .slice(-MAX_SAVED_MESSAGES)
  .map(message => ({
    ...message,
    content: typeof message.content === 'string'
      ? message.content.slice(0, MAX_SAVED_CONTENT_LENGTH)
      : message.content,
  }));

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

watch(config, (next) => {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
}, { deep: true });

watch(messages, (next) => {
  localStorage.setItem(MESSAGES_KEY, JSON.stringify(normalizeMessagesForStorage(next)));
}, { deep: true });

loadConfig();
loadMessages();

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
];

const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));

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

const sendTerminalInput = async (args: TerminalInputArgs) => {
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

  const waitMs = Math.max(0, Math.min(Number(args.waitMs) || 900, 5000));
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

const parseToolArgs = (toolCall: ToolCall) => {
  try {
    return JSON.parse(toolCall.function.arguments || '{}');
  } catch {
    return {};
  }
};

const runTool = async (toolCall: ToolCall) => {
  const args = parseToolArgs(toolCall);
  if (toolCall.function.name === 'get_terminal_output') {
    return readTerminalOutput(args.sessionId, args.maxLines);
  }
  if (toolCall.function.name === 'terminal_input') {
    return sendTerminalInput(args);
  }
  return { ok: false, error: `Unknown tool: ${toolCall.function.name}` };
};

const buildSystemMessage = (): ChatMessage => ({
  role: 'system',
  content: [
    'You are an AI terminal operator inside Nexus Terminal.',
    'You have tools and may use them directly to complete the user request.',
    'Use get_terminal_output to inspect the active terminal.',
    'Use terminal_input to type into the active SSH terminal. Use pressEnter=true when submitting a shell command.',
    'After sending a command, inspect output and continue until the task is complete or blocked.',
    'Do not ask the user to manually run commands that you can run with terminal_input.',
    'Avoid destructive commands unless the user explicitly asked for that exact destructive action.',
    `Active session ID: ${activeSessionId.value || 'none'}.`,
  ].join('\n'),
});

const callModelLoop = async () => {
  if (!config.value.apiBaseUrl || !config.value.apiKey || !config.value.model) {
    showConfig.value = true;
    throw new Error('请先配置 AI API Base URL、API Key 和 Model。');
  }

  for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
    const response = await apiClient.post('/ai/chat', {
      ...config.value,
      messages: [buildSystemMessage(), ...messages.value],
      tools: aiTools,
      toolChoice: 'auto',
    });

    const assistantMessage = response.data?.choices?.[0]?.message as ChatMessage | undefined;
    if (!assistantMessage) {
      throw new Error('AI 返回格式无效。');
    }

    messages.value.push(assistantMessage);
    const toolCalls = assistantMessage.tool_calls || [];
    if (toolCalls.length === 0) return;

    for (const toolCall of toolCalls) {
      const result = await runTool(toolCall);
      messages.value.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  throw new Error('AI 工具调用次数过多，已停止本轮任务。');
};

const sendMessage = async () => {
  const content = userInput.value.trim();
  if (!content || isLoading.value) return;

  errorMessage.value = '';
  userInput.value = '';
  messages.value.push({ role: 'user', content });
  isLoading.value = true;

  try {
    await callModelLoop();
  } catch (error: any) {
    errorMessage.value = error.response?.data?.message || error.message || 'AI 请求失败。';
  } finally {
    isLoading.value = false;
  }
};

const clearChat = () => {
  messages.value = [];
  errorMessage.value = '';
  localStorage.removeItem(MESSAGES_KEY);
};
</script>

<template>
  <div class="ai-terminal-assistant flex h-full flex-col bg-background text-foreground">
    <div class="flex items-center justify-between border-b border-border px-3 py-2">
      <div class="min-w-0">
        <div class="text-sm font-semibold">AI 终端助手</div>
        <div class="truncate text-xs text-text-secondary">
          {{ activeSession ? activeSession.connectionName : '没有活动终端' }}
        </div>
      </div>
      <div class="flex items-center gap-1">
        <button class="rounded px-2 py-1 text-xs hover:bg-hover" @click="showConfig = !showConfig">配置</button>
        <button class="rounded px-2 py-1 text-xs hover:bg-hover" @click="clearChat">清空</button>
      </div>
    </div>

    <div v-if="showConfig" class="space-y-2 border-b border-border p-3 text-xs">
      <label class="block">
        <span class="mb-1 block text-text-secondary">API Base URL</span>
        <input v-model="config.apiBaseUrl" class="w-full rounded border border-border bg-input px-2 py-1" placeholder="https://api.openai.com/v1" />
      </label>
      <label class="block">
        <span class="mb-1 block text-text-secondary">API Key</span>
        <input v-model="config.apiKey" type="password" class="w-full rounded border border-border bg-input px-2 py-1" placeholder="sk-..." />
      </label>
      <label class="block">
        <span class="mb-1 block text-text-secondary">Model</span>
        <input v-model="config.model" class="w-full rounded border border-border bg-input px-2 py-1" placeholder="例如 gpt-4.1-mini" />
      </label>
    </div>

    <div class="flex-1 space-y-3 overflow-auto p-3 text-sm">
      <div v-if="visibleMessages.length === 0" class="text-sm text-text-secondary">
        你可以直接让 AI 查看当前终端输出、输入命令、读取结果，并继续完成指定任务。
      </div>

      <div v-for="(message, index) in visibleMessages" :key="index" class="rounded border border-border/60 p-2">
        <div class="mb-1 text-xs text-text-secondary">
          {{ message.role === 'user' ? '你' : 'AI' }}
        </div>
        <pre class="whitespace-pre-wrap break-words font-sans text-sm">{{ message.content || (message.tool_calls ? '正在调用终端工具...' : '') }}</pre>
      </div>

      <div v-if="errorMessage" class="rounded border border-error/40 bg-error/10 p-2 text-error">
        {{ errorMessage }}
      </div>
    </div>

    <form class="border-t border-border p-3" @submit.prevent="sendMessage">
      <textarea
        v-model="userInput"
        class="mb-2 h-20 w-full resize-none rounded border border-border bg-input px-2 py-2 text-sm"
        placeholder="例如：查看当前报错，直接输入排查命令并修复"
      />
      <button class="w-full rounded bg-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-60" :disabled="isLoading || !userInput.trim()">
        {{ isLoading ? '处理中...' : '发送给 AI' }}
      </button>
    </form>
  </div>
</template>
