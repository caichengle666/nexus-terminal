<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { useAiStore, type AiTaskStatus, type AiToolRun } from '../stores/ai.store';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import nexusAiAvatar from '../assets/nexus-ai-avatar.jpg';
import { MAX_IMPORT_FILE_BYTES } from '../stores/ai/ai.constants';
import { describeAiError } from '../stores/ai/ai.errors';
import { useKeyboardInset } from '../composables/useKeyboardInset';

const props = withDefaults(defineProps<{ mobileOverlay?: boolean }>(), {
  mobileOverlay: false,
});
const emit = defineEmits<{ (event: 'close-mobile-overlay'): void }>();

const aiStore = useAiStore();
const { t } = useI18n();
// Keeps the full-screen mobile overlay (and its input) above the on-screen keyboard.
useKeyboardInset(() => props.mobileOverlay);
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
  contextRequestBytes,
  compactTriggerPercent,
  maxRequestKb,
  maxAutoCompactsPerTask,
  runMode,
  config,
  activeSession,
  activeSessionId,
  activeModelId,
  canSend,
  canQueueGuidance,
  hasActiveTerminal,
  continuationAvailable,
  pendingPromptProposal,
} = storeToRefs(aiStore);

const modeMenuOpen = ref(false);
const modeMenuRef = ref<HTMLElement | null>(null);
const modelMenuOpen = ref(false);
const modelMenuRef = ref<HTMLElement | null>(null);
const moreMenuOpen = ref(false);
const moreMenuRef = ref<HTMLElement | null>(null);
const contextExpanded = ref(false);
const promptSettingsExpanded = ref(false);
const toolRenderLimit = ref(20);
const importFileInput = ref<HTMLInputElement | null>(null);
const modeOptions = computed(() => ([
  { value: 'readOnly', label: t('aiAssistant.mode.readOnly'), description: t('aiAssistant.mode.readOnlyDesc') },
  { value: 'confirm', label: t('aiAssistant.mode.confirm'), description: t('aiAssistant.mode.confirmDesc') },
  { value: 'auto', label: t('aiAssistant.mode.auto'), description: t('aiAssistant.mode.autoDesc') },
] as const));
const activeModeOption = computed(() => modeOptions.value.find(option => option.value === runMode.value) || modeOptions.value[1]);
const conversationMessages = computed(() => visibleMessages.value.filter(message => (
  message.role !== 'assistant' || !!message.content?.trim() || !message.tool_calls?.length
)));
const conversationScroller = ref<HTMLElement | null>(null);
const shouldAutoFollow = ref(true);
let scrollFrame: number | null = null;
const scrollConversationToBottom = () => {
  if (scrollFrame !== null) return;
  scrollFrame = window.requestAnimationFrame(() => {
    scrollFrame = null;
    const scroller = conversationScroller.value;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  });
};
const handleConversationScroll = () => {
  const scroller = conversationScroller.value;
  if (!scroller) return;
  shouldAutoFollow.value = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 48;
};

watch(
  () => [
    conversationMessages.value.length,
    conversationMessages.value.at(-1)?.content?.length || 0,
    activeActivities.value.length,
    errorMessage.value,
  ],
  () => {
    if (shouldAutoFollow.value) void scrollConversationToBottom();
  },
);
watch(activeSessionId, () => {
  shouldAutoFollow.value = true;
  toolRenderLimit.value = 20;
  void scrollConversationToBottom();
});

const selectRunMode = (mode: typeof runMode.value) => {
  runMode.value = mode;
  modeMenuOpen.value = false;
};

const handleDocumentPointerDown = (event: PointerEvent) => {
  if (!modeMenuRef.value?.contains(event.target as Node)) modeMenuOpen.value = false;
  if (!modelMenuRef.value?.contains(event.target as Node)) modelMenuOpen.value = false;
  if (!moreMenuRef.value?.contains(event.target as Node)) moreMenuOpen.value = false;
};

const closePopupMenus = () => {
  modeMenuOpen.value = false;
  modelMenuOpen.value = false;
  moreMenuOpen.value = false;
};

const focusFirstPopupItem = (container: HTMLElement | null) => {
  void nextTick(() => container?.querySelector<HTMLButtonElement>('[role="menu"] button, [role="listbox"] button')?.focus());
};

watch(activeSessionId, closePopupMenus);

const handleDocumentKeydown = (event: KeyboardEvent) => {
  if (event.key !== 'Escape') return;
  closePopupMenus();
  showConfig.value = false;
  drawerPanel.value = null;
};

const handlePopupMenuKeydown = (event: KeyboardEvent) => {
  const menu = event.currentTarget as HTMLElement;
  const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
  if (event.key === 'Escape') {
    event.preventDefault();
    closePopupMenus();
    menu.parentElement?.querySelector<HTMLButtonElement>(':scope > button')?.focus();
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || buttons.length === 0) return;
  event.preventDefault();
  const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const nextIndex = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? buttons.length - 1
      : event.key === 'ArrowDown'
        ? (currentIndex + 1 + buttons.length) % buttons.length
        : (currentIndex - 1 + buttons.length) % buttons.length;
  buttons[nextIndex]?.focus();
};

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointerDown);
  document.addEventListener('keydown', handleDocumentKeydown);
  void scrollConversationToBottom();
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown);
  document.removeEventListener('keydown', handleDocumentKeydown);
  if (scrollFrame !== null) window.cancelAnimationFrame(scrollFrame);
  if (copiedTimer !== null) window.clearTimeout(copiedTimer);
});

const sessionLabel = computed(() => activeSession.value?.connectionName || t('aiAssistant.noActiveTerminal'));
const contextLimitBytes = computed(() => maxRequestKb.value * 1024);
const contextUsagePercent = computed(() => contextLimitBytes.value > 0
  ? Math.min(100, Math.round((contextRequestBytes.value / contextLimitBytes.value) * 100))
  : 0);
const hasMemorySummary = computed(() => !!memorySummary.value.trim());
const formatBytes = (bytes?: number) => {
  if (!bytes) return '0 KB';
  return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
};
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
const currentActivityId = computed(() => [...activeActivities.value]
  .reverse()
  .find(activity => activity.state === 'active')?.id || null);
const renderedToolRuns = computed(() => latestToolRuns.value.slice(0, toolRenderLimit.value));
const hasMoreToolRuns = computed(() => toolRenderLimit.value < latestToolRuns.value.length);
const loadMoreToolRuns = () => {
  toolRenderLimit.value = Math.min(toolRenderLimit.value + 20, latestToolRuns.value.length);
};

const quickTasks = computed(() => [
  { label: t('aiAssistant.quick.checkService'), prompt: t('aiAssistant.quick.checkServicePrompt') },
  { label: t('aiAssistant.quick.analyzeError'), prompt: t('aiAssistant.quick.analyzeErrorPrompt') },
  { label: t('aiAssistant.quick.readAndContinue'), prompt: t('aiAssistant.quick.readAndContinuePrompt') },
]);

const formatToolName = (name: string) => {
  if (name === 'get_terminal_output') return t('aiAssistant.tool.get_terminal_output');
  if (name === 'wait_for_terminal_output') return t('aiAssistant.tool.wait_for_terminal_output');
  if (name === 'terminal_input') return t('aiAssistant.tool.terminal_input');
  if (name === 'execute_command') return t('aiAssistant.tool.execute_command');
  if (name === 'send_terminal_key') return t('aiAssistant.tool.send_terminal_key');
  if (name === 'read_remote_file') return t('aiAssistant.tool.read_remote_file');
  if (name === 'list_remote_directory') return t('aiAssistant.tool.list_remote_directory');
  if (name === 'list_active_terminals') return t('aiAssistant.tool.list_active_terminals');
  if (name === 'execute_command_batch') return t('aiAssistant.tool.execute_command_batch');
  if (name === 'propose_system_prompt_update') return t('aiAssistant.tool.propose_system_prompt_update');
  return name;
};

const formatToolStatus = (status: AiToolRun['status']) => {
  if (status === 'running') return t('aiAssistant.toolStatus.running');
  if (status === 'done') return t('aiAssistant.toolStatus.done');
  if (status === 'cancelled') return t('aiAssistant.toolStatus.cancelled');
  return t('aiAssistant.toolStatus.error');
};

const formatTaskStatus = (status: AiTaskStatus) => {
  if (status === 'thinking') return t('aiAssistant.taskStatus.thinking');
  if (status === 'awaitingConfirmation') return t('aiAssistant.taskStatus.awaitingConfirmation');
  if (status === 'runningTool') return t('aiAssistant.taskStatus.runningTool');
  if (status === 'waitingOutput') return t('aiAssistant.taskStatus.waitingOutput');
  if (status === 'compressing') return t('aiAssistant.taskStatus.compressing');
  if (status === 'done') return t('aiAssistant.taskStatus.done');
  if (status === 'stopped') return t('aiAssistant.taskStatus.stopped');
  if (status === 'interrupted') return t('aiAssistant.taskStatus.interrupted');
  if (status === 'error') return t('aiAssistant.taskStatus.error');
  return t('aiAssistant.taskStatus.idle');
};

const activityTextClass = (activity: { id: string; state: 'active' | 'done' | 'error' }) => {
  if (activity.state === 'error') return 'text-error';
  if (activity.state === 'done') return 'text-success';
  if (activity.id !== currentActivityId.value) return 'text-text-secondary';
  if (taskStatus.value === 'awaitingConfirmation') return 'text-warning';
  if (taskStatus.value === 'runningTool' || taskStatus.value === 'waitingOutput') return 'text-link-active';
  return 'text-primary';
};

const activityDotClass = (activity: { id: string; state: 'active' | 'done' | 'error' }) => {
  if (activity.state === 'error') return 'bg-error';
  if (activity.state === 'done') return 'bg-success';
  if (activity.id !== currentActivityId.value) return 'bg-text-secondary/60';
  if (taskStatus.value === 'awaitingConfirmation') return 'animate-pulse bg-warning';
  if (taskStatus.value === 'runningTool' || taskStatus.value === 'waitingOutput') return 'animate-pulse bg-link-active';
  return 'animate-pulse bg-primary';
};

const formatToolSummary = (run: AiToolRun) => {
  if (run.name === 'terminal_input') {
    const text = typeof run.args.text === 'string' ? run.args.text : '';
    return text.length > 140 ? `${text.slice(0, 140)}...` : text;
  }
  if (run.name === 'get_terminal_output') {
    return t('aiAssistant.toolSummary.readLines', { count: run.args.maxLines || 120 });
  }
  if (run.name === 'wait_for_terminal_output') {
    const seconds = Math.max(0.2, Number(run.args.timeoutMs || 15000) / 1000);
    return t('aiAssistant.toolSummary.maxWait', { seconds: seconds.toFixed(1) });
  }
  if (run.name === 'execute_command') {
    const command = typeof run.args.command === 'string' ? run.args.command : '';
    return command.length > 140 ? `${command.slice(0, 140)}...` : command;
  }
  if (run.name === 'send_terminal_key') return String(run.args.key || t('aiAssistant.toolSummary.noKey'));
  if (run.name === 'read_remote_file') return String(run.args.path || t('aiAssistant.toolSummary.noPath'));
  if (run.name === 'list_remote_directory') return String(run.args.path || t('aiAssistant.toolSummary.noPath'));
  if (run.name === 'execute_command_batch') {
    const count = Array.isArray(run.args.targetSessionIds) ? run.args.targetSessionIds.length : 0;
    return t('aiAssistant.toolSummary.batch', { count, command: String(run.args.command || '').slice(0, 100) });
  }
  if (run.name === 'propose_system_prompt_update') return String(run.args.reason || t('aiAssistant.toolSummary.awaitingReview'));
  if (run.name === 'list_active_terminals') return t('aiAssistant.toolSummary.listTabs');
  return JSON.stringify(run.args);
};

const formatToolDuration = (run: AiToolRun) => {
  if (!run.finishedAt) return t('aiAssistant.toolStatus.running');
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
  return text.length > 2400 ? `${text.slice(0, 2400)}\n...${t('aiAssistant.toolResultTruncated')}` : text || t('aiAssistant.toolResultEmpty');
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
  if (risk === 'danger') return t('aiAssistant.risk.danger');
  if (risk === 'confirm') return t('aiAssistant.risk.confirm');
  return t('aiAssistant.risk.normal');
};

const formatRiskClass = (risk: string) => {
  if (risk === 'danger') return 'border-error/60 bg-error/15 text-error';
  if (risk === 'confirm') return 'border-warning/60 bg-warning/15 text-warning';
  return 'border-success/50 bg-success/10 text-success';
};

const messageLabel = (role: string) => {
  if (role === 'user') return t('aiAssistant.role.user');
  if (role === 'assistant') return 'Nexus AI';
  if (role === 'tool') return t('aiAssistant.role.tool');
  if (role === 'system') return t('aiAssistant.role.system');
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
  if (role === 'user') return 'ml-auto max-w-[78%] rounded-lg rounded-br-sm border border-primary/35 bg-primary/12 px-3 py-2 text-foreground';
  if (role === 'assistant') return 'mr-auto w-full max-w-full border-0 bg-transparent px-0 py-0 text-foreground';
  if (role === 'tool') return 'mx-auto max-w-[92%] rounded border border-warning/40 bg-warning/10 px-3 py-2 text-warning';
  if (role === 'system') return 'mx-auto max-w-[92%] rounded border border-border/60 bg-header/40 px-3 py-2 text-text-secondary';
  return 'mr-auto rounded border border-border/70 bg-header/30 px-3 py-2 text-foreground';
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

type MessageRenderCache = {
  source: string;
  html: string;
  commandBlocks: string[];
};
const messageRenderCache = new WeakMap<object, MessageRenderCache>();

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

const getMessageRenderCache = (message: object & { content?: string | null; tool_calls?: unknown[] }) => {
  const source = message.content || (message.tool_calls?.length ? t('aiAssistant.callingTools') : '');
  const cached = messageRenderCache.get(message);
  if (cached?.source === source) return cached;
  const next = {
    source,
    html: renderMarkdown(source),
    commandBlocks: extractCommandBlocks(message.content),
  };
  messageRenderCache.set(message, next);
  return next;
};

const copiedKey = ref('');
let copiedTimer: number | null = null;
const copyText = async (text: string, key = 'default') => {
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    errorMessage.value = t('aiAssistant.copyFailed');
    return;
  }
  copiedKey.value = key;
  if (copiedTimer !== null) window.clearTimeout(copiedTimer);
  copiedTimer = window.setTimeout(() => {
    copiedKey.value = '';
    copiedTimer = null;
  }, 1600);
};

const fillCommandInput = (command: string) => {
  const normalized = command.trim();
  if (!normalized) return;
  if (/\r|\n/.test(normalized)) {
    errorMessage.value = t('aiAssistant.multilineNotAllowed');
    return;
  }
  const sender = activeSession.value?.terminalManager?.sendData;
  if (sender) {
    sender(normalized);
    return;
  }
  errorMessage.value = t('aiAssistant.noTerminalForInput');
};

const openDrawer = (panel: Exclude<DrawerPanel, null>) => {
  showConfig.value = false;
  drawerPanel.value = drawerPanel.value === panel ? null : panel;
};

const closeDrawer = () => {
  drawerPanel.value = null;
};

const openSettingsDrawer = () => {
  drawerPanel.value = null;
  configError.value = '';
  showConfig.value = true;
};

// Errors from settings-drawer actions stay in the drawer instead of the chat area.
const configError = ref('');
const configBusy = ref(false);
const runConfigAction = async (action: () => Promise<unknown>, fallback: string) => {
  if (configBusy.value) return;
  configBusy.value = true;
  configError.value = '';
  try {
    await action();
  } catch (error: any) {
    configMessage.value = '';
    configError.value = describeAiError(error, fallback);
  } finally {
    configBusy.value = false;
  }
};

const closeSettingsDrawer = () => {
  showConfig.value = false;
};


const confirmAiCommand = async ({ command, reason, riskReason, riskLevel, connectionName, signal }: { command: string; reason: string; riskReason?: string; riskLevel: string; connectionName?: string; signal?: AbortSignal }) => showConfirmDialog({
  title: riskLevel === 'risky' ? t('aiAssistant.confirm.riskyTitle') : t('aiAssistant.confirm.title'),
  message: [
    t('aiAssistant.confirm.target', { name: connectionName || sessionLabel.value }),
    '',
    command,
    '',
    t('aiAssistant.confirm.reason', { reason }),
    riskReason ? t('aiAssistant.confirm.risk', { risk: riskReason }) : '',
    '',
    t('aiAssistant.confirm.note'),
  ].filter(Boolean).join('\n'),
  confirmText: t('aiAssistant.confirm.run'),
  cancelText: t('aiAssistant.common.cancel'),
  signal,
});

const sendMessage = () => {
  shouldAutoFollow.value = true;
  void scrollConversationToBottom();
  return aiStore.sendMessage({ confirmCommand: confirmAiCommand });
};

const handleInputKeydown = (event: KeyboardEvent) => {
  // Enter that confirms an IME composition (Chinese/Japanese input) must not send.
  if (event.isComposing || event.keyCode === 229) return;
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
    title: t('aiAssistant.stop.title'),
    message: t('aiAssistant.stop.message'),
    confirmText: t('aiAssistant.stop.alsoCtrlC'),
    cancelText: t('aiAssistant.stop.onlyAi'),
  });
  if (confirmed) {
    aiStore.sendInterruptToTerminal(runSessionId);
  }
  refocusInput();
};

const interruptTerminal = async () => {
  const confirmed = await showConfirmDialog({
    title: t('aiAssistant.interrupt.title'),
    message: t('aiAssistant.interrupt.message'),
    confirmText: t('aiAssistant.interrupt.send'),
    cancelText: t('aiAssistant.common.cancel'),
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
      title: t('aiAssistant.compact.doneTitle'),
      message: t('aiAssistant.compact.doneMessage', {
        compacted: result.compactedCount || 0,
        retained: result.retainedCount || 0,
        before: formatBytes(result.requestBytes),
        after: formatBytes(result.finalRequestBytes),
        limit: formatBytes(result.hardLimitBytes),
        source: result.summaryMode === 'ai' ? 'AI' : t('aiAssistant.compact.sourceLocal'),
      }),
      confirmText: t('aiAssistant.common.gotIt'),
      cancelText: t('aiAssistant.common.close'),
    });
  } else if (result.reason !== 'underBudget') {
    await showConfirmDialog({
      title: result.reason === 'empty' ? t('aiAssistant.compact.emptyTitle') : t('aiAssistant.compact.underTitle'),
      message: result.reason === 'empty'
        ? t('aiAssistant.compact.emptyMessage')
        : t('aiAssistant.compact.underMessage', { size: Math.ceil(result.requestBytes / 1024), threshold: Math.floor(result.thresholdBytes / 1024) }),
      confirmText: t('aiAssistant.common.gotIt'),
      cancelText: t('aiAssistant.common.close'),
    });
  }
  drawerPanel.value = 'context';
};

const useQuickTask = (task: string) => {
  userInput.value = task;
};

const rereadTerminal = () => {
  userInput.value = t('aiAssistant.rereadPrompt');
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

const continueLastResponse = () => aiStore.continueLastResponse({ confirmCommand: confirmAiCommand });

const saveConfig = () => runConfigAction(() => aiStore.saveConfig(), t('aiAssistant.errors.saveConfig'));

const selectHistoryDirectory = async () => {
  const result = await (window as any).electronAPI?.selectDirectory?.();
  if (!result?.canceled && result?.path) historyConfig.value.storagePath = result.path;
};

const saveHistoryConfig = () => runConfigAction(() => aiStore.saveHistoryConfig(), t('aiAssistant.errors.saveHistoryConfig'));

const openCurrentHistoryDirectory = async () => {
  try {
    const directory = await aiStore.getCurrentHistoryDirectory();
    const result = await (window as any).electronAPI?.openPath?.(directory);
    if (!result?.ok && result?.error) throw new Error(result.error);
    if (!(window as any).electronAPI?.openPath) {
      await showConfirmDialog({ title: t('aiAssistant.historyDirTitle'), message: directory, confirmText: t('aiAssistant.common.gotIt'), cancelText: t('aiAssistant.common.close') });
    }
  } catch (error: any) {
    configError.value = error.message || t('aiAssistant.errors.openHistoryDir');
  }
};

const testConfig = () => runConfigAction(() => aiStore.testConfig(), t('aiAssistant.errors.testConfig'));

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
  title: t('aiAssistant.export.title'),
  message: t('aiAssistant.export.message'),
  confirmText: t('aiAssistant.export.continue'),
  cancelText: t('aiAssistant.common.cancel'),
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
    t('aiAssistant.md.title'),
    '',
    t('aiAssistant.md.terminal', { name: data.connectionName }),
    t('aiAssistant.md.exportedAt', { time: data.exportedAt }),
    '',
    t('aiAssistant.md.summary'),
    '',
    data.memory.summary || t('aiAssistant.md.noSummary'),
    '',
    t('aiAssistant.md.messages'),
    '',
  ];
  data.memory.messages.forEach(message => {
    const label = message.role === 'user' ? t('aiAssistant.md.roleUser') : message.role === 'assistant' ? 'AI' : message.role === 'tool' ? t('aiAssistant.md.roleTool') : t('aiAssistant.role.system');
    lines.push(`### ${label}`, '', message.content || (message.tool_calls ? t('aiAssistant.md.calledTools', { tools: message.tool_calls.map(call => call.function.name).join(', ') }) : ''), '');
  });
  lines.push(t('aiAssistant.md.toolRuns'), '');
  data.memory.toolRuns.forEach(run => {
    lines.push(t('aiAssistant.md.toolRunLine', { name: formatToolName(run.name), status: formatToolStatus(run.status), duration: formatToolDuration(run) }));
    if (run.args) lines.push(t('aiAssistant.md.toolArgs', { args: `\`${JSON.stringify(run.args)}\`` }));
    if (run.error) lines.push(t('aiAssistant.md.toolError', { error: run.error }));
  });
  if (data.memory.compression) {
    lines.push('', t('aiAssistant.md.compression'), '', t('aiAssistant.md.compacted', { count: data.memory.compression.compactedCount }), t('aiAssistant.md.retained', { count: data.memory.compression.retainedCount }), t('aiAssistant.md.source', { source: data.memory.compression.summaryMode }));
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
    if (file.size > MAX_IMPORT_FILE_BYTES) throw new Error(t('aiAssistant.import.tooLarge'));
    const data = JSON.parse(await file.text());
    const compatibility = aiStore.checkSessionImport(data);
    if (compatibility.nameMismatch) {
      const confirmedNameMismatch = await showConfirmDialog({
        title: t('aiAssistant.import.nameMismatchTitle'),
        message: t('aiAssistant.import.nameMismatchMessage', { message: compatibility.message }),
        confirmText: t('aiAssistant.import.confirm'),
        cancelText: t('aiAssistant.common.cancel'),
      });
      if (!confirmedNameMismatch) return;
    }
    const confirmed = await showConfirmDialog({
      title: t('aiAssistant.import.title'),
      message: t('aiAssistant.import.message'),
      confirmText: t('aiAssistant.import.replace'),
      cancelText: t('aiAssistant.common.cancel'),
    });
    if (!confirmed) return;
    const result = aiStore.importSessionData(data, 'replace', !!compatibility.nameMismatch);
    await showConfirmDialog({
      title: t('aiAssistant.import.doneTitle'),
      message: t('aiAssistant.import.doneMessage', { messages: result.messageCount, tools: result.toolRunCount }),
      confirmText: t('aiAssistant.common.gotIt'),
      cancelText: t('aiAssistant.common.close'),
    });
  } catch (error: any) {
    await showConfirmDialog({
      title: t('aiAssistant.import.failedTitle'),
      message: error.message || t('aiAssistant.import.failedMessage'),
      confirmText: t('aiAssistant.common.gotIt'),
      cancelText: t('aiAssistant.common.close'),
    });
  }
};

const testStreaming = () => runConfigAction(() => aiStore.testStreaming(), t('aiAssistant.errors.testStreaming'));

const acceptPromptProposal = async () => {
  try {
    await aiStore.acceptPromptProposal();
    promptSettingsExpanded.value = true;
    showConfig.value = true;
  } catch (error: any) {
    errorMessage.value = describeAiError(error, t('aiAssistant.errors.savePrompt'));
  }
};

const rejectPromptProposal = () => {
  aiStore.rejectPromptProposal();
};

const testToolCalling = () => runConfigAction(() => aiStore.testToolCalling(), t('aiAssistant.errors.testTools'));

const deleteHistory = async () => {
  if (isRunning.value) {
    await showConfirmDialog({
      title: t('aiAssistant.delete.runningTitle'),
      message: t('aiAssistant.delete.runningMessage'),
      confirmText: t('aiAssistant.common.gotIt'),
      cancelText: t('aiAssistant.common.close'),
    });
    return;
  }
  const confirmed = await showConfirmDialog({
    title: t('aiAssistant.delete.title'),
    message: t('aiAssistant.delete.message', { name: sessionLabel.value }),
    confirmText: t('aiAssistant.delete.confirm'),
    cancelText: t('aiAssistant.common.cancel'),
  });
  if (confirmed) {
    aiStore.clearChat();
    closeDrawer();
  }
  refocusInput();
};
</script>

<template>
  <div class="ai-terminal-assistant relative flex h-full min-h-0 flex-col bg-background text-foreground">
    <input ref="importFileInput" type="file" accept=".json,application/json" class="hidden" @change="importSessionFile" />
    <div class="ai-assistant-header flex items-center justify-between gap-3 border-b border-border/70 bg-header/20 px-3 py-2.5">
      <div class="ai-header-main flex min-w-0 items-center gap-2.5">
        <button
          v-if="mobileOverlay"
          type="button"
          class="flex flex-shrink-0 items-center justify-center rounded hover:bg-hover"
          :class="mobileOverlay ? 'h-10 w-10' : 'h-8 w-8'"
          :title="t('aiAssistant.ui.backToTerminal')"
          :aria-label="t('aiAssistant.ui.backToTerminal')"
          @click="emit('close-mobile-overlay')"
        >
          <i class="fas fa-arrow-left text-sm text-text-secondary" aria-hidden="true" />
        </button>
        <div class="ai-header-title flex-shrink-0 text-sm font-semibold tracking-tight">{{ t('aiAssistant.ui.title') }}</div>
        <span class="ai-header-divider h-3 w-px flex-shrink-0 bg-border" />
        <div class="ai-header-session min-w-0 truncate text-xs text-text-secondary" :title="sessionLabel">{{ sessionLabel }}</div>
        <div class="ai-header-status flex min-w-0 items-center gap-1.5 text-[11px] text-text-secondary">
          <span class="h-1.5 w-1.5 flex-shrink-0 rounded-full" :class="isRunning ? 'animate-pulse bg-primary' : taskStatus === 'error' ? 'bg-error' : 'bg-success'" />
          <span class="truncate">{{ formatTaskStatus(taskStatus) }}</span>
        </div>
        <div class="ai-header-model min-w-0 truncate text-[10px] text-text-secondary/60" :title="activeModelId || t('aiAssistant.ui.noModel')">
          {{ t('aiAssistant.ui.modelLabel', { model: activeModelId || t('aiAssistant.ui.noModel') }) }}
        </div>
      </div>
      <div class="flex flex-shrink-0 items-center gap-1">
        <button type="button" class="flex items-center justify-center rounded hover:bg-hover" :class="mobileOverlay ? 'h-10 w-10' : 'h-7 w-7'" :title="t('aiAssistant.ui.settings')" :aria-label="t('aiAssistant.ui.settings')" @click="openSettingsDrawer">
          <i class="fas fa-cog text-xs text-text-secondary" aria-hidden="true" />
        </button>
        <div ref="moreMenuRef" class="relative">
          <button type="button" class="flex items-center justify-center rounded hover:bg-hover" :class="mobileOverlay ? 'h-10 w-10' : 'h-7 w-7'" :title="t('aiAssistant.ui.more')" :aria-label="t('aiAssistant.ui.more')" :aria-expanded="moreMenuOpen" @click="moreMenuOpen = !moreMenuOpen" @keydown.down.prevent="moreMenuOpen = true; focusFirstPopupItem(moreMenuRef)">
            <i class="fas fa-ellipsis-v text-xs text-text-secondary" aria-hidden="true" />
          </button>
          <div v-if="moreMenuOpen" role="menu" class="absolute right-0 top-full z-40 mt-1 w-44 overflow-hidden rounded border border-border bg-background py-1 text-xs shadow-xl" @keydown="handlePopupMenuKeydown">
            <button role="menuitem" class="block w-full px-3 py-2 text-left hover:bg-hover" @click="openDrawer('context'); moreMenuOpen = false">{{ t('aiAssistant.ui.contextMemory') }}</button>
            <button role="menuitem" class="block w-full px-3 py-2 text-left hover:bg-hover" @click="exportJson(); moreMenuOpen = false">{{ t('aiAssistant.ui.exportSession') }}</button>
            <button role="menuitem" class="block w-full px-3 py-2 text-left hover:bg-hover" @click="openImportDialog(); moreMenuOpen = false">{{ t('aiAssistant.ui.importSession') }}</button>
            <div class="my-1 border-t border-border" />
            <button role="menuitem" class="block w-full px-3 py-2 text-left text-error hover:bg-error/10" @click="deleteHistory(); moreMenuOpen = false">{{ t('aiAssistant.ui.deleteHistory') }}</button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="showConfig" class="ai-drawer-scrim" @click="closeSettingsDrawer" />
    <aside
      v-if="showConfig"
      class="ai-drawer ai-drawer-settings"
      :aria-label="t('aiAssistant.ui.settings')"
    >
      <div class="ai-drawer-head">
        <div class="ai-drawer-title">{{ t('aiAssistant.ui.settings') }}</div>
        <button type="button" class="ai-drawer-close" :title="t('aiAssistant.ui.closeSettings')" :aria-label="t('aiAssistant.ui.closeSettings')" @click="closeSettingsDrawer">
          <i class="fas fa-xmark" aria-hidden="true" />
        </button>
      </div>
      <div class="ai-drawer-body space-y-2 text-xs">
      <label class="block">
        <span class="mb-1 block text-text-secondary">API Base URL</span>
        <input v-model="config.apiBaseUrl" class="w-full rounded border border-border bg-input px-2 py-1" placeholder="https://api.openai.com/v1" />
      </label>
      <label class="block">
        <span class="mb-1 block text-text-secondary">API Key</span>
        <input v-model="config.apiKey" type="password" class="w-full rounded border border-border bg-input px-2 py-1" placeholder="sk-..." />
        <span v-if="hasSavedApiKey" class="mt-1 block text-success">{{ t('aiAssistant.ui.keySaved') }}</span>
      </label>
      <label class="block">
        <span class="mb-1 block text-text-secondary">Model</span>
        <div class="flex gap-1.5">
          <input v-model="config.model" class="min-w-0 flex-1 rounded border border-primary/40 bg-input px-2 py-1 text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/25" :placeholder="t('aiAssistant.ui.modelPlaceholder')" />
          <button
            type="button"
            class="flex-shrink-0 rounded border border-primary/50 px-2 py-1 text-primary transition hover:bg-primary/10 disabled:cursor-wait disabled:opacity-60"
            :disabled="isFetchingModels"
            @click="fetchModels"
          >
            {{ isFetchingModels ? t('aiAssistant.ui.fetchingModels') : t('aiAssistant.ui.fetchModels') }}
          </button>
        </div>
        <div v-if="availableModels.length > 0" ref="modelMenuRef" class="relative mt-1.5">
          <button
            type="button"
            class="flex w-full items-center justify-between rounded border border-border bg-header/60 px-2 py-1.5 text-left text-xs text-foreground transition hover:border-primary/60 hover:bg-hover"
            :aria-expanded="modelMenuOpen"
            aria-haspopup="listbox"
            @click="modelMenuOpen = !modelMenuOpen"
            @keydown.down.prevent="modelMenuOpen = true; focusFirstPopupItem(modelMenuRef)"
          >
            <span class="truncate">{{ config.model ? t('aiAssistant.ui.pickModelCurrent', { model: config.model }) : t('aiAssistant.ui.pickModel') }}</span>
            <i class="fas ml-2 text-[10px] text-text-secondary" :class="modelMenuOpen ? 'fa-chevron-up' : 'fa-chevron-down'" aria-hidden="true" />
          </button>
          <div v-if="modelMenuOpen" role="listbox" class="absolute left-0 right-0 z-30 mt-1 max-h-48 overflow-auto rounded border border-border bg-background py-1 shadow-xl" @keydown="handlePopupMenuKeydown">
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
      <div class="rounded border border-border/70 bg-header/20">
        <button
          type="button"
          class="flex w-full items-center justify-between gap-2 px-2 py-2 text-left text-foreground hover:bg-hover"
          :aria-expanded="promptSettingsExpanded"
          @click="promptSettingsExpanded = !promptSettingsExpanded"
        >
          <span class="font-medium">{{ t('aiAssistant.ui.customPrompt') }}</span>
          <span class="flex items-center gap-2 text-[11px] text-text-secondary">
            {{ config.customSystemPrompt.length }} / 16384
            <i class="fas text-[10px]" :class="promptSettingsExpanded ? 'fa-chevron-up' : 'fa-chevron-down'" aria-hidden="true" />
          </span>
        </button>
        <div v-if="promptSettingsExpanded" class="border-t border-border/70 p-2">
          <textarea
            v-model="config.customSystemPrompt"
            maxlength="16384"
            rows="6"
            class="w-full resize-y rounded border border-primary/40 bg-input px-2 py-1.5 text-xs leading-relaxed text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/25"
            :placeholder="t('aiAssistant.ui.customPromptPlaceholder')"
          />
          <div class="mt-1 flex items-center justify-between gap-2 text-[10px] text-text-secondary">
            <span>{{ t('aiAssistant.ui.customPromptHint') }}</span>
            <button v-if="config.customSystemPrompt" type="button" class="flex-shrink-0 text-error hover:underline" @click="config.customSystemPrompt = ''">{{ t('aiAssistant.ui.clear') }}</button>
          </div>
        </div>
      </div>
      <div class="rounded border border-border/70 bg-header/20 p-2">
        <div class="mb-2 flex items-center justify-between gap-2">
          <span class="font-medium text-foreground">{{ t('aiAssistant.ui.fileHistory') }}</span>
          <label class="flex items-center gap-1.5 text-text-secondary">
            <input v-model="historyConfig.enabled" type="checkbox" class="accent-primary" />
            {{ t('aiAssistant.ui.enable') }}
          </label>
        </div>
        <p class="mb-2 text-[11px] leading-relaxed text-text-secondary">{{ t('aiAssistant.ui.fileHistoryHint') }}</p>
        <label class="block">
          <span class="mb-1 block text-text-secondary">{{ t('aiAssistant.ui.storageDir') }}</span>
          <div class="flex gap-1.5">
            <input v-model="historyConfig.storagePath" class="min-w-0 flex-1 rounded border border-border bg-input px-2 py-1" :placeholder="t('aiAssistant.ui.storageDirPlaceholder')" />
            <button type="button" class="flex-shrink-0 rounded border border-border px-2 py-1 hover:bg-hover" @click="selectHistoryDirectory">{{ t('aiAssistant.ui.chooseDir') }}</button>
          </div>
          <span v-if="historyConfig.effectiveStoragePath" class="mt-1 block break-all text-[10px] text-text-secondary">{{ t('aiAssistant.ui.currentPath', { path: historyConfig.effectiveStoragePath }) }}</span>
        </label>
        <div class="mt-2 grid grid-cols-2 gap-2">
          <label class="block">
            <span class="mb-1 block text-text-secondary">{{ t('aiAssistant.ui.totalMb') }}</span>
            <input v-model.number="historyConfig.maxStorageMb" type="number" min="50" max="4096" class="w-full rounded border border-border bg-input px-2 py-1" />
          </label>
          <label class="block">
            <span class="mb-1 block text-text-secondary">{{ t('aiAssistant.ui.sessionMb') }}</span>
            <input v-model.number="historyConfig.maxSessionMb" type="number" min="1" :max="Math.min(512, historyConfig.maxStorageMb || 50)" class="w-full rounded border border-border bg-input px-2 py-1" />
          </label>
        </div>
        <label class="mt-2 flex items-center gap-1.5 text-text-secondary">
          <input v-model="historyConfig.writeMarkdown" type="checkbox" class="accent-primary" />
          {{ t('aiAssistant.ui.writeMarkdown') }}
        </label>
        <button class="mt-2 rounded border border-primary/50 px-3 py-1.5 text-primary hover:bg-primary/10" @click="saveHistoryConfig">{{ t('aiAssistant.ui.saveHistorySettings') }}</button>
        <div v-if="historyConfigMessage" class="mt-1 text-success">{{ historyConfigMessage }}</div>
      </div>
      <div class="flex flex-wrap gap-2">
        <button class="rounded border border-border px-3 py-1.5 hover:bg-hover disabled:opacity-50" :disabled="configBusy" @click="testConfig">{{ t('aiAssistant.ui.testConnection') }}</button>
        <button class="rounded border border-primary/50 px-3 py-1.5 text-primary hover:bg-primary/10 disabled:opacity-50" :disabled="configBusy" @click="testStreaming">{{ t('aiAssistant.ui.testStreaming') }}</button>
        <button class="rounded border border-primary/50 px-3 py-1.5 text-primary hover:bg-primary/10 disabled:opacity-50" :disabled="configBusy" @click="testToolCalling">{{ t('aiAssistant.ui.testTools') }}</button>
      </div>
      <div v-if="configMessage" class="text-success">{{ configMessage }}</div>
      <div v-if="configError" class="ai-config-error whitespace-pre-wrap break-words rounded border border-error/35 bg-error/8 p-2 text-error" role="alert">{{ configError }}</div>
      </div>
      <div class="ai-drawer-foot">
        <button type="button" class="ai-btn ai-btn-ghost" @click="closeSettingsDrawer">{{ t('aiAssistant.common.cancel') }}</button>
        <button type="button" class="ai-btn ai-btn-primary" @click="saveConfig">{{ t('aiAssistant.ui.saveSettings') }}</button>
      </div>
    </aside>

    <div v-if="pendingPromptProposal" class="border-b border-primary/30 bg-primary/10 p-3 text-xs">
      <div class="font-medium text-foreground">{{ t('aiAssistant.ui.proposalTitle') }}</div>
      <div class="mt-1 text-text-secondary">{{ pendingPromptProposal.reason }}</div>
      <pre class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-border/60 bg-background/70 p-2 text-[11px] text-foreground">{{ pendingPromptProposal.prompt }}</pre>
      <div class="mt-2 flex gap-2">
        <button type="button" class="rounded bg-primary px-3 py-1.5 text-white" @click="acceptPromptProposal">{{ t('aiAssistant.ui.acceptSave') }}</button>
        <button type="button" class="rounded border border-border px-3 py-1.5 hover:bg-hover" @click="rejectPromptProposal">{{ t('aiAssistant.ui.reject') }}</button>
      </div>
    </div>

    <div class="border-b border-border px-3 py-1.5 text-xs">
      <div v-if="storageWarning" class="mb-1 rounded border border-warning/40 bg-warning/10 px-2 py-1 text-warning">{{ storageWarning }}</div>
      <div v-if="historySyncWarning" class="mb-1 rounded border border-warning/40 bg-warning/10 px-2 py-1 text-warning">{{ historySyncWarning }}</div>
      <button type="button" class="flex w-full items-center justify-between gap-2 rounded px-1 py-0.5 text-left text-text-secondary hover:bg-hover" :aria-expanded="contextExpanded" @click="contextExpanded = !contextExpanded">
        <span class="flex min-w-0 items-center gap-2">
          <span class="truncate">{{ t('aiAssistant.ui.contextUsage', { percent: contextUsagePercent, used: formatBytes(contextRequestBytes), max: maxRequestKb }) }}</span>
          <span class="ai-context-meter" :title="t('aiAssistant.ui.contextUsageTitle')"><span :style="{ width: `${contextUsagePercent}%` }" /></span>
        </span>
        <span class="flex min-w-0 items-center gap-2">
          <span v-if="timelineItems.length > 0" class="hidden truncate text-[11px] text-text-secondary/80 sm:inline">{{ t('aiAssistant.ui.latest', { title: timelineItems[0].title }) }}</span>
          <i class="fas text-[10px]" :class="contextExpanded ? 'fa-chevron-up' : 'fa-chevron-down'" aria-hidden="true" />
        </span>
      </button>
      <div v-if="contextExpanded" class="mt-1 grid gap-2 rounded border border-border/60 bg-header/20 p-2 sm:grid-cols-3">
        <label :title="t('aiAssistant.ui.compactThresholdTitle')">
          <span class="mb-1 flex justify-between gap-2"><span>{{ t('aiAssistant.ui.compactThreshold') }}</span><strong class="text-foreground">{{ compactTriggerPercent }}%</strong></span>
          <input v-model.number="config.compactTriggerPercent" type="range" min="1" max="80" class="w-full accent-primary" :aria-label="t('aiAssistant.ui.compactThreshold')" />
        </label>
        <label :title="t('aiAssistant.ui.requestLimitTitle')">
          <span class="mb-1 flex justify-between gap-2"><span>{{ t('aiAssistant.ui.requestLimit') }}</span><strong class="text-foreground">{{ maxRequestKb }}KB</strong></span>
          <input v-model.number="config.maxRequestKb" type="range" min="64" max="1024" step="16" class="w-full accent-primary" :aria-label="t('aiAssistant.ui.requestLimitAria')" />
        </label>
        <label :title="t('aiAssistant.ui.compactsPerTaskTitle')">
          <span class="mb-1 flex justify-between gap-2"><span>{{ t('aiAssistant.ui.compactsPerTask') }}</span><strong class="text-foreground">{{ t('aiAssistant.ui.times', { count: maxAutoCompactsPerTask }) }}</strong></span>
          <input v-model.number="config.maxAutoCompactsPerTask" type="range" min="1" max="5" step="1" class="w-full accent-primary" :aria-label="t('aiAssistant.ui.compactsPerTaskAria')" />
        </label>
        <div class="flex items-center justify-between gap-2 sm:col-span-3">
          <span v-if="compression" class="truncate text-[11px] text-text-secondary">{{ t('aiAssistant.ui.lastCompaction', { before: formatBytes(compression.beforeBytes), after: formatBytes(compression.afterBytes), count: compression.compactedCount }) }}</span>
          <span v-else class="text-[11px] text-text-secondary">{{ t('aiAssistant.ui.notCompacted') }}</span>
          <button class="flex-shrink-0 rounded border border-border px-2 py-1 text-foreground hover:bg-hover" @click.stop="compactContext">{{ t('aiAssistant.ui.compactNow') }}</button>
        </div>
      </div>
      <details v-if="latestToolRuns.length > 0" class="ai-tool-details group mt-1 rounded border border-border/50 bg-header/20 px-2 py-1">
        <summary class="flex cursor-pointer list-none items-center justify-between gap-2 text-[11px]">
          <span class="min-w-0 truncate text-text-secondary">{{ t('aiAssistant.ui.toolCallsAll', { count: latestToolRuns.length }) }}</span>
          <span class="flex-shrink-0 text-text-secondary">{{ t('aiAssistant.ui.showDetails') }}</span>
        </summary>
        <div class="mt-1 max-h-64 space-y-1 overflow-y-auto border-t border-border/50 pt-1">
          <details v-for="run in renderedToolRuns" :key="run.id" class="rounded border border-border/40 bg-background/60 px-2 py-1.5 text-[11px]">
            <summary class="flex cursor-pointer list-none items-center justify-between gap-2">
              <span class="min-w-0 truncate font-medium text-foreground">{{ formatToolName(run.name) }} · {{ formatToolStatus(run.status) }}</span>
              <span class="flex-shrink-0 text-text-secondary">{{ formatToolDuration(run) }}</span>
            </summary>
            <div class="mt-0.5 truncate font-mono text-text-secondary">{{ formatToolSummary(run) }}</div>
            <div class="mt-2 border-t border-border/40 pt-2">
              <div class="mb-1 flex items-center justify-between gap-2 text-text-secondary"><span>{{ t('aiAssistant.ui.arguments') }}</span><button v-if="getToolCommand(run)" class="rounded border border-border px-1.5 py-0.5 hover:bg-hover" @click="copyText(getToolCommand(run), `tool-${run.id}`)">{{ copiedKey === `tool-${run.id}` ? t('aiAssistant.ui.copied') : t('aiAssistant.ui.copyCommand') }}</button></div>
              <pre class="max-h-28 overflow-auto whitespace-pre-wrap break-words rounded bg-header/40 p-1.5 font-mono text-[10px] text-foreground">{{ formatToolArguments(run) }}</pre>
              <div class="mb-1 mt-2 text-text-secondary">{{ t('aiAssistant.ui.resultTruncated') }}</div>
              <pre class="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-header/40 p-1.5 font-mono text-[10px] text-foreground">{{ formatToolResult(run) }}</pre>
              <div v-if="run.error" class="mt-1 break-words text-error">{{ t('aiAssistant.ui.failedWith', { error: run.error }) }}</div>
            </div>
          </details>
          <button v-if="hasMoreToolRuns" type="button" class="w-full rounded border border-border/60 px-2 py-1.5 text-center text-[11px] text-text-secondary hover:bg-hover hover:text-foreground" @click="loadMoreToolRuns">
            {{ t('aiAssistant.ui.loadMore', { shown: renderedToolRuns.length, total: latestToolRuns.length }) }}
          </button>
        </div>
      </details>
    </div>

    <div class="relative flex-1 min-h-0 overflow-hidden">
      <div ref="conversationScroller" class="ai-conversation h-full space-y-4 overflow-y-auto p-3 text-sm" @scroll="handleConversationScroll">
      <div
        v-for="(message, index) in conversationMessages"
        :key="index"
        class="flex"
        :class="message.role === 'user' ? 'justify-end' : message.role === 'assistant' ? 'justify-start' : 'justify-center'"
      >
        <div
          class="ai-message-shell"
          :class="messageShellClass(message.role)"
        >
          <div class="mb-1 flex items-center gap-1.5 text-xs font-medium" :class="messageLabelClass(message.role)">
            <img
              v-if="message.role === 'assistant'"
              :src="nexusAiAvatar"
              alt="Nexus AI"
              class="h-6 w-6 flex-shrink-0 rounded-full border border-primary/40 object-cover"
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
            <span
              v-if="message.stopped"
              class="rounded border border-warning/50 bg-warning/10 px-1.5 py-0.5 text-[10px] font-normal text-warning"
              :title="t('uxAi.stoppedTagTitle')"
            >{{ t('uxAi.stoppedTag') }}</span>
            <button
              v-if="message.role === 'assistant' && message.content?.trim()"
              type="button"
              class="ml-auto flex h-6 items-center gap-1 rounded border border-border/60 px-1.5 text-[11px] text-text-secondary transition hover:bg-hover hover:text-foreground"
              :title="t('aiAssistant.ui.copyReply')"
              :aria-label="t('aiAssistant.ui.copyReply')"
              @click.stop="copyText(message.content || '', `msg-${index}`)"
            >
              <i class="fas text-[11px]" :class="copiedKey === `msg-${index}` ? 'fa-check' : 'fa-copy'" aria-hidden="true" />
              <span>{{ copiedKey === `msg-${index}` ? t('aiAssistant.ui.copied') : t('aiAssistant.ui.copy') }}</span>
            </button>
          </div>
          <div
            class="ai-message-content break-words text-sm leading-relaxed"
            v-html="getMessageRenderCache(message).html"
          />
          <div v-if="message.role === 'assistant' && getMessageRenderCache(message).commandBlocks.length > 0" class="mt-3 space-y-2">
            <div
              v-for="command in getMessageRenderCache(message).commandBlocks"
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
                  <button class="rounded border border-border px-2 py-1 text-[11px] hover:bg-hover" @click="copyText(command, `cmd-${message.role}-${index}-${command}`)">{{ copiedKey === `cmd-${message.role}-${index}-${command}` ? t('aiAssistant.ui.copied') : t('aiAssistant.ui.copy') }}</button>
                  <button class="rounded border border-border px-2 py-1 text-[11px] hover:bg-hover" @click="fillCommandInput(command)">{{ t('aiAssistant.ui.typeIntoTerminal') }}</button>
                </div>
              </div>
              <pre class="overflow-auto whitespace-pre-wrap break-words rounded bg-black/20 p-2 font-mono text-xs leading-relaxed">{{ command }}</pre>
            </div>
          </div>
        </div>
      </div>

      <div v-if="isRunning && activeActivities.length > 0" class="ai-activity mr-auto max-w-[88%] rounded border border-border/60 bg-header/25 px-3 py-2 text-xs text-text-secondary">
        <div class="mb-1 flex items-center gap-1.5 font-medium text-foreground">
          <img :src="nexusAiAvatar" alt="Nexus AI" class="h-5 w-5 rounded-full border border-primary/40 object-cover" />
          <span>{{ t('aiAssistant.ui.activity') }}</span>
        </div>
        <div class="space-y-1.5">
          <div
            v-for="activity in activeActivities"
            :key="activity.id"
            class="ai-activity-item flex items-start gap-2 transition-colors duration-300"
            :class="activityTextClass(activity)"
          >
            <span
              class="mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full transition-colors duration-300"
              :class="activityDotClass(activity)"
            />
            <div class="min-w-0">
              <div class="font-medium transition-colors duration-300">{{ activity.title }}</div>
              <div v-if="activity.detail" class="mt-0.5 truncate text-[11px] text-text-secondary">{{ activity.detail }}</div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="errorMessage" class="ai-error rounded border border-error/35 bg-error/8 p-2.5 text-error">
        <div class="flex items-center justify-between gap-2">
          <span class="min-w-0 truncate text-sm font-semibold">{{ t('aiAssistant.ui.errorHeading', { title: continuationAvailable ? t('aiAssistant.ui.outputTruncated') : t('aiAssistant.ui.runError'), message: errorMessage }) }}</span>
          <span class="flex-shrink-0 text-[11px] text-error/70">{{ t('aiAssistant.ui.needsAttention') }}</span>
        </div>
        <details class="mt-1 text-[11px]">
          <summary class="cursor-pointer text-error/80">{{ t('aiAssistant.ui.whyAndWhat') }}</summary>
          <div class="mt-1 rounded border border-error/20 bg-background/50 px-2 py-1.5 text-text-secondary">
            {{ continuationAvailable ? t('aiAssistant.ui.truncatedHint') : t('aiAssistant.ui.errorHint') }}
          </div>
        </details>
        <div class="mt-2 flex flex-wrap gap-2 text-xs">
          <button v-if="continuationAvailable" class="rounded border border-primary/50 px-2 py-1 text-primary hover:bg-primary/10" @click="continueLastResponse">{{ t('aiAssistant.ui.continue') }}</button>
          <button class="rounded border border-error/40 px-2 py-1 hover:bg-error/10" @click="rereadTerminal">{{ t('aiAssistant.ui.reread') }}</button>
          <button class="rounded border border-error/40 px-2 py-1 hover:bg-error/10 disabled:opacity-50" :disabled="!lastUserPrompt" @click="retryLastPrompt">{{ t('aiAssistant.ui.retry') }}</button>
          <button class="rounded border border-error/40 px-2 py-1 hover:bg-error/10 disabled:opacity-50" :disabled="!lastUserPrompt" @click="compactAndRetry">{{ t('aiAssistant.ui.compactRetry') }}</button>
          <button class="rounded border border-error/40 px-2 py-1 hover:bg-error/10" @click="switchReadOnly">{{ t('aiAssistant.ui.switchReadOnly') }}</button>
        </div>
      </div>
      </div>

      <div
        v-if="isDrawerOpen"
        class="ai-drawer-scrim"
        @click="closeDrawer"
      />
      <aside
        v-if="isDrawerOpen"
        class="ai-drawer ai-drawer-context"
        :aria-label="t('aiAssistant.ui.contextMemory')"
      >
        <div class="ai-drawer-head">
          <div class="ai-drawer-title">{{ t('aiAssistant.ui.contextMemory') }}</div>
          <button type="button" class="ai-drawer-close" :title="t('aiAssistant.common.close')" :aria-label="t('aiAssistant.ui.closeContext')" @click="closeDrawer">
            <i class="fas fa-xmark" aria-hidden="true" />
          </button>
        </div>

        <div v-if="drawerPanel === 'context'" class="ai-drawer-body text-xs">
          <div class="mb-3 flex flex-wrap gap-2">
            <button class="rounded border border-border px-3 py-1.5 hover:bg-hover" @click="exportJson">{{ t('aiAssistant.ui.exportJson') }}</button>
            <button class="rounded border border-border px-3 py-1.5 hover:bg-hover" @click="exportMarkdown">{{ t('aiAssistant.ui.exportMarkdown') }}</button>
            <button class="rounded border border-border px-3 py-1.5 hover:bg-hover" @click="openImportDialog">{{ t('aiAssistant.ui.importJson') }}</button>
            <button class="rounded border border-border px-3 py-1.5 hover:bg-hover" @click="openCurrentHistoryDirectory">{{ t('aiAssistant.ui.openHistoryDir') }}</button>
          </div>
          <div v-if="hasMemorySummary" class="ai-memory-card">
            <div class="ai-memory-title">{{ t('aiAssistant.ui.memorySummary') }}</div>
            <pre class="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words font-sans leading-relaxed">{{ memorySummary }}</pre>
          </div>
          <div v-else class="rounded border border-dashed border-border p-3 text-text-secondary">
            {{ t('aiAssistant.ui.noMemorySummary') }}
          </div>
          <div v-if="compression" class="ai-memory-card">
            <div class="ai-memory-title">{{ t('aiAssistant.ui.latestCompaction') }}</div>
            <p class="text-text-secondary">{{ t('aiAssistant.ui.latestCompactionDetail', { before: formatBytes(compression.beforeBytes), after: formatBytes(compression.afterBytes), compacted: compression.compactedCount, retained: compression.retainedCount, source: compression.summaryMode === 'ai' ? 'AI' : t('aiAssistant.compact.sourceLocal') }) }}</p>
          </div>
        </div>
      </aside>
    </div>

    <div class="ai-composer border-t border-border/70 bg-header/15 p-2.5">
      <div class="mb-1.5 flex items-stretch gap-2">
        <textarea
          ref="textareaInput"
          v-model="userInput"
          class="h-16 min-w-0 flex-1 resize-none rounded border border-border bg-input px-2.5 py-2 text-sm text-foreground outline-none transition placeholder:text-text-secondary/70 focus:border-primary focus:ring-2 focus:ring-primary/25"
          :placeholder="isRunning ? t('aiAssistant.ui.guidancePlaceholder') : t('aiAssistant.ui.inputPlaceholder')"
          @keydown="handleInputKeydown"
        />
        <button
          v-if="!isRunning"
          class="w-20 flex-shrink-0 rounded bg-primary px-3 text-sm font-medium text-white disabled:opacity-60"
          :disabled="!canSend"
          @click="sendMessage"
        >
          {{ t('aiAssistant.ui.send') }}
        </button>
        <div v-else class="flex w-20 flex-shrink-0 flex-col gap-1.5">
          <button class="min-h-0 flex-1 rounded bg-primary px-2 text-xs font-medium text-white disabled:opacity-50" :disabled="!canQueueGuidance" @click="sendMessage">{{ t('aiAssistant.ui.addGuidance') }}</button>
          <button class="min-h-0 flex-1 rounded bg-error px-2 text-xs font-medium text-white" @click="stopAi">{{ t('aiAssistant.ui.stopAi') }}</button>
        </div>
      </div>
      <div v-if="visibleMessages.length === 0 && !isRunning" class="mb-2 flex max-h-16 flex-wrap gap-1.5 overflow-y-auto" :aria-label="t('aiAssistant.ui.examples')">
        <button
          v-for="task in quickTasks"
          :key="task.label"
          type="button"
          class="rounded border border-border/60 bg-background/25 px-2.5 py-1 text-[11px] text-text-secondary transition hover:border-primary/50 hover:bg-hover hover:text-foreground"
          @click="useQuickTask(task.prompt)"
        >
          {{ task.label }}
        </button>
      </div>
      <div class="flex items-center justify-end gap-2 text-xs">
        <div class="flex flex-shrink-0 items-center gap-2">
          <label class="flex items-center gap-1.5 text-text-secondary" :title="t('aiAssistant.ui.backgroundToolsTitle')">
            <input v-model="config.enableBackgroundTools" type="checkbox" class="accent-primary" :disabled="isRunning" />
            <span>{{ t('aiAssistant.ui.backgroundTools') }}</span>
          </label>
          <div ref="modeMenuRef" class="relative">
          <button
            type="button"
            class="flex items-center gap-1.5 rounded border border-border bg-input px-2 py-1 text-foreground transition-colors hover:bg-hover"
            :aria-expanded="modeMenuOpen"
            aria-haspopup="menu"
            @click="modeMenuOpen = !modeMenuOpen"
            @keydown.down.prevent="modeMenuOpen = true; focusFirstPopupItem(modeMenuRef)"
          >
            <span class="text-text-secondary">{{ t('aiAssistant.ui.mode') }}</span>
            <span class="font-medium">{{ activeModeOption.label }}</span>
            <i class="fas text-[10px] text-text-secondary" :class="modeMenuOpen ? 'fa-chevron-down' : 'fa-chevron-up'" aria-hidden="true" />
          </button>
          <div
            v-if="modeMenuOpen"
            role="menu"
            class="absolute bottom-full right-0 z-30 mb-1 w-44 overflow-hidden rounded border border-border bg-background py-1 shadow-xl"
            @keydown="handlePopupMenuKeydown"
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
          <button
            class="flex h-7 w-7 items-center justify-center rounded border border-error/40 text-error hover:bg-error/10 disabled:opacity-40"
            :disabled="!hasActiveTerminal"
            :title="t('aiAssistant.ui.sendCtrlC')"
            :aria-label="t('aiAssistant.ui.sendCtrlC')"
            @click="interruptTerminal"
          >
            <i class="fas fa-stop text-[10px]" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div class="mt-1 text-[11px] text-text-secondary">{{ isRunning ? t('aiAssistant.ui.hintRunning') : t('aiAssistant.ui.hintIdle') }}</div>
    </div>
  </div>
</template>

<style scoped>
.ai-terminal-assistant {
  container-type: inline-size;
}

.ai-context-meter {
  display: inline-block;
  width: 68px;
  height: 3px;
  flex-shrink: 0;
  overflow: hidden;
  border-radius: 2px;
  background: color-mix(in srgb, var(--color-border, #334155) 70%, transparent);
}

.ai-context-meter > span {
  display: block;
  height: 100%;
  background: var(--color-primary, #e83e67);
}

.ai-drawer-scrim {
  position: absolute;
  inset: 0;
  z-index: 30;
  background: rgba(0, 0, 0, 0.42);
}

.ai-drawer {
  position: absolute;
  top: 0;
  right: 0;
  z-index: 31;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  width: min(420px, 94%);
  height: 100%;
  border-left: 1px solid var(--color-border, #334155);
  background: var(--color-background, #0b0e12);
  box-shadow: -16px 0 40px rgba(0, 0, 0, 0.32);
}

.ai-drawer-context {
  grid-template-rows: auto minmax(0, 1fr);
}

.ai-drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--color-border, #334155);
}

.ai-drawer-title {
  font-size: 14px;
  font-weight: 600;
}

.ai-drawer-close {
  display: inline-grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-secondary, #94a3b8);
  cursor: pointer;
}

.ai-drawer-close:hover {
  border-color: var(--color-border, #334155);
  color: var(--color-foreground, #e8ebef);
}

.ai-drawer-body {
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
}

.ai-drawer-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--color-border, #334155);
}

.ai-btn {
  padding: 7px 13px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
}

.ai-btn-ghost {
  border: 1px solid var(--color-border, #334155);
  background: transparent;
}

.ai-btn-primary {
  border: 1px solid var(--color-primary, #e83e67);
  background: var(--color-primary, #e83e67);
  color: #fff;
}

.ai-memory-card {
  margin-top: 10px;
  padding: 11px;
  border: 1px solid var(--color-border, #334155);
  border-radius: 6px;
}

.ai-memory-title {
  margin-bottom: 7px;
  color: var(--color-text-secondary, #94a3b8);
  font-weight: 500;
}

.ai-conversation {
  scrollbar-gutter: stable;
}

.ai-message-shell {
  transition: border-color 160ms ease, background-color 160ms ease;
}

.ai-message-shell :deep(p:first-child) {
  margin-top: 0;
}

.ai-message-shell :deep(p:last-child) {
  margin-bottom: 0;
}

.ai-message-shell :deep(pre) {
  border: 1px solid color-mix(in srgb, var(--color-border, #334155) 55%, transparent);
}

.ai-activity {
  opacity: 0.92;
}

.ai-activity-item {
  min-height: 1.25rem;
}

.ai-composer textarea {
  min-height: 4rem;
}

@media (prefers-reduced-motion: reduce) {
  .ai-message-shell {
    transition: none;
  }
}

@container (max-width: 420px) {
  .ai-assistant-header {
    align-items: flex-start;
  }

  .ai-header-main {
    flex-wrap: wrap;
    column-gap: 0.5rem;
    row-gap: 0.2rem;
  }

  .ai-header-title {
    flex-basis: 100%;
  }

  .ai-header-divider {
    display: none;
  }

  .ai-header-session {
    max-width: 58%;
  }

  .ai-header-status {
    flex: 1 1 auto;
    justify-content: flex-end;
  }
}
</style>
