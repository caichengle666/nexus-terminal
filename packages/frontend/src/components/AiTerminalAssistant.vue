<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useAiStore, type AiTaskStatus, type AiToolRun } from '../stores/ai.store';
import { useConfirmDialog } from '../composables/useConfirmDialog';

const aiStore = useAiStore();
const { showConfirmDialog } = useConfirmDialog();
type DrawerPanel = 'context' | 'tools' | null;

const {
  userInput,
  isRunning,
  taskStatus,
  errorMessage,
  configMessage,
  hasSavedApiKey,
  showConfig,
  visibleMessages,
  latestToolRuns,
  memorySummary,
  runMode,
  config,
  activeSession,
  canSend,
  hasActiveTerminal,
} = storeToRefs(aiStore);

const sessionLabel = computed(() => activeSession.value?.connectionName || '没有活动终端');
const hasMemorySummary = computed(() => !!memorySummary.value.trim());
const drawerPanel = ref<DrawerPanel>(null);
const isDrawerOpen = computed(() => drawerPanel.value !== null);

const quickTasks = [
  '查看当前终端报错并给出修复方案',
  '检查当前服务状态并定位异常',
  '分析当前目录项目如何启动和编译',
  '读取最近输出，继续完成上一步任务',
];

const formatToolName = (name: string) => {
  if (name === 'get_terminal_output') return '读取终端输出';
  if (name === 'terminal_input') return '输入终端命令';
  return name;
};

const formatToolStatus = (status: AiToolRun['status']) => {
  if (status === 'running') return '运行中';
  if (status === 'done') return '完成';
  if (status === 'cancelled') return '已取消';
  return '失败';
};

const formatTaskStatus = (status: AiTaskStatus) => {
  if (status === 'thinking') return 'AI 思考中';
  if (status === 'awaitingConfirmation') return '等待命令确认';
  if (status === 'runningTool') return '调用工具中';
  if (status === 'waitingOutput') return '等待终端输出';
  if (status === 'compressing') return '压缩上下文';
  if (status === 'done') return '已完成';
  if (status === 'stopped') return '已停止';
  if (status === 'error') return '出错';
  return '空闲';
};

const formatToolSummary = (run: AiToolRun) => {
  if (run.name === 'terminal_input') {
    const text = typeof run.args.text === 'string' ? run.args.text : '';
    return text.length > 140 ? `${text.slice(0, 140)}...` : text;
  }
  if (run.name === 'get_terminal_output') {
    return `读取最近 ${run.args.maxLines || 120} 行`;
  }
  return JSON.stringify(run.args);
};

const openDrawer = (panel: Exclude<DrawerPanel, null>) => {
  drawerPanel.value = drawerPanel.value === panel ? null : panel;
};

const closeDrawer = () => {
  drawerPanel.value = null;
};

const sendMessage = () => aiStore.sendMessage({
  confirmCommand: async ({ command, reason, riskReason, riskLevel, connectionName }: { command: string; reason: string; riskReason?: string; riskLevel: string; connectionName?: string }) => showConfirmDialog({
    title: riskLevel === 'risky' ? '确认 AI 执行风险命令' : '确认 AI 执行命令',
    message: [
      `目标终端：${connectionName || sessionLabel.value}`,
      '',
      command,
      '',
      `AI 理由：${reason}`,
      riskReason ? `风险提示：${riskReason}` : '',
      '',
      '确认后才会发送到当前终端。',
    ].filter(Boolean).join('\n'),
    confirmText: '执行',
    cancelText: '取消',
  }),
});

const handleInputKeydown = (event: KeyboardEvent) => {
  if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
    return;
  }
  event.preventDefault();
  sendMessage();
};

const stopAi = async () => {
  aiStore.stopRun();
  const confirmed = await showConfirmDialog({
    title: '是否同时中断终端命令',
    message: 'AI 请求会立即停止。如果远程终端里已经有命令在运行，可以同时发送 Ctrl+C 尝试中断它。',
    confirmText: '同时 Ctrl+C',
    cancelText: '只停止 AI',
  });
  if (confirmed) {
    aiStore.sendInterruptToTerminal();
  }
};

const interruptTerminal = async () => {
  const confirmed = await showConfirmDialog({
    title: '中断当前终端命令',
    message: '将向当前 SSH 终端发送 Ctrl+C。它会尝试中断远程服务器里正在运行的命令，但不会停止 AI 本身。',
    confirmText: '发送 Ctrl+C',
    cancelText: '取消',
  });
  if (confirmed) {
    aiStore.sendInterruptToTerminal();
  }
};

const compactContext = async () => {
  const result = await aiStore.compactContextNow(true);
  if (!result.compacted) {
    const requestKb = Math.ceil(result.requestBytes / 1024);
    const thresholdKb = Math.floor(result.thresholdBytes / 1024);
    await showConfirmDialog({
      title: result.reason === 'empty' ? '暂无可压缩上下文' : '上下文未超过压缩阈值',
      message: result.reason === 'empty'
        ? '当前会话内容太少，还没有可以压缩成摘要的历史。'
        : `当前 AI 请求约 ${requestKb}KB，压缩阈值是 ${thresholdKb}KB。未超过阈值时不会强行压缩。`,
      confirmText: '知道了',
      cancelText: '关闭',
    });
  }
  drawerPanel.value = 'context';
};

const useQuickTask = (task: string) => {
  userInput.value = task;
};

const saveConfig = async () => {
  try {
    await aiStore.saveConfig();
  } catch (error: any) {
    errorMessage.value = error.response?.data?.message || error.message || 'AI 配置保存失败。';
  }
};

const testConfig = async () => {
  try {
    await aiStore.testConfig();
  } catch (error: any) {
    errorMessage.value = error.response?.data?.message || error.message || 'AI 配置测试失败。';
  }
};

const deleteHistory = async () => {
  const confirmed = await showConfirmDialog({
    title: '删除当前 AI 历史会话',
    message: `将删除当前终端「${sessionLabel.value}」的 AI 对话、记忆摘要和工具调用记录。这个操作不会删除 SSH 连接本身。`,
    confirmText: '删除',
    cancelText: '取消',
  });
  if (confirmed) {
    aiStore.clearChat();
    closeDrawer();
  }
};
</script>

<template>
  <div class="ai-terminal-assistant flex h-full min-h-0 flex-col bg-background text-foreground">
    <div class="flex items-center justify-between border-b border-border px-3 py-2">
      <div class="min-w-0">
        <div class="text-sm font-semibold">AI 终端助手</div>
        <div class="truncate text-xs text-text-secondary">{{ sessionLabel }}</div>
      </div>
      <div class="flex items-center gap-1">
        <button class="rounded px-2 py-1 text-xs hover:bg-hover" @click="showConfig = !showConfig">配置</button>
        <button class="rounded px-2 py-1 text-xs text-error hover:bg-error/10" @click="deleteHistory">删除历史</button>
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
        <span v-if="hasSavedApiKey" class="mt-1 block text-success">已保存加密密钥；留空不会覆盖。</span>
      </label>
      <label class="block">
        <span class="mb-1 block text-text-secondary">Model</span>
        <input v-model="config.model" class="w-full rounded border border-border bg-input px-2 py-1" placeholder="例如 gpt-4.1-mini" />
      </label>
      <div class="flex gap-2">
        <button class="rounded bg-primary px-3 py-1.5 text-white" @click="saveConfig">保存配置</button>
        <button class="rounded border border-border px-3 py-1.5 hover:bg-hover" @click="testConfig">测试连接</button>
      </div>
      <div v-if="configMessage" class="text-success">{{ configMessage }}</div>
    </div>

    <div class="border-b border-border px-3 py-2 text-xs">
      <div class="mb-2 flex items-center justify-between gap-2">
        <span class="text-text-secondary">状态：{{ formatTaskStatus(taskStatus) }}</span>
        <div class="flex items-center gap-1">
          <button class="rounded px-2 py-1 hover:bg-hover" @click="openDrawer('tools')">工具</button>
          <button class="rounded px-2 py-1 hover:bg-hover" @click="openDrawer('context')">上下文</button>
          <button class="rounded px-2 py-1 hover:bg-hover" @click="compactContext">压缩</button>
        </div>
      </div>
      <div class="grid grid-cols-3 overflow-hidden rounded border border-border">
        <button
          class="px-2 py-1"
          :class="runMode === 'readOnly' ? 'bg-primary text-white' : 'hover:bg-hover'"
          @click="runMode = 'readOnly'"
        >
          只读
        </button>
        <button
          class="border-x border-border px-2 py-1"
          :class="runMode === 'confirm' ? 'bg-primary text-white' : 'hover:bg-hover'"
          @click="runMode = 'confirm'"
        >
          确认
        </button>
        <button
          class="px-2 py-1"
          :class="runMode === 'auto' ? 'bg-primary text-white' : 'hover:bg-hover'"
          @click="runMode = 'auto'"
        >
          自动
        </button>
      </div>
    </div>

    <div class="relative flex-1 min-h-0 overflow-hidden">
      <div class="h-full space-y-3 overflow-auto p-3 text-sm">
      <div v-if="visibleMessages.length === 0" class="rounded border border-dashed border-border p-3 text-sm text-text-secondary">
        让 AI 查看当前终端、输入命令、读取结果并继续处理。Enter 发送，Shift+Enter 换行。
        <div class="mt-3 flex flex-wrap gap-2">
          <button
            v-for="task in quickTasks"
            :key="task"
            class="rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-hover"
            @click="useQuickTask(task)"
          >
            {{ task }}
          </button>
        </div>
      </div>

      <div
        v-for="(message, index) in visibleMessages"
        :key="index"
        class="flex"
        :class="message.role === 'user' ? 'justify-end' : 'justify-start'"
      >
        <div
          class="max-w-[88%] rounded border px-3 py-2 shadow-sm"
          :class="message.role === 'user'
            ? 'border-primary/30 bg-primary/10'
            : 'border-border/70 bg-header/30'"
        >
          <div
            class="mb-1 text-xs font-medium"
            :class="message.role === 'user' ? 'text-primary' : 'text-text-secondary'"
          >
            {{ message.role === 'user' ? '你' : 'AI' }}
          </div>
          <pre class="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">{{ message.content || (message.tool_calls ? '正在调用终端工具...' : '') }}</pre>
        </div>
      </div>

      <div v-if="errorMessage" class="rounded border border-error/40 bg-error/10 p-2 text-error">
        {{ errorMessage }}
      </div>
      </div>

      <div
        v-if="isDrawerOpen"
        class="absolute inset-0 z-10 bg-black/20"
        @click="closeDrawer"
      />
      <aside
        v-if="isDrawerOpen"
        class="absolute right-0 top-0 z-20 flex h-full w-[86%] max-w-sm flex-col border-l border-border bg-background shadow-xl"
      >
        <div class="flex items-center justify-between border-b border-border px-3 py-2">
          <div class="text-sm font-semibold">
            {{ drawerPanel === 'context' ? '上下文与记忆' : '最近工具调用' }}
          </div>
          <button class="rounded px-2 py-1 text-xs hover:bg-hover" @click="closeDrawer">关闭</button>
        </div>

        <div v-if="drawerPanel === 'context'" class="flex-1 overflow-auto p-3 text-xs">
          <div class="mb-3 flex gap-2">
            <button class="rounded bg-primary px-3 py-1.5 text-white" @click="compactContext">压缩上下文</button>
            <button class="rounded border border-error/40 px-3 py-1.5 text-error hover:bg-error/10" @click="deleteHistory">删除历史</button>
          </div>
          <div v-if="hasMemorySummary" class="rounded border border-border/60 p-2">
            <div class="mb-2 font-medium text-text-secondary">记忆摘要</div>
            <pre class="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words font-sans leading-relaxed">{{ memorySummary }}</pre>
          </div>
          <div v-else class="rounded border border-dashed border-border p-3 text-text-secondary">
            当前会话还没有记忆摘要。
          </div>
        </div>

        <div v-else class="flex-1 overflow-auto p-3">
          <div v-if="latestToolRuns.length === 0" class="rounded border border-dashed border-border p-3 text-sm text-text-secondary">
            当前会话还没有工具调用。
          </div>
          <div
            v-for="run in latestToolRuns"
            v-else
            :key="run.id"
            class="mb-2 rounded border border-border/60 px-2 py-2 last:mb-0"
          >
            <div class="flex items-center justify-between gap-2 text-xs">
              <span class="font-medium">{{ formatToolName(run.name) }}</span>
              <span
                class="rounded px-1.5 py-0.5"
                :class="{
                  'bg-primary/10 text-primary': run.status === 'running',
                  'bg-success/10 text-success': run.status === 'done',
                  'bg-warning/10 text-warning': run.status === 'cancelled',
                  'bg-error/10 text-error': run.status === 'error',
                }"
              >{{ formatToolStatus(run.status) }}</span>
            </div>
            <div class="mt-1 truncate font-mono text-xs text-text-secondary">{{ formatToolSummary(run) }}</div>
          </div>
        </div>
      </aside>
    </div>

    <div class="border-t border-border p-3">
      <textarea
        v-model="userInput"
        class="mb-2 h-20 w-full resize-none rounded border border-border bg-input px-2 py-2 text-sm"
        placeholder="例如：查看当前报错，直接输入排查命令并修复"
        @keydown="handleInputKeydown"
      />
      <div class="grid grid-cols-2 gap-2">
        <button
          v-if="!isRunning"
          class="rounded bg-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
          :disabled="!canSend"
          @click="sendMessage"
        >
          发送
        </button>
        <button
          v-else
          class="rounded bg-error px-3 py-2 text-sm font-medium text-white"
          @click="stopAi"
        >
          停止 AI
        </button>
        <button
          class="rounded border border-border px-3 py-2 text-sm font-medium hover:bg-hover disabled:opacity-60"
          :disabled="!hasActiveTerminal"
          @click="interruptTerminal"
        >
          Ctrl+C 终端
        </button>
      </div>
    </div>
  </div>
</template>
