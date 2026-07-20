<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useAiStore, type AiTaskStatus, type AiToolRun } from '../stores/ai.store';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import nexusAiAvatar from '../assets/nexus-ai-avatar.jpg';
import { MAX_IMPORT_FILE_BYTES } from '../stores/ai/ai.constants';

const aiStore = useAiStore();
const { showConfirmDialog } = useConfirmDialog();
type DrawerPanel = 'context' | null;

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
  activeActivities,
  storageWarning,
  availableModels,
  isFetchingModels,
  modelFetchMessage,
  historyConfig,
  historyConfigMessage,
  historySyncWarning,
  memorySummary,
  compression,
  compactTriggerPercent,
  maxRequestKb,
  maxAutoCompactsPerTask,
  runMode,
  config,
  activeSession,
  activeSessionId,
  canSend,
  canQueueGuidance,
  hasActiveTerminal,
  continuationAvailable,
} = storeToRefs(aiStore);

const modeMenuOpen = ref(false);
const modeMenuRef = ref<HTMLElement | null>(null);
const modelMenuOpen = ref(false);
const modelMenuRef = ref<HTMLElement | null>(null);
const importFileInput = ref<HTMLInputElement | null>(null);
const modeOptions = [
  { value: 'readOnly', label: '只读', description: '仅查看，不执行命令' },
  { value: 'confirm', label: '确认', description: '每次执行前确认' },
  { value: 'auto', label: '自动', description: '由 AI 自主执行' },
] as const;
const activeModeOption = computed(() => modeOptions.find(option => option.value === runMode.value) || modeOptions[1]);
const conversationMessages = computed(() => visibleMessages.value.filter(message => (
  message.role !== 'assistant' || !!message.content?.trim() || !message.tool_calls?.length
)));

const selectRunMode = (mode: typeof runMode.value) => {
  runMode.value = mode;
  modeMenuOpen.value = false;
};

const handleDocumentPointerDown = (event: PointerEvent) => {
  if (!modeMenuRef.value?.contains(event.target as Node)) modeMenuOpen.value = false;
  if (!modelMenuRef.value?.contains(event.target as Node)) modelMenuOpen.value = false;
};

onMounted(() => document.addEventListener('pointerdown', handleDocumentPointerDown));
onBeforeUnmount(() => document.removeEventListener('pointerdown', handleDocumentPointerDown));

const sessionLabel = computed(() => activeSession.value?.connectionName || '没有活动终端');
const hasMemorySummary = computed(() => !!memorySummary.value.trim());
const formatBytes = (bytes?: number) => {
  if (!bytes) return '0 KB';
  return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
};
const summaryModeLabel = computed(() => {
  if (compression.value?.summaryMode === 'ai') return 'AI 摘要';
  if (compression.value?.summaryMode === 'pending') return 'AI 摘要生成中';
  return '本地摘要';
});
const drawerPanel = ref<DrawerPanel>(null);
const isDrawerOpen = computed(() => drawerPanel.value !== null);
const textareaInput = ref<HTMLTextAreaElement | null>(null);
const refocusInput = () => {
  void nextTick(() => textareaInput.value?.focus());
};
const lastUserPrompt = computed(() => {
  const lastUser = [...visibleMessages.value].reverse().find(message => message.role === 'user');
  return typeof lastUser?.content === 'string' ? lastUser.content : '';
});

const timelineItems = computed(() => latestToolRuns.value
  .slice()
  .reverse()
  .slice(-8)
  .map(run => ({
    id: run.id,
    title: formatToolName(run.name),
    status: formatToolStatus(run.status),
    summary: formatToolSummary(run),
    duration: formatToolDuration(run),
    failed: run.status === 'error',
  })));

const quickTasks = [
  '查看当前终端报错并给出修复方案',
  '检查当前服务状态并定位异常',
  '分析当前目录项目如何启动和编译',
  '读取最近输出，继续完成上一步任务',
  '列出当前已连接的 VPS，比较它们的系统版本和运行时间',
];

const formatToolName = (name: string) => {
  if (name === 'get_terminal_output') return '读取终端输出';
  if (name === 'wait_for_terminal_output') return '等待终端输出';
  if (name === 'terminal_input') return '输入终端命令';
  if (name === 'execute_command') return '后台执行命令';
  if (name === 'send_terminal_key') return '发送终端按键';
  if (name === 'read_remote_file') return '读取远程文件';
  if (name === 'list_remote_directory') return '列出远程目录';
  if (name === 'list_active_terminals') return '列出活动终端';
  if (name === 'execute_command_batch') return '批量执行 VPS 命令';
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
  if (status === 'interrupted') return '输出已截断';
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
  if (run.name === 'wait_for_terminal_output') {
    const seconds = Math.max(0.2, Number(run.args.timeoutMs || 15000) / 1000);
    return `最长等待 ${seconds.toFixed(1)} 秒`;
  }
  if (run.name === 'execute_command') {
    const command = typeof run.args.command === 'string' ? run.args.command : '';
    return command.length > 140 ? `${command.slice(0, 140)}...` : command;
  }
  if (run.name === 'send_terminal_key') return String(run.args.key || '未指定按键');
  if (run.name === 'read_remote_file') return String(run.args.path || '未指定路径');
  if (run.name === 'list_remote_directory') return String(run.args.path || '未指定路径');
  if (run.name === 'execute_command_batch') {
    const count = Array.isArray(run.args.targetSessionIds) ? run.args.targetSessionIds.length : 0;
    return `${count} 台终端 · ${String(run.args.command || '').slice(0, 100)}`;
  }
  if (run.name === 'list_active_terminals') return '读取当前已连接 SSH Tab';
  return JSON.stringify(run.args);
};

const formatToolDuration = (run: AiToolRun) => {
  if (!run.finishedAt) return '运行中';
  const durationMs = Math.max(0, run.finishedAt - run.startedAt);
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
};

const formatToolArguments = (run: AiToolRun) => {
  const command = typeof run.args.text === 'string' ? run.args.text : '';
  return command || JSON.stringify(run.args, null, 2);
};

const getToolCommand = (run: AiToolRun) => {
  if (typeof run.args.text === 'string') return run.args.text;
  if (typeof run.args.command === 'string') return run.args.command;
  return '';
};

const formatToolResult = (run: AiToolRun) => {
  const value = run.result ?? run.error ?? '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > 2400 ? `${text.slice(0, 2400)}\n...<结果已截断>` : text || '无返回内容';
};

const detectCommandRisk = (command: string) => {
  const text = command.toLowerCase();
  const dangerousPatterns = [
    'rm -rf',
    'mkfs',
    'dd if=',
    'shutdown',
    'reboot',
    'poweroff',
    ':(){',
    'chmod -r 777',
  ];
  const confirmPatterns = [
    'apt install',
    'apt-get install',
    'yum install',
    'dnf install',
    'systemctl restart',
    'systemctl stop',
    'docker rm',
    'docker compose down',
    'iptables',
    'ufw ',
    'firewall-cmd',
  ];
  if (dangerousPatterns.some(pattern => text.includes(pattern))) return 'danger';
  if (confirmPatterns.some(pattern => text.includes(pattern))) return 'confirm';
  return 'normal';
};

const formatRiskLabel = (risk: string) => {
  if (risk === 'danger') return '危险';
  if (risk === 'confirm') return '需确认';
  return '普通';
};

const formatRiskClass = (risk: string) => {
  if (risk === 'danger') return 'border-error/60 bg-error/15 text-error';
  if (risk === 'confirm') return 'border-warning/60 bg-warning/15 text-warning';
  return 'border-success/50 bg-success/10 text-success';
};

const messageLabel = (role: string) => {
  if (role === 'user') return '你';
  if (role === 'assistant') return 'Nexus AI';
  if (role === 'tool') return '终端工具';
  if (role === 'system') return '系统';
  return role;
};

const messageIconClass = (role: string) => {
  if (role === 'user') return 'fas fa-user';
  if (role === 'assistant') return 'fas fa-microchip';
  if (role === 'tool') return 'fas fa-terminal';
  if (role === 'system') return 'fas fa-circle-info';
  return 'fas fa-message';
};

const messageAvatarClass = (role: string) => {
  if (role === 'user') return 'border-primary/40 bg-primary/15 text-primary';
  if (role === 'assistant') return 'border-primary/50 bg-primary text-white shadow-sm shadow-primary/30';
  if (role === 'tool') return 'border-warning/40 bg-warning/15 text-warning';
  if (role === 'system') return 'border-border/70 bg-header text-text-secondary';
  return 'border-border/70 bg-header text-text-secondary';
};

const messageShellClass = (role: string) => {
  if (role === 'user') return 'ml-auto border-primary/40 bg-primary/15 text-foreground shadow-primary/5';
  if (role === 'assistant') return 'mr-auto border-border/80 bg-background text-foreground shadow-black/5';
  if (role === 'tool') return 'mx-auto max-w-[92%] border-warning/40 bg-warning/10 text-warning';
  if (role === 'system') return 'mx-auto max-w-[92%] border-border/60 bg-header/40 text-text-secondary';
  return 'mr-auto border-border/70 bg-header/30 text-foreground';
};

const messageLabelClass = (role: string) => {
  if (role === 'user') return 'text-primary';
  if (role === 'assistant') return 'text-text-secondary';
  if (role === 'tool') return 'text-warning';
  if (role === 'system') return 'text-text-secondary';
  return 'text-text-secondary';
};

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const renderMarkdown = (content?: string | null) => {
  const text = content || '';
  const escaped = escapeHtml(text);
  return escaped
    .replace(/```(?:[a-zA-Z0-9_+-]+)?\s*[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '<code class="rounded bg-black/20 px-1 py-0.5 font-mono text-xs">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
};

const extractCommandBlocks = (content?: string | null) => {
  if (!content) return [];
  const blocks: string[] = [];
  const fencePattern = /```(?:[a-zA-Z0-9_+-]+)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(content)) !== null) {
    const block = match[1]
      .split('\n')
      .map(line => line.replace(/^\$\s?/, ''))
      .join('\n')
      .trim();
    if (block) blocks.push(block);
  }
  return blocks.slice(0, 4);
};

const copyText = async (text: string) => {
  await navigator.clipboard?.writeText(text);
};

const fillCommandInput = (command: string) => {
  const normalized = command.trim();
  if (!normalized) return;
  if (/\r|\n/.test(normalized)) {
    errorMessage.value = '多行命令不能安全填入终端，请先复制后手动确认执行。';
    return;
  }
  const sender = activeSession.value?.terminalManager?.sendData;
  if (sender) {
    sender(normalized);
    return;
  }
  errorMessage.value = '当前没有可输入的活动终端。';
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
  const runSessionId = activeSessionId.value;
  aiStore.stopRun(runSessionId);
  const confirmed = await showConfirmDialog({
    title: '是否同时中断终端命令',
    message: 'AI 请求会立即停止。如果远程终端里已经有命令在运行，可以同时发送 Ctrl+C 尝试中断它。',
    confirmText: '同时 Ctrl+C',
    cancelText: '只停止 AI',
  });
  if (confirmed) {
    aiStore.sendInterruptToTerminal(runSessionId);
  }
  refocusInput();
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
  refocusInput();
};

const compactContext = async () => {
  const result = await aiStore.compactContextNow(true);
  if (result.compacted) {
    await showConfirmDialog({
      title: '上下文压缩完成',
      message: `已压缩 ${result.compactedCount || 0} 条历史消息，保留最近 ${result.retainedCount || 0} 条。请求大小从约 ${formatBytes(result.requestBytes)} 变为 ${formatBytes(result.finalRequestBytes)}，硬上限为 ${formatBytes(result.hardLimitBytes)}。摘要来源：${result.summaryMode === 'ai' ? 'AI' : '本地'}。`,
      confirmText: '知道了',
      cancelText: '关闭',
    });
  } else if (result.reason !== 'underBudget') {
    await showConfirmDialog({
      title: result.reason === 'empty' ? '暂无可压缩上下文' : '上下文未超过压缩阈值',
      message: result.reason === 'empty'
        ? '当前会话内容太少，还没有可以压缩成摘要的历史。'
        : `当前 AI 请求约 ${Math.ceil(result.requestBytes / 1024)}KB，压缩阈值是 ${Math.floor(result.thresholdBytes / 1024)}KB。未超过阈值时不会强行压缩。`,
      confirmText: '知道了',
      cancelText: '关闭',
    });
  }
  drawerPanel.value = 'context';
};

const useQuickTask = (task: string) => {
  userInput.value = task;
};

const rereadTerminal = () => {
  userInput.value = '读取当前终端最近输出，判断上一轮失败原因并继续处理';
  sendMessage();
};

const retryLastPrompt = () => {
  if (!lastUserPrompt.value) return;
  userInput.value = lastUserPrompt.value;
  sendMessage();
};

const compactAndRetry = async () => {
  await aiStore.compactContextNow(true);
  retryLastPrompt();
};

const switchReadOnly = () => {
  runMode.value = 'readOnly';
};

const continueLastResponse = () => aiStore.continueLastResponse({
  confirmCommand: async ({ command, reason, riskReason, riskLevel, connectionName }: { command: string; reason: string; riskReason?: string; riskLevel: string; connectionName?: string }) => showConfirmDialog({
    title: riskLevel === 'risky' ? '确认 AI 执行风险命令' : '确认 AI 执行命令',
    message: [`目标终端：${connectionName || sessionLabel.value}`, '', command, '', `AI 理由：${reason}`, riskReason ? `风险提示：${riskReason}` : '', '', '确认后才会发送到当前终端。'].filter(Boolean).join('\n'),
    confirmText: '执行',
    cancelText: '取消',
  }),
});

const saveConfig = async () => {
  try {
    await aiStore.saveConfig();
  } catch (error: any) {
    errorMessage.value = error.response?.data?.message || error.message || 'AI 配置保存失败。';
  }
};

const selectHistoryDirectory = async () => {
  const result = await (window as any).electronAPI?.selectDirectory?.();
  if (!result?.canceled && result?.path) historyConfig.value.storagePath = result.path;
};

const saveHistoryConfig = async () => {
  try {
    await aiStore.saveHistoryConfig();
  } catch (error: any) {
    errorMessage.value = error.response?.data?.message || error.message || '文件会话存储配置保存失败。';
  }
};

const openCurrentHistoryDirectory = async () => {
  try {
    const directory = await aiStore.getCurrentHistoryDirectory();
    const result = await (window as any).electronAPI?.openPath?.(directory);
    if (!result?.ok && result?.error) throw new Error(result.error);
    if (!(window as any).electronAPI?.openPath) {
      await showConfirmDialog({ title: '当前终端会话目录', message: directory, confirmText: '知道了', cancelText: '关闭' });
    }
  } catch (error: any) {
    errorMessage.value = error.message || '打开会话目录失败。';
  }
};

const testConfig = async () => {
  try {
    await aiStore.testConfig();
  } catch (error: any) {
    errorMessage.value = error.response?.data?.message || error.message || 'AI 配置测试失败。';
  }
};

const fetchModels = async () => {
  await aiStore.fetchModels();
};

const downloadFile = (content: string, filename: string, type: string) => {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const confirmExportSafety = () => showConfirmDialog({
  title: '导出 AI 会话',
  message: '导出文件可能包含终端输出中的 IP、Token、密码或环境变量。程序不会导出 API Key、SSH 密码和私钥，但请妥善保管导出的文件。是否继续？',
  confirmText: '继续导出',
  cancelText: '取消',
});

const exportJson = async () => {
  if (!await confirmExportSafety()) return;
  const data = aiStore.exportSessionData();
  downloadFile(JSON.stringify(data, null, 2), `nexus-ai-session-${data.exportedAt.slice(0, 10)}.json`, 'application/json');
};

const exportMarkdown = async () => {
  if (!await confirmExportSafety()) return;
  const data = aiStore.exportSessionData();
  const lines = [
    '# Nexus Terminal AI 会话',
    '',
    `- 终端：${data.connectionName}`,
    `- 导出时间：${data.exportedAt}`,
    '',
    '## 记忆摘要',
    '',
    data.memory.summary || '暂无记忆摘要。',
    '',
    '## 对话记录',
    '',
  ];
  data.memory.messages.forEach(message => {
    const label = message.role === 'user' ? '用户' : message.role === 'assistant' ? 'AI' : message.role === 'tool' ? '工具' : '系统';
    lines.push(`### ${label}`, '', message.content || (message.tool_calls ? `调用工具：${message.tool_calls.map(call => call.function.name).join('、')}` : ''), '');
  });
  lines.push('## 工具调用记录', '');
  data.memory.toolRuns.forEach(run => {
    lines.push(`- ${formatToolName(run.name)}：${formatToolStatus(run.status)}，耗时 ${formatToolDuration(run)}`);
    if (run.args) lines.push(`  - 参数：\`${JSON.stringify(run.args)}\``);
    if (run.error) lines.push(`  - 失败：${run.error}`);
  });
  if (data.memory.compression) {
    lines.push('', '## 压缩记录', '', `- 处理消息：${data.memory.compression.compactedCount}`, `- 保留消息：${data.memory.compression.retainedCount}`, `- 摘要来源：${data.memory.compression.summaryMode}`);
  }
  downloadFile(lines.join('\n'), `nexus-ai-session-${data.exportedAt.slice(0, 10)}.md`, 'text/markdown;charset=utf-8');
};

const openImportDialog = () => importFileInput.value?.click();

const importSessionFile = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    if (file.size > MAX_IMPORT_FILE_BYTES) throw new Error('导入文件不能超过 5MB。');
    const data = JSON.parse(await file.text());
    const compatibility = aiStore.checkSessionImport(data);
    if (compatibility.nameMismatch) {
      const confirmedNameMismatch = await showConfirmDialog({
        title: '终端名称不同',
        message: `${compatibility.message} 是否确认导入？`,
        confirmText: '确认导入',
        cancelText: '取消',
      });
      if (!confirmedNameMismatch) return;
    }
    const confirmed = await showConfirmDialog({
      title: '导入 AI 会话',
      message: '导入会话将替换当前终端的 AI 对话、摘要和工具记录。导入的命令不会自动执行。是否继续？',
      confirmText: '导入并替换',
      cancelText: '取消',
    });
    if (!confirmed) return;
    const result = aiStore.importSessionData(data, 'replace', !!compatibility.nameMismatch);
    await showConfirmDialog({
      title: '会话导入完成',
      message: `已导入 ${result.messageCount} 条消息和 ${result.toolRunCount} 条工具记录。`,
      confirmText: '知道了',
      cancelText: '关闭',
    });
  } catch (error: any) {
    await showConfirmDialog({
      title: '会话导入失败',
      message: error.message || '文件不是有效的 Nexus Terminal AI 会话。',
      confirmText: '知道了',
      cancelText: '关闭',
    });
  }
};

const testStreaming = async () => {
  try {
    await aiStore.testStreaming();
  } catch (error: any) {
    errorMessage.value = error.response?.data?.message || error.message || '流式输出测试失败。';
  }
};

const testToolCalling = async () => {
  try {
    await aiStore.testToolCalling();
  } catch (error: any) {
    errorMessage.value = error.response?.data?.message || error.message || '工具调用测试失败。';
  }
};

const deleteHistory = async () => {
  if (isRunning.value) {
    await showConfirmDialog({
      title: 'AI 正在运行',
      message: '请先停止当前 AI 任务，再删除会话历史，避免正在运行的任务写回旧消息。',
      confirmText: '知道了',
      cancelText: '关闭',
    });
    return;
  }
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
  refocusInput();
};
</script>

<template>
  <div class="ai-terminal-assistant flex h-full min-h-0 flex-col bg-background text-foreground">
    <input ref="importFileInput" type="file" accept=".json,application/json" class="hidden" @change="importSessionFile" />
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
        <div class="flex gap-1.5">
          <input v-model="config.model" class="min-w-0 flex-1 rounded border border-primary/40 bg-input px-2 py-1 text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/25" placeholder="例如 gpt-4.1-mini" />
          <button
            type="button"
            class="flex-shrink-0 rounded border border-primary/50 px-2 py-1 text-primary transition hover:bg-primary/10 disabled:cursor-wait disabled:opacity-60"
            :disabled="isFetchingModels"
            @click="fetchModels"
          >
            {{ isFetchingModels ? '获取中...' : '获取模型' }}
          </button>
        </div>
        <div v-if="availableModels.length > 0" ref="modelMenuRef" class="relative mt-1.5">
          <button
            type="button"
            class="flex w-full items-center justify-between rounded border border-border bg-header/60 px-2 py-1.5 text-left text-xs text-foreground transition hover:border-primary/60 hover:bg-hover"
            :aria-expanded="modelMenuOpen"
            aria-haspopup="listbox"
            @click="modelMenuOpen = !modelMenuOpen"
          >
            <span class="truncate">从已获取模型中选择{{ config.model ? `：${config.model}` : '' }}</span>
            <i class="fas ml-2 text-[10px] text-text-secondary" :class="modelMenuOpen ? 'fa-chevron-up' : 'fa-chevron-down'" aria-hidden="true" />
          </button>
          <div v-if="modelMenuOpen" role="listbox" class="absolute left-0 right-0 z-30 mt-1 max-h-48 overflow-auto rounded border border-border bg-background py-1 shadow-xl">
            <button
              v-for="model in availableModels"
              :key="model"
              type="button"
              role="option"
              :aria-selected="config.model === model"
              class="block w-full truncate px-2.5 py-2 text-left text-xs text-foreground transition hover:bg-hover"
              :class="config.model === model ? 'bg-primary/15 text-primary' : ''"
              @click="config.model = model; modelMenuOpen = false"
            >
              {{ model }}
            </button>
          </div>
        </div>
        <span v-if="modelFetchMessage" class="mt-1 block" :class="availableModels.length > 0 ? 'text-success' : 'text-warning'">{{ modelFetchMessage }}</span>
      </label>
      <div class="rounded border border-border/70 bg-header/20 p-2">
        <div class="mb-2 flex items-center justify-between gap-2">
          <span class="font-medium text-foreground">文件会话记录</span>
          <label class="flex items-center gap-1.5 text-text-secondary">
            <input v-model="historyConfig.enabled" type="checkbox" class="accent-primary" />
            启用
          </label>
        </div>
        <p class="mb-2 text-[11px] leading-relaxed text-text-secondary">按连接 ID、名称、IP 和端口分目录保存 JSON；可选 Markdown 便于其他 AI 或人工查看。当前运行中的会话仍保留本地即时恢复。</p>
        <label class="block">
          <span class="mb-1 block text-text-secondary">存储目录（留空使用程序数据目录）</span>
          <div class="flex gap-1.5">
            <input v-model="historyConfig.storagePath" class="min-w-0 flex-1 rounded border border-border bg-input px-2 py-1" placeholder="自动使用程序数据目录" />
            <button type="button" class="flex-shrink-0 rounded border border-border px-2 py-1 hover:bg-hover" @click="selectHistoryDirectory">选择目录</button>
          </div>
          <span v-if="historyConfig.effectiveStoragePath" class="mt-1 block break-all text-[10px] text-text-secondary">当前：{{ historyConfig.effectiveStoragePath }}</span>
        </label>
        <div class="mt-2 grid grid-cols-2 gap-2">
          <label class="block">
            <span class="mb-1 block text-text-secondary">总空间 MB</span>
            <input v-model.number="historyConfig.maxStorageMb" type="number" min="50" max="4096" class="w-full rounded border border-border bg-input px-2 py-1" />
          </label>
          <label class="block">
            <span class="mb-1 block text-text-secondary">单会话 MB</span>
            <input v-model.number="historyConfig.maxSessionMb" type="number" min="1" :max="Math.min(512, historyConfig.maxStorageMb || 50)" class="w-full rounded border border-border bg-input px-2 py-1" />
          </label>
        </div>
        <label class="mt-2 flex items-center gap-1.5 text-text-secondary">
          <input v-model="historyConfig.writeMarkdown" type="checkbox" class="accent-primary" />
          同时生成 Markdown 阅读版
        </label>
        <button class="mt-2 rounded border border-primary/50 px-3 py-1.5 text-primary hover:bg-primary/10" @click="saveHistoryConfig">保存文件记录设置</button>
        <div v-if="historyConfigMessage" class="mt-1 text-success">{{ historyConfigMessage }}</div>
      </div>
      <div class="flex flex-wrap gap-2">
        <button class="rounded bg-primary px-3 py-1.5 text-white" @click="saveConfig">保存配置</button>
        <button class="rounded border border-border px-3 py-1.5 hover:bg-hover" @click="testConfig">测试连接</button>
        <button class="rounded border border-primary/50 px-3 py-1.5 text-primary hover:bg-primary/10" @click="testStreaming">测试流式</button>
        <button class="rounded border border-primary/50 px-3 py-1.5 text-primary hover:bg-primary/10" @click="testToolCalling">测试工具</button>
      </div>
      <div v-if="configMessage" class="text-success">{{ configMessage }}</div>
    </div>

    <div class="border-b border-border px-3 py-1.5 text-xs">
      <div v-if="storageWarning" class="mb-1 rounded border border-warning/40 bg-warning/10 px-2 py-1 text-warning">{{ storageWarning }}</div>
      <div v-if="historySyncWarning" class="mb-1 rounded border border-warning/40 bg-warning/10 px-2 py-1 text-warning">{{ historySyncWarning }}</div>
      <div class="flex items-center justify-between gap-2">
        <div class="flex min-w-0 items-center gap-2">
          <span class="h-1.5 w-1.5 flex-shrink-0 rounded-full" :class="isRunning ? 'animate-pulse bg-primary' : taskStatus === 'error' ? 'bg-error' : 'bg-success'" />
          <span class="truncate text-text-secondary">{{ formatTaskStatus(taskStatus) }}</span>
          <span v-if="timelineItems.length > 0" class="truncate text-[11px] text-text-secondary/80">· 最近：{{ timelineItems[0].title }}</span>
        </div>
        <div class="flex flex-shrink-0 items-center gap-1">
          <button class="rounded px-2 py-1 text-text-secondary hover:bg-hover hover:text-foreground" @click="openDrawer('context')">上下文</button>
          <button class="rounded border border-border/60 bg-header/30 px-2 py-1 text-text-secondary hover:bg-hover hover:text-foreground" @click="compactContext">压缩</button>
        </div>
      </div>
      <details v-if="latestToolRuns.length > 0" class="ai-tool-details group mt-1 rounded border border-border/50 bg-header/20 px-2 py-1">
        <summary class="flex cursor-pointer list-none items-center justify-between gap-2 text-[11px]">
          <span class="min-w-0 truncate text-text-secondary">工具调用 · 最近 {{ latestToolRuns.length }} 条</span>
          <span class="flex-shrink-0 text-text-secondary">展开详情</span>
        </summary>
        <div class="mt-1 max-h-64 space-y-1 overflow-y-auto border-t border-border/50 pt-1">
          <details v-for="run in latestToolRuns" :key="run.id" class="rounded border border-border/40 bg-background/60 px-2 py-1.5 text-[11px]">
            <summary class="flex cursor-pointer list-none items-center justify-between gap-2">
              <span class="min-w-0 truncate font-medium text-foreground">{{ formatToolName(run.name) }} · {{ formatToolStatus(run.status) }}</span>
              <span class="flex-shrink-0 text-text-secondary">{{ formatToolDuration(run) }}</span>
            </summary>
            <div class="mt-0.5 truncate font-mono text-text-secondary">{{ formatToolSummary(run) }}</div>
            <div class="mt-2 border-t border-border/40 pt-2">
              <div class="mb-1 flex items-center justify-between gap-2 text-text-secondary"><span>调用参数</span><button v-if="getToolCommand(run)" class="rounded border border-border px-1.5 py-0.5 hover:bg-hover" @click="copyText(getToolCommand(run))">复制命令</button></div>
              <pre class="max-h-28 overflow-auto whitespace-pre-wrap break-words rounded bg-header/40 p-1.5 font-mono text-[10px] text-foreground">{{ formatToolArguments(run) }}</pre>
              <div class="mb-1 mt-2 text-text-secondary">返回内容（已截断）</div>
              <pre class="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-header/40 p-1.5 font-mono text-[10px] text-foreground">{{ formatToolResult(run) }}</pre>
              <div v-if="run.error" class="mt-1 break-words text-error">失败：{{ run.error }}</div>
            </div>
          </details>
        </div>
      </details>
      <div class="ai-compression-details group mt-2 rounded border border-border/50 bg-header/20 px-2 py-1.5 text-[11px] text-text-secondary">
        <div class="flex items-center justify-between gap-2">
          <label class="group flex min-w-0 items-center gap-2" title="越低越早压缩上下文">
            <span class="flex-shrink-0">自动压缩阈值</span>
            <input
              v-model.number="config.compactTriggerPercent"
              type="range"
              min="1"
              max="80"
              class="w-0 min-w-0 flex-none accent-primary opacity-0 transition-all group-hover:w-24 group-hover:opacity-100 group-focus-within:w-24 group-focus-within:opacity-100"
              aria-label="自动压缩阈值"
            />
          </label>
          <span class="flex-shrink-0 font-medium text-foreground">{{ compactTriggerPercent }}%</span>
        </div>
        <div class="mt-1 flex items-center justify-between gap-2 text-[10px] text-text-secondary/80">
          <label class="group flex min-w-0 flex-1 items-center gap-2" title="允许的最大 AI 请求大小">
            <span class="flex-shrink-0">请求上限</span>
            <input
              v-model.number="config.maxRequestKb"
              type="range"
              min="64"
              max="1024"
              step="16"
              class="w-0 min-w-0 flex-none accent-primary opacity-0 transition-all group-hover:w-24 group-hover:opacity-100 group-focus-within:w-24 group-focus-within:opacity-100"
              aria-label="AI 请求大小上限"
            />
          </label>
          <span class="flex-shrink-0 font-medium text-foreground">{{ maxRequestKb }}KB</span>
        </div>
        <div class="mt-1 flex items-center justify-between gap-2 text-[10px] text-text-secondary/80">
          <label class="group flex min-w-0 flex-1 items-center gap-2" title="同一条用户消息触发的整轮任务里，最多自动压缩几次">
            <span class="flex-shrink-0">本轮最多压缩</span>
            <input
              v-model.number="config.maxAutoCompactsPerTask"
              type="range"
              min="1"
              max="5"
              step="1"
              class="w-0 min-w-0 flex-none accent-primary opacity-0 transition-all group-hover:w-24 group-hover:opacity-100 group-focus-within:w-24 group-focus-within:opacity-100"
              aria-label="每轮任务最多自动压缩次数"
            />
          </label>
          <span class="flex-shrink-0 font-medium text-foreground">{{ maxAutoCompactsPerTask }} 次</span>
        </div>
        <div v-if="compression" class="ai-compression-stats mt-1 grid max-h-0 grid-cols-2 gap-x-3 gap-y-0.5 overflow-hidden opacity-0 transition-all duration-200 group-hover:max-h-24 group-hover:opacity-100 group-focus-within:max-h-24 group-focus-within:opacity-100">
          <span>上次压缩前：{{ formatBytes(compression.beforeBytes) }}</span>
          <span>压缩后：{{ formatBytes(compression.afterBytes) }}</span>
          <span>处理：{{ compression.compactedCount }} 条</span>
          <span>保留：{{ compression.retainedCount }} 条</span>
          <span class="col-span-2">摘要：{{ summaryModeLabel }} · {{ new Date(compression.at).toLocaleString() }}</span>
        </div>
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
        v-for="(message, index) in conversationMessages"
        :key="index"
        class="flex"
        :class="message.role === 'user' ? 'justify-end' : message.role === 'assistant' ? 'justify-start' : 'justify-center'"
      >
        <div
          class="max-w-[88%] rounded border px-3 py-2 shadow-sm"
          :class="messageShellClass(message.role)"
        >
          <div class="mb-1 flex items-center gap-1.5 text-xs font-medium" :class="messageLabelClass(message.role)">
            <img
              v-if="message.role === 'assistant'"
              :src="nexusAiAvatar"
              alt="Nexus AI"
              class="h-6 w-6 flex-shrink-0 rounded-full border border-primary/50 object-cover shadow-sm shadow-primary/30"
            />
            <span
              v-else
              class="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border text-[11px]"
              :class="messageAvatarClass(message.role)"
              :title="messageLabel(message.role)"
            >
              <i :class="messageIconClass(message.role)" aria-hidden="true" />
            </span>
            <span>{{ messageLabel(message.role) }}</span>
          </div>
          <div
            class="ai-message-content break-words text-sm leading-relaxed"
            v-html="renderMarkdown(message.content || (message.tool_calls ? '正在调用终端工具...' : ''))"
          />
          <div v-if="message.role === 'assistant' && extractCommandBlocks(message.content).length > 0" class="mt-3 space-y-2">
            <div
              v-for="command in extractCommandBlocks(message.content)"
              :key="command"
              class="rounded border border-border/70 bg-header/30 p-2"
            >
              <div class="mb-2 flex items-center justify-between gap-2">
                <span
                  class="rounded border px-1.5 py-0.5 text-[11px]"
                  :class="formatRiskClass(detectCommandRisk(command))"
                >
                  {{ formatRiskLabel(detectCommandRisk(command)) }}
                </span>
                <div class="flex flex-shrink-0 gap-1">
                  <button class="rounded border border-border px-2 py-1 text-[11px] hover:bg-hover" @click="copyText(command)">复制</button>
                  <button class="rounded border border-border px-2 py-1 text-[11px] hover:bg-hover" @click="fillCommandInput(command)">输入终端</button>
                </div>
              </div>
              <pre class="overflow-auto whitespace-pre-wrap break-words rounded bg-black/20 p-2 font-mono text-xs leading-relaxed">{{ command }}</pre>
            </div>
          </div>
        </div>
      </div>

      <div v-if="isRunning && activeActivities.length > 0" class="mr-auto max-w-[88%] rounded border border-border/70 bg-header/35 px-3 py-2 text-xs text-text-secondary shadow-sm">
        <div class="mb-1 flex items-center gap-1.5 font-medium text-foreground">
          <img :src="nexusAiAvatar" alt="Nexus AI" class="h-5 w-5 rounded-full border border-primary/40 object-cover" />
          <span>Nexus AI · 运行动态</span>
        </div>
        <div class="space-y-1.5">
          <div v-for="activity in activeActivities" :key="activity.id" class="flex items-start gap-2">
            <span
              class="mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full"
              :class="activity.state === 'error' ? 'bg-error' : activity.state === 'done' ? 'bg-success' : 'animate-pulse bg-primary'"
            />
            <div class="min-w-0">
              <div class="text-foreground">{{ activity.title }}</div>
              <div v-if="activity.detail" class="mt-0.5 truncate text-[11px] text-text-secondary">{{ activity.detail }}</div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="errorMessage" class="rounded border border-error/40 bg-error/10 p-2.5 text-error">
        <div class="flex items-center justify-between gap-2">
          <span class="min-w-0 truncate text-sm font-semibold">{{ continuationAvailable ? 'AI 输出已截断' : 'AI 执行出错' }}：{{ errorMessage }}</span>
          <span class="flex-shrink-0 text-[11px] text-error/70">需处理</span>
        </div>
        <details class="mt-1 text-[11px]">
          <summary class="cursor-pointer text-error/80">查看原因与建议</summary>
          <div class="mt-1 rounded border border-error/20 bg-background/50 px-2 py-1.5 text-text-secondary">
            {{ continuationAvailable ? '已保存当前已收到的内容，可以从中断位置继续生成。' : '建议先重新读取终端确认状态；如果是上下文过大或历史污染，再清理上下文后重试。' }}
          </div>
        </details>
        <div class="mt-2 flex flex-wrap gap-2 text-xs">
          <button v-if="continuationAvailable" class="rounded border border-primary/50 px-2 py-1 text-primary hover:bg-primary/10" @click="continueLastResponse">继续生成</button>
          <button class="rounded border border-error/40 px-2 py-1 hover:bg-error/10" @click="rereadTerminal">重新读取终端</button>
          <button class="rounded border border-error/40 px-2 py-1 hover:bg-error/10 disabled:opacity-50" :disabled="!lastUserPrompt" @click="retryLastPrompt">重试上一轮</button>
          <button class="rounded border border-error/40 px-2 py-1 hover:bg-error/10 disabled:opacity-50" :disabled="!lastUserPrompt" @click="compactAndRetry">清理上下文后重试</button>
          <button class="rounded border border-error/40 px-2 py-1 hover:bg-error/10" @click="switchReadOnly">切换只读模式</button>
        </div>
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
            上下文与记忆
          </div>
          <button class="rounded px-2 py-1 text-xs hover:bg-hover" @click="closeDrawer">关闭</button>
        </div>

        <div v-if="drawerPanel === 'context'" class="flex-1 overflow-auto p-3 text-xs">
          <div class="mb-3 flex flex-wrap gap-2">
            <button class="rounded bg-primary px-3 py-1.5 text-white" @click="compactContext">压缩上下文</button>
            <button class="rounded border border-error/40 px-3 py-1.5 text-error hover:bg-error/10" @click="deleteHistory">删除历史</button>
            <button class="rounded border border-border px-3 py-1.5 hover:bg-hover" @click="exportJson">导出 JSON</button>
            <button class="rounded border border-border px-3 py-1.5 hover:bg-hover" @click="exportMarkdown">导出 Markdown</button>
            <button class="rounded border border-border px-3 py-1.5 hover:bg-hover" @click="openImportDialog">导入 JSON</button>
            <button class="rounded border border-border px-3 py-1.5 hover:bg-hover" @click="openCurrentHistoryDirectory">打开当前终端目录</button>
          </div>
          <div v-if="hasMemorySummary" class="rounded border border-border/60 p-2">
            <div class="mb-2 font-medium text-text-secondary">记忆摘要</div>
            <pre class="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words font-sans leading-relaxed">{{ memorySummary }}</pre>
          </div>
          <div v-else class="rounded border border-dashed border-border p-3 text-text-secondary">
            当前会话还没有记忆摘要。
          </div>
        </div>

      </aside>
    </div>

    <div class="border-t border-primary/40 bg-header/20 p-2.5 shadow-[0_-2px_12px_rgba(0,0,0,0.08)]">
      <textarea
        ref="textareaInput"
        v-model="userInput"
        class="mb-1.5 h-16 w-full resize-none rounded border border-primary/50 bg-input px-2.5 py-2 text-sm text-foreground outline-none transition placeholder:text-text-secondary/70 focus:border-primary focus:ring-2 focus:ring-primary/30"
        :placeholder="isRunning ? '输入补充要求，发送后将在当前步骤结束时应用' : '例如：查看当前报错，直接输入排查命令并修复'"
        @keydown="handleInputKeydown"
      />
      <div class="mb-1.5 flex items-center justify-between gap-2 text-xs">
        <div class="flex min-w-0 items-center gap-1.5">
          <span class="h-1.5 w-1.5 flex-shrink-0 rounded-full" :class="hasActiveTerminal ? 'bg-success' : 'bg-error'" />
          <span class="truncate font-medium text-foreground">{{ sessionLabel }}</span>
        </div>
        <div class="flex flex-shrink-0 items-center gap-2">
          <label class="flex items-center gap-1.5 text-text-secondary" title="允许 AI 使用不会显示在终端中的后台命令和批量命令工具">
            <input v-model="config.enableBackgroundTools" type="checkbox" class="accent-primary" :disabled="isRunning" />
            <span>后台工具</span>
          </label>
          <div ref="modeMenuRef" class="relative">
          <button
            type="button"
            class="flex items-center gap-1.5 rounded border border-border bg-input px-2 py-1 text-foreground transition-colors hover:bg-hover"
            :aria-expanded="modeMenuOpen"
            aria-haspopup="menu"
            @click="modeMenuOpen = !modeMenuOpen"
          >
            <span class="text-text-secondary">模式</span>
            <span class="font-medium">{{ activeModeOption.label }}</span>
            <i class="fas text-[10px] text-text-secondary" :class="modeMenuOpen ? 'fa-chevron-down' : 'fa-chevron-up'" aria-hidden="true" />
          </button>
          <div
            v-if="modeMenuOpen"
            role="menu"
            class="absolute bottom-full right-0 z-30 mb-1 w-44 overflow-hidden rounded border border-border bg-background py-1 shadow-xl"
          >
            <button
              v-for="option in modeOptions"
              :key="option.value"
              type="button"
              role="menuitemradio"
              :aria-checked="runMode === option.value"
              class="flex w-full items-start gap-2 px-2.5 py-2 text-left text-xs transition-colors hover:bg-hover"
              :class="runMode === option.value ? 'bg-primary/15 text-primary' : 'text-foreground'"
              @click="selectRunMode(option.value)"
            >
              <span class="mt-0.5 h-1.5 w-1.5 flex-shrink-0 rounded-full" :class="runMode === option.value ? 'bg-primary' : 'bg-border'" />
              <span>
                <span class="block font-medium">{{ option.label }}</span>
                <span class="mt-0.5 block text-[11px] text-text-secondary">{{ option.description }}</span>
              </span>
            </button>
          </div>
        </div>
        </div>
      </div>
      <div class="mb-1.5 flex items-center justify-between gap-2 text-[11px] text-text-secondary">
        <span>{{ isRunning ? 'Enter 追加引导 · 当前步骤结束后生效' : 'Enter 发送 · Shift+Enter 换行' }}</span>
        <span :class="isRunning ? 'text-primary' : 'text-text-secondary'">AI {{ isRunning ? '运行中' : '空闲' }}</span>
      </div>
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
          v-if="isRunning"
          class="rounded border border-primary/60 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
          :disabled="!canQueueGuidance"
          @click="sendMessage"
        >
          追加引导
        </button>
        <button
          class="rounded border border-border px-3 py-2 text-sm font-medium hover:bg-hover disabled:opacity-60"
          :class="isRunning ? 'col-span-2' : ''"
          :disabled="!hasActiveTerminal"
          @click="interruptTerminal"
        >
          Ctrl+C 终端
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-tool-details[open] .ai-tool-details-body,
.ai-compression-details:focus-within .ai-compression-stats {
  max-height: 12rem;
  padding-top: 0.25rem;
  opacity: 1;
}
</style>
