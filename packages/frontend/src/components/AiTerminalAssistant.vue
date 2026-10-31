<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { useAiStore, type AiTaskStatus, type AiToolRun } from '../stores/ai.store';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import nexusAiAvatar from '../assets/nexus-ai-avatar.jpg';
import { MAX_IMPORT_FILE_BYTES } from '../stores/ai/ai.constants';
import { describeAiError } from '../stores/ai/ai.errors';
import { computeLineDiff } from '../stores/ai/ai.tools';
import type { AiChatMessage, AiMessageStep, AiTokenUsage, FileWritePreview } from '../stores/ai/ai.types';
import { collectTurnSteps } from '../stores/ai/ai.steps';
import { escapeHtml, getTerminalInsertText, renderAiMarkdown } from '../utils/aiMarkdown';
import { useKeyboardInset } from '../composables/useKeyboardInset';

const props = withDefaults(defineProps<{ mobileOverlay?: boolean }>(), {
  mobileOverlay: false,
});
const emit = defineEmits<{ (event: 'close-mobile-overlay'): void }>();

const aiStore = useAiStore();
const { t, locale } = useI18n();
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
  profiles,
  activeProfileId,
  activeProfile,
  isSwitchingProfile,
  usageTotals,
  focusInputRequest,
  messages: allMessages,
} = storeToRefs(aiStore);

const modeMenuOpen = ref(false);
const modeMenuRef = ref<HTMLElement | null>(null);
const modelMenuOpen = ref(false);
const modelMenuRef = ref<HTMLElement | null>(null);
const moreMenuOpen = ref(false);
const moreMenuRef = ref<HTMLElement | null>(null);
const profileMenuOpen = ref(false);
const profileMenuRef = ref<HTMLElement | null>(null);
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
  message.role !== 'assistant' || !!message.content?.trim() || !message.tool_calls?.length || hasReasoning(message)
)));
const hasReasoning = (message: AiChatMessage) => typeof message.reasoning === 'string' && !!message.reasoning.trim();
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
    conversationMessages.value.at(-1)?.reasoning?.length || 0,
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
  if (!profileMenuRef.value?.contains(event.target as Node)) profileMenuOpen.value = false;
};

const closePopupMenus = () => {
  modeMenuOpen.value = false;
  modelMenuOpen.value = false;
  moreMenuOpen.value = false;
  profileMenuOpen.value = false;
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
  optionsSheetOpen.value = false;
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

// Pane resize (divider drag, rotation): re-measure the composer and keep the
// conversation pinned to the bottom when it was following. Message content itself
// reflows through CSS (fluid widths, min-width: 0, wrapping).
const rootRef = ref<HTMLElement | null>(null);
let resizeObserver: ResizeObserver | null = null;
let lastObservedWidth = 0;
onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointerDown);
  document.addEventListener('keydown', handleDocumentKeydown);
  void scrollConversationToBottom();
  void nextTick(autoGrowInput);
  if (typeof ResizeObserver !== 'undefined' && rootRef.value) {
    resizeObserver = new ResizeObserver((entries) => {
      const width = Math.round(entries[0]?.contentRect.width || 0);
      if (width === lastObservedWidth) return;
      lastObservedWidth = width;
      autoGrowInput();
      if (shouldAutoFollow.value) void scrollConversationToBottom();
    });
    resizeObserver.observe(rootRef.value);
  }
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown);
  document.removeEventListener('keydown', handleDocumentKeydown);
  if (scrollFrame !== null) window.cancelAnimationFrame(scrollFrame);
  if (copiedTimer !== null) window.clearTimeout(copiedTimer);
  resizeObserver?.disconnect();
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
  if (name === 'write_remote_file') return t('aiAssistant.tool.write_remote_file');
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
  if (run.name === 'write_remote_file') return String(run.args.path || t('aiAssistant.toolSummary.noPath'));
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

type MessageRenderCache = {
  source: string;
  locale: string;
  html: string;
  codeBlocks: string[];
};
const messageRenderCache = new WeakMap<object, MessageRenderCache>();

const codeRiskBadge = (code: string) => {
  const risk = detectCommandRisk(code);
  if (risk === 'normal') return null;
  return { label: formatRiskLabel(risk), className: risk === 'danger' ? 'is-danger' : 'is-confirm' };
};

// A tool-call-only reply shows "calling tools…" only while one of its calls is still in flight.
const isToolCallPending = (message: AiChatMessage) => {
  if (!message.tool_calls?.length || !isRunning.value) return false;
  if (message.steps?.some(step => step.status === 'running')) return true;
  const messages = allMessages.value;
  const lastAssistant = [...messages].reverse().find(item => item.role === 'assistant');
  if (lastAssistant !== message) return false;
  const answered = new Set(messages.filter(item => item.role === 'tool').map(item => item.tool_call_id));
  return message.tool_calls.some(call => !answered.has(call.id));
};

const getMessageRenderCache = (message: AiChatMessage) => {
  const source = message.content || (isToolCallPending(message) ? t('aiAssistant.callingTools') : '');
  const cached = messageRenderCache.get(message);
  if (cached?.source === source && cached.locale === locale.value) return cached;
  const rendered = message.role === 'assistant'
    ? renderAiMarkdown(source, {
      labels: { copy: t('aiUi.code.copy'), insert: t('aiUi.code.insert'), code: t('aiUi.code.label') },
      codeBadge: codeRiskBadge,
    })
    : { html: `<p>${escapeHtml(source).replace(/\n/g, '<br>')}</p>`, codeBlocks: [] as string[] };
  const next = { source, locale: locale.value, html: source ? rendered.html : '', codeBlocks: rendered.codeBlocks };
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

// Types text into the session's terminal input WITHOUT pressing Enter. Multi-line
// text is only allowed when the shell has bracketed paste on (then it is pasted, not run).
const insertTextIntoTerminal = (raw: string) => {
  const text = raw.replace(/\r\n?/g, '\n').replace(/\n+$/, '').trimStart();
  if (!text.trim()) return false;
  const manager = activeSession.value?.terminalManager;
  const term = manager?.terminalInstance?.value as { paste?: (data: string) => void; modes?: { bracketedPasteMode?: boolean }; focus?: () => void } | null | undefined;
  if (text.includes('\n')) {
    if (term?.paste && term.modes?.bracketedPasteMode) {
      term.paste(text);
      term.focus?.();
      return true;
    }
    errorMessage.value = t('aiAssistant.multilineNotAllowed');
    return false;
  }
  if (manager?.sendData) {
    manager.sendData(text);
    term?.focus?.();
    return true;
  }
  errorMessage.value = t('aiAssistant.noTerminalForInput');
  return false;
};

// --- Per-reply actions (copy / retry from here / insert into terminal) ---
const copyMessage = (message: AiChatMessage, index: number) => copyText(message.content || '', `msg-${index}`);
const insertMessageIntoTerminal = (message: AiChatMessage) => {
  const { text } = getTerminalInsertText(message.content);
  insertTextIntoTerminal(text);
};
const retryMessage = async (message: AiChatMessage) => {
  if (isRunning.value) return;
  const all = allMessages.value;
  const index = all.indexOf(message);
  const laterUserTurns = all.slice(index + 1).filter(item => item.role === 'user').length;
  if (laterUserTurns > 0) {
    const confirmed = await showConfirmDialog({
      title: t('aiUi.actions.retryTitle'),
      message: t('aiUi.actions.retryMessage', { count: laterUserTurns }),
      confirmText: t('aiUi.actions.retry'),
      cancelText: t('aiAssistant.common.cancel'),
    });
    if (!confirmed) return;
  }
  shouldAutoFollow.value = true;
  void scrollConversationToBottom();
  await aiStore.retryFromMessage(message, runOptions());
};

// Code-block buttons are plain HTML inside v-html: handle them by delegation.
const handleMessageContentClick = (event: MouseEvent, message: AiChatMessage) => {
  const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('button[data-ai-code-action]');
  if (!button) return;
  event.stopPropagation();
  const index = Number(button.dataset.aiCodeIndex);
  const code = getMessageRenderCache(message).codeBlocks[index];
  if (!code) return;
  if (button.dataset.aiCodeAction === 'insert') {
    insertTextIntoTerminal(code);
    return;
  }
  void navigator.clipboard?.writeText(code).then(() => {
    button.classList.add('is-done');
    button.querySelector('i')?.classList.replace('fa-copy', 'fa-check');
    window.setTimeout(() => {
      button.classList.remove('is-done');
      button.querySelector('i')?.classList.replace('fa-check', 'fa-copy');
    }, 1600);
  }).catch(() => {
    errorMessage.value = t('aiAssistant.copyFailed');
  });
};

// --- 执行步骤 timeline (per reply, collapsed by default) ---
const isVisibleAssistant = (message: AiChatMessage) => !!message.content?.trim() || !message.tool_calls?.length || hasReasoning(message);
const stepsByMessage = computed(() => collectTurnSteps(allMessages.value, isVisibleAssistant));
const stepToggles = new WeakMap<object, boolean>();
const stepToggleVersion = ref(0);
const isStepsOpen = (message: AiChatMessage) => {
  void stepToggleVersion.value;
  return stepToggles.get(message) === true;
};
const toggleSteps = (message: AiChatMessage) => {
  stepToggles.set(message, !isStepsOpen(message));
  stepToggleVersion.value += 1;
};
const stepIconClass = (step: AiMessageStep) => {
  if (step.status === 'ok') return 'fa-circle-check is-ok';
  if (step.status === 'error') return 'fa-circle-xmark is-error';
  if (step.status === 'denied') return 'fa-ban is-denied';
  if (step.status === 'cancelled') return 'fa-circle-stop is-cancelled';
  return 'fa-circle-notch fa-spin is-running';
};
const stepSummaryText = (step: AiMessageStep) => {
  if (step.name === 'get_terminal_output' && /^\d+$/.test(step.summary)) return t('aiAssistant.toolSummary.readLines', { count: Number(step.summary) });
  return step.summary;
};
const stepStatusLabel = (step: AiMessageStep) => t(`aiUi.steps.status.${step.status}`);
const formatStepDuration = (step: AiMessageStep) => {
  if (step.durationMs === undefined) return '';
  return step.durationMs < 1000 ? `${step.durationMs}ms` : `${(step.durationMs / 1000).toFixed(1)}s`;
};
const stepProblemCount = (steps: AiMessageStep[]) => steps.filter(step => step.status === 'error' || step.status === 'denied').length;
const findRunForStep = (step: AiMessageStep) => {
  const candidates = latestToolRuns.value.filter(run => run.id === step.id);
  if (candidates.length <= 1) return candidates[0];
  return candidates.reduce((best, run) => (Math.abs(run.startedAt - step.startedAt) < Math.abs(best.startedAt - step.startedAt) ? run : best));
};
const highlightedRunKey = ref('');
const runKey = (run: AiToolRun) => `${run.id}-${run.startedAt}`;
const openToolRunDetails = (step: AiMessageStep) => {
  const run = findRunForStep(step);
  if (!run) return;
  const position = latestToolRuns.value.indexOf(run);
  if (position >= toolRenderLimit.value) toolRenderLimit.value = position + 1;
  highlightedRunKey.value = runKey(run);
  showConfig.value = false;
  drawerPanel.value = 'context';
  void nextTick(() => {
    const element = document.getElementById(`ai-tool-run-${runKey(run)}`) as HTMLDetailsElement | null;
    if (element) {
      element.open = true;
      element.scrollIntoView({ block: 'center' });
    }
  });
};

// --- Provider-reported model, shown when it differs from the configured one ---
const configuredModel = computed(() => (config.value.model || activeProfile.value?.model || '').trim());
const reportedModel = (message: AiChatMessage) => {
  const model = (message.model || '').trim();
  if (!model || !configuredModel.value) return '';
  return model.toLowerCase() === configuredModel.value.toLowerCase() ? '' : model;
};

// --- Header badges / footer usage ---
const isAutoMode = computed(() => runMode.value === 'auto');
const isAwaitingConfirmation = computed(() => isRunning.value && taskStatus.value === 'awaitingConfirmation');
const runningToolRuns = computed(() => (isRunning.value ? latestToolRuns.value.filter(run => run.status === 'running') : []));
const contextHigh = computed(() => contextUsagePercent.value >= 70);
const showUsageAlert = computed(() => contextHigh.value || runningToolRuns.value.length > 0);
const headerStatusTitle = computed(() => `${t('aiAssistant.ui.title')} · ${sessionLabel.value} · ${formatTaskStatus(taskStatus.value)}`);

// --- Composer: auto-grow textarea (up to ~8 lines, then scroll) ---
const COMPOSER_MAX_LINES = 8;
const autoGrowInput = () => {
  const textarea = textareaInput.value;
  if (!textarea) return;
  const style = window.getComputedStyle(textarea);
  const lineHeight = Number.parseFloat(style.lineHeight) || 21;
  const padding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
  const border = (Number.parseFloat(style.borderTopWidth) || 0) + (Number.parseFloat(style.borderBottomWidth) || 0);
  const maxHeight = Math.round(lineHeight * COMPOSER_MAX_LINES + padding + border);
  if (!textarea.value) {
    // Empty: back to the one-line minimum (the placeholder is ellipsized, never grows the box).
    textarea.style.height = '';
    textarea.style.overflowY = 'hidden';
    return;
  }
  textarea.style.height = 'auto';
  const needed = textarea.scrollHeight + border;
  const next = Math.min(needed, maxHeight);
  textarea.style.height = `${next}px`;
  textarea.style.overflowY = needed > maxHeight ? 'auto' : 'hidden';
};
watch(userInput, () => { void nextTick(autoGrowInput); });
watch(activeSessionId, () => { void nextTick(autoGrowInput); });

// --- Options bottom sheet (narrow panes / mobile): mode, background tools, Ctrl+C ---
const optionsSheetOpen = ref(false);
const optionsSheetRef = ref<HTMLElement | null>(null);
const openOptionsSheet = () => {
  closePopupMenus();
  optionsSheetOpen.value = true;
  void nextTick(() => optionsSheetRef.value?.querySelector<HTMLButtonElement>('[aria-checked="true"], button')?.focus());
};
const closeOptionsSheet = () => {
  optionsSheetOpen.value = false;
};
const interruptFromSheet = () => {
  optionsSheetOpen.value = false;
  void interruptTerminal();
};
const openContextFromSheet = () => {
  optionsSheetOpen.value = false;
  openDrawer('context');
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
  // Tool confirmations are modal: only the explicit buttons approve or deny.
  dismissible: false,
});

// write_remote_file: always confirmed with a diff (also in auto mode).
const confirmAiFileWrite = (preview: FileWritePreview) => {
  const diff = computeLineDiff(preview.isNewFile ? '' : preview.oldContent, preview.newContent);
  return showConfirmDialog({
    title: preview.isNewFile ? t('aiAssistant.writeFile.titleNew') : t('aiAssistant.writeFile.titleOverwrite'),
    message: [
      t('aiAssistant.confirm.target', { name: preview.connectionName || sessionLabel.value }),
      preview.reason ? t('aiAssistant.confirm.reason', { reason: preview.reason }) : '',
      preview.backupPath ? t('aiAssistant.writeFile.backup', { path: preview.backupPath }) : t('aiAssistant.writeFile.newFile'),
      preview.lineEndingsNormalized ? t('aiAssistant.writeFile.lineEndings') : '',
      t('aiAssistant.writeFile.note'),
    ].filter(Boolean).join('\n'),
    confirmText: t('aiAssistant.writeFile.confirm'),
    cancelText: t('aiAssistant.common.cancel'),
    signal: preview.signal,
    diff: { ...diff, path: preview.path, isNewFile: preview.isNewFile },
    dismissible: false,
  });
};

const runOptions = () => ({ confirmCommand: confirmAiCommand, confirmFileWrite: confirmAiFileWrite });

const sendMessage = () => {
  shouldAutoFollow.value = true;
  void scrollConversationToBottom();
  return aiStore.sendMessage(runOptions());
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
  refocusInput();
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

const continueLastResponse = () => aiStore.continueLastResponse(runOptions());

// --- Model profiles: header quick switch + settings drawer management ---
const profileLabel = computed(() => activeProfile.value?.name || t('aiAssistant.profiles.label'));
const profileModelLabel = computed(() => config.value.model || activeProfile.value?.model || t('aiAssistant.profiles.noModel'));
const switchProfileFromHeader = async (profileId: string) => {
  profileMenuOpen.value = false;
  try {
    await aiStore.switchProfile(profileId);
  } catch (error) {
    errorMessage.value = describeAiError(error, t('aiAssistant.profiles.switchFailed'));
  }
};
const openProfileSettings = () => {
  profileMenuOpen.value = false;
  openSettingsDrawer();
};
const profileEditMode = ref<'create' | 'rename' | null>(null);
const profileNameDraft = ref('');
const profileNameInput = ref<HTMLInputElement | null>(null);
const startProfileEdit = (mode: 'create' | 'rename') => {
  profileEditMode.value = mode;
  profileNameDraft.value = mode === 'rename' ? (activeProfile.value?.name || '') : '';
  void nextTick(() => profileNameInput.value?.focus());
};
const cancelProfileEdit = () => {
  profileEditMode.value = null;
  profileNameDraft.value = '';
};
const submitProfileEdit = () => runConfigAction(async () => {
  const name = profileNameDraft.value.trim();
  if (!name) return;
  if (profileEditMode.value === 'create') await aiStore.createProfile(name);
  else if (profileEditMode.value === 'rename' && activeProfileId.value) await aiStore.renameProfile(activeProfileId.value, name);
  cancelProfileEdit();
}, t('aiAssistant.profiles.saveFailed'));
const selectProfileInDrawer = (event: Event) => {
  const value = (event.target as HTMLSelectElement).value;
  cancelProfileEdit();
  void runConfigAction(() => aiStore.switchProfile(value), t('aiAssistant.profiles.switchFailed'));
};
const deleteActiveProfile = async () => {
  const profile = activeProfile.value;
  if (!profile || profiles.value.length <= 1) return;
  const confirmed = await showConfirmDialog({
    title: t('aiAssistant.profiles.deleteTitle'),
    message: t('aiAssistant.profiles.deleteMessage', { name: profile.name }),
    confirmText: t('aiAssistant.profiles.delete'),
    cancelText: t('aiAssistant.common.cancel'),
  });
  if (!confirmed) return;
  await runConfigAction(() => aiStore.deleteProfile(profile.id), t('aiAssistant.profiles.saveFailed'));
};

// --- Reasoning blocks: live/expanded while streaming, collapsed once finished ---
const reasoningToggles = new WeakMap<object, boolean>();
const reasoningToggleVersion = ref(0);
// Only the reply currently being generated counts as live (not while a tool runs or waits for confirmation).
const isStreamingMessage = (message: AiChatMessage) => isRunning.value && taskStatus.value === 'thinking' && conversationMessages.value.at(-1) === message;
const isReasoningOpen = (message: AiChatMessage) => {
  void reasoningToggleVersion.value;
  const toggled = reasoningToggles.get(message);
  return toggled ?? isStreamingMessage(message);
};
const toggleReasoning = (message: AiChatMessage) => {
  reasoningToggles.set(message, !isReasoningOpen(message));
  reasoningToggleVersion.value += 1;
};
const reasoningLiveRefs = new Set<HTMLElement>();
const setReasoningLiveRef = (element: unknown) => {
  if (element instanceof HTMLElement) reasoningLiveRefs.add(element);
};
watch(() => conversationMessages.value.at(-1)?.reasoning?.length || 0, () => {
  void nextTick(() => {
    reasoningLiveRefs.forEach((element) => {
      if (!element.isConnected) {
        reasoningLiveRefs.delete(element);
        return;
      }
      element.scrollTop = element.scrollHeight;
    });
  });
});

// --- Token usage (UI only): per user turn under the last reply, session total in the footer ---
const formatTokens = (value: number) => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
};
const turnUsageByMessage = computed(() => {
  const result = new Map<AiChatMessage, AiTokenUsage & { requests: number }>();
  let turn: (AiTokenUsage & { requests: number }) | null = null;
  let lastAssistant: AiChatMessage | null = null;
  const flush = () => {
    if (turn && lastAssistant) result.set(lastAssistant, turn);
    turn = null;
    lastAssistant = null;
  };
  for (const message of allMessages.value) {
    if (message.role === 'user') {
      flush();
      continue;
    }
    if (message.role !== 'assistant') continue;
    if (message.content?.trim() || !message.tool_calls?.length || hasReasoning(message)) lastAssistant = message;
    if (message.usage) {
      const current: AiTokenUsage & { requests: number } = turn || { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 };
      current.promptTokens += message.usage.promptTokens || 0;
      current.completionTokens += message.usage.completionTokens || 0;
      current.totalTokens += message.usage.totalTokens || 0;
      current.requests += 1;
      turn = current;
    }
  }
  flush();
  return result;
});

// Terminal selection → "Ask AI": focus the prefilled input (caret at the end).
watch(() => focusInputRequest.value?.nonce, (nonce) => {
  if (!nonce) return;
  showConfig.value = false;
  drawerPanel.value = null;
  void nextTick(() => {
    window.setTimeout(() => {
      const textarea = textareaInput.value;
      if (!textarea || !textarea.isConnected || textarea.offsetParent === null) return;
      autoGrowInput();
      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
      textarea.scrollTop = textarea.scrollHeight;
    }, 60);
  });
});

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
  <div ref="rootRef" class="ai-terminal-assistant relative flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground" :class="{ 'is-mobile-overlay': mobileOverlay }">
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
        <div class="ai-header-title flex-shrink-0 text-sm font-semibold tracking-tight" :title="headerStatusTitle">{{ t('aiAssistant.ui.title') }}</div>
        <span class="ai-header-divider h-3 w-px flex-shrink-0 bg-border" aria-hidden="true" />
        <div class="ai-header-session min-w-0 truncate text-xs text-text-secondary" :title="sessionLabel">{{ sessionLabel }}</div>
        <div class="ai-header-status flex min-w-0 flex-shrink-0 items-center gap-1.5 text-[11px] text-text-secondary" :title="headerStatusTitle" role="status">
          <span class="h-1.5 w-1.5 flex-shrink-0 rounded-full" :class="isAwaitingConfirmation ? 'animate-pulse bg-warning' : isRunning ? 'animate-pulse bg-primary' : taskStatus === 'error' ? 'bg-error' : 'bg-success'" aria-hidden="true" />
          <span class="ai-header-status-text truncate">{{ formatTaskStatus(taskStatus) }}</span>
        </div>
        <span
          v-if="isAwaitingConfirmation"
          class="ai-badge ai-badge-pending"
          role="status"
          :title="t('aiUi.badge.pendingTitle')"
        >
          <i class="fas fa-hand text-[9px]" aria-hidden="true" />
          <span>{{ t('aiUi.badge.pending') }}</span>
        </span>
        <span
          v-if="isAutoMode"
          class="ai-badge ai-badge-auto"
          :title="t('aiUi.badge.autoTitle')"
        >
          <i class="fas fa-bolt text-[9px]" aria-hidden="true" />
          <span>{{ t('aiUi.badge.auto') }}</span>
        </span>
        <div ref="profileMenuRef" class="ai-header-model relative min-w-0">
          <button
            type="button"
            class="ai-profile-trigger flex min-w-0 max-w-full items-center gap-1 rounded border border-transparent px-1.5 py-0.5 text-[11px] text-text-secondary transition hover:border-border hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            :class="mobileOverlay ? 'min-h-[32px]' : ''"
            :disabled="isRunning || isSwitchingProfile"
            :title="`${isRunning ? t('aiAssistant.profiles.switchDisabledRunning') : t('aiAssistant.profiles.headerTitle', { name: profileLabel, model: profileModelLabel })}${activeModelId && activeModelId !== profileModelLabel ? `\n${t('aiUi.model.reportedShort', { model: activeModelId })}` : ''}\n${sessionLabel}`"
            :aria-label="t('aiAssistant.profiles.headerTitle', { name: profileLabel, model: profileModelLabel })"
            :aria-expanded="profileMenuOpen"
            aria-haspopup="menu"
            @click="profileMenuOpen = !profileMenuOpen"
            @keydown.down.prevent="profileMenuOpen = true; focusFirstPopupItem(profileMenuRef)"
          >
            <i class="fas fa-layer-group flex-shrink-0 text-[10px] opacity-70" aria-hidden="true" />
            <span v-if="profiles.length > 1" class="max-w-[7rem] flex-shrink-0 truncate font-medium text-foreground/90">{{ profileLabel }}</span>
            <span v-if="profiles.length > 1" class="flex-shrink-0 opacity-50">·</span>
            <span class="min-w-0 truncate">{{ profileModelLabel }}</span>
            <i class="fas flex-shrink-0 text-[9px] opacity-70" :class="isSwitchingProfile ? 'fa-spinner fa-spin' : profileMenuOpen ? 'fa-chevron-up' : 'fa-chevron-down'" aria-hidden="true" />
          </button>
          <div
            v-if="profileMenuOpen"
            role="menu"
            class="ai-profile-menu absolute left-0 top-full z-40 mt-1 overflow-hidden rounded border border-border bg-background py-1 text-xs shadow-xl"
            style="width: min(16rem, calc(100cqw - 1.25rem))"
            @keydown="handlePopupMenuKeydown"
          >
            <div class="px-3 pb-1 pt-1.5 text-[10px] uppercase tracking-wide text-text-secondary">{{ t('aiAssistant.profiles.switchTitle') }}</div>
            <div class="max-h-64 overflow-y-auto">
              <button
                v-for="profile in profiles"
                :key="profile.id"
                type="button"
                role="menuitemradio"
                :aria-checked="profile.id === activeProfileId"
                class="flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-hover"
                :class="profile.id === activeProfileId ? 'bg-primary/15 text-primary' : 'text-foreground'"
                @click="switchProfileFromHeader(profile.id)"
              >
                <i class="fas mt-0.5 w-3 flex-shrink-0 text-[10px]" :class="profile.id === activeProfileId ? 'fa-check' : ''" aria-hidden="true" />
                <span class="min-w-0 flex-1">
                  <span class="block truncate font-medium">{{ profile.name }}</span>
                  <span class="mt-0.5 block truncate text-[11px] text-text-secondary">{{ profile.model || t('aiAssistant.profiles.noModel') }}</span>
                </span>
                <span v-if="!profile.hasApiKey" class="mt-0.5 flex-shrink-0 rounded border border-warning/50 px-1 text-[10px] text-warning">{{ t('aiAssistant.profiles.keyMissing') }}</span>
              </button>
            </div>
            <div class="my-1 border-t border-border" />
            <button type="button" role="menuitem" class="flex w-full items-center gap-2 px-3 py-2 text-left text-text-secondary hover:bg-hover hover:text-foreground" @click="openProfileSettings">
              <i class="fas fa-sliders w-3 text-[10px]" aria-hidden="true" />
              <span>{{ t('aiAssistant.profiles.manage') }}</span>
            </button>
          </div>
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
          <div v-if="moreMenuOpen" role="menu" class="ai-popup-menu absolute right-0 top-full z-40 mt-1 w-44 overflow-hidden rounded border border-border bg-background py-1 text-xs shadow-xl" @keydown="handlePopupMenuKeydown">
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
      <div class="ai-profile-section rounded border border-border/70 bg-header/20 p-2">
        <div class="mb-1.5 flex items-center justify-between gap-2">
          <span class="min-w-0 truncate font-medium text-foreground">{{ t('aiAssistant.profiles.label') }}<span class="ml-1.5 font-normal text-text-secondary">{{ t('aiAssistant.profiles.count', { count: profiles.length }) }}</span></span>
          <span v-if="!profileEditMode" class="flex flex-shrink-0 gap-1">
            <button type="button" class="ai-icon-btn" :title="t('aiAssistant.profiles.add')" :aria-label="t('aiAssistant.profiles.add')" :disabled="configBusy || isRunning" @click="startProfileEdit('create')">
              <i class="fas fa-plus" aria-hidden="true" />
            </button>
            <button type="button" class="ai-icon-btn" :title="t('aiAssistant.profiles.rename')" :aria-label="t('aiAssistant.profiles.rename')" :disabled="configBusy || !activeProfile" @click="startProfileEdit('rename')">
              <i class="fas fa-pen" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="ai-icon-btn ai-icon-btn-danger"
              :title="profiles.length <= 1 ? t('aiAssistant.profiles.deleteLast') : t('aiAssistant.profiles.delete')"
              :aria-label="t('aiAssistant.profiles.delete')"
              :disabled="configBusy || isRunning || profiles.length <= 1"
              @click="deleteActiveProfile"
            >
              <i class="fas fa-trash-can" aria-hidden="true" />
            </button>
          </span>
        </div>
        <div v-if="profileEditMode" class="flex gap-1.5">
          <input
            ref="profileNameInput"
            v-model="profileNameDraft"
            maxlength="64"
            class="min-w-0 flex-1 rounded border border-primary/40 bg-input px-2 py-1 text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/25"
            :placeholder="t('aiAssistant.profiles.namePlaceholder')"
            :aria-label="profileEditMode === 'create' ? t('aiAssistant.profiles.add') : t('aiAssistant.profiles.rename')"
            @keydown.enter.prevent="submitProfileEdit"
            @keydown.esc.stop.prevent="cancelProfileEdit"
          />
          <button type="button" class="flex-shrink-0 rounded border border-primary/50 px-2 py-1 text-primary hover:bg-primary/10 disabled:opacity-50" :disabled="configBusy || !profileNameDraft.trim()" @click="submitProfileEdit">{{ t('aiAssistant.profiles.ok') }}</button>
          <button type="button" class="flex-shrink-0 rounded border border-border px-2 py-1 hover:bg-hover" @click="cancelProfileEdit">{{ t('aiAssistant.common.cancel') }}</button>
        </div>
        <select
          v-else
          class="w-full rounded border border-border bg-input px-2 py-1 text-foreground"
          :value="activeProfileId"
          :disabled="configBusy || isSwitchingProfile || isRunning"
          :aria-label="t('aiAssistant.profiles.label')"
          @change="selectProfileInDrawer"
        >
          <option v-for="profile in profiles" :key="profile.id" :value="profile.id">{{ profile.name }}{{ profile.model ? ` · ${profile.model}` : '' }}</option>
        </select>
        <p class="mt-1.5 text-[11px] leading-relaxed text-text-secondary">{{ t('aiAssistant.profiles.hint') }}</p>
      </div>
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

    <div v-if="storageWarning || historySyncWarning" class="border-b border-border/70 px-3 py-1.5 text-xs">
      <div v-if="storageWarning" class="rounded border border-warning/40 bg-warning/10 px-2 py-1 text-warning">{{ storageWarning }}</div>
      <div v-if="historySyncWarning" class="rounded border border-warning/40 bg-warning/10 px-2 py-1 text-warning" :class="storageWarning ? 'mt-1' : ''">{{ historySyncWarning }}</div>
    </div>

    <div class="relative flex-1 min-h-0 overflow-hidden">
      <div ref="conversationScroller" class="ai-conversation h-full space-y-4 overflow-y-auto p-3 text-sm" @scroll="handleConversationScroll">
      <div
        v-if="conversationMessages.length === 0 && !isRunning && !errorMessage"
        class="ai-empty-state"
      >
        <div class="ai-empty-card">
          <img :src="nexusAiAvatar" alt="" class="mx-auto h-10 w-10 rounded-full border border-primary/40 object-cover" />
          <div class="mt-2 text-sm font-semibold text-foreground">{{ t('aiUi.empty.title') }}</div>
          <p v-if="!hasActiveTerminal" class="mt-1 text-xs text-warning">{{ t('aiUi.empty.noTerminal') }}</p>
          <ul class="ai-empty-caps">
            <li><i class="fas fa-file-lines" aria-hidden="true" /><span>{{ t('aiUi.empty.capRead') }}</span></li>
            <li><i class="fas fa-terminal" aria-hidden="true" /><span>{{ t('aiUi.empty.capRun') }}</span></li>
            <li :class="{ 'is-off': !config.enableBackgroundTools }"><i class="fas fa-folder-open" aria-hidden="true" /><span>{{ config.enableBackgroundTools ? t('aiUi.empty.capFiles') : t('aiUi.empty.capFilesOff') }}</span></li>
          </ul>
          <div class="ai-empty-meta">
            <span class="ai-empty-chip" :class="{ 'is-auto': isAutoMode }" :title="activeModeOption.description">
              <span class="text-text-secondary">{{ t('aiAssistant.ui.mode') }}</span>
              <strong>{{ activeModeOption.label }}</strong>
            </span>
            <span class="ai-empty-chip" :title="t('aiAssistant.ui.backgroundToolsTitle')">
              <span class="text-text-secondary">{{ t('aiAssistant.ui.backgroundTools') }}</span>
              <strong>{{ config.enableBackgroundTools ? t('aiUi.empty.on') : t('aiUi.empty.off') }}</strong>
            </span>
          </div>
          <p class="mt-1.5 text-[11px] leading-relaxed text-text-secondary">{{ activeModeOption.description }}</p>
          <div class="mt-3 flex flex-wrap justify-center gap-1.5" role="group" :aria-label="t('aiAssistant.ui.examples')">
            <button
              v-for="task in quickTasks"
              :key="task.label"
              type="button"
              class="ai-quick-chip"
              @click="useQuickTask(task.prompt)"
            >
              {{ task.label }}
            </button>
          </div>
        </div>
      </div>
      <div
        v-for="(message, index) in conversationMessages"
        :key="index"
        class="ai-message-row flex min-w-0"
        :class="message.role === 'user' ? 'justify-end' : message.role === 'assistant' ? 'justify-start' : 'justify-center'"
      >
        <div
          class="ai-message-shell group/msg min-w-0"
          :class="[messageShellClass(message.role), message.role === 'assistant' ? 'is-assistant' : '']"
        >
          <div class="ai-message-head mb-1 flex min-w-0 items-center gap-1.5 text-xs font-medium" :class="messageLabelClass(message.role)">
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
            <span class="flex-shrink-0">{{ messageLabel(message.role) }}</span>
            <span
              v-if="message.role === 'assistant' && reportedModel(message)"
              class="ai-msg-model min-w-0 truncate"
              :title="t('aiUi.model.reported', { model: reportedModel(message), configured: configuredModel })"
            >{{ reportedModel(message) }}</span>
            <span
              v-if="message.stopped"
              class="flex-shrink-0 rounded border border-warning/50 bg-warning/10 px-1.5 py-0.5 text-[10px] font-normal text-warning"
              :title="t('uxAi.stoppedTagTitle')"
            >{{ t('uxAi.stoppedTag') }}</span>
            <span
              v-if="message.role === 'assistant' && message.content?.trim()"
              class="ai-msg-actions ml-auto flex flex-shrink-0 items-center gap-0.5"
              role="toolbar"
              :aria-label="t('aiUi.actions.toolbar')"
            >
              <button
                type="button"
                class="ai-msg-action"
                :title="copiedKey === `msg-${index}` ? t('aiAssistant.ui.copied') : t('aiAssistant.ui.copyReply')"
                :aria-label="t('aiAssistant.ui.copyReply')"
                @click.stop="copyMessage(message, index)"
              >
                <i class="fas" :class="copiedKey === `msg-${index}` ? 'fa-check text-success' : 'fa-copy'" aria-hidden="true" />
              </button>
              <button
                type="button"
                class="ai-msg-action"
                :disabled="isRunning"
                :title="isRunning ? t('aiUi.actions.retryDisabled') : t('aiUi.actions.retryHint')"
                :aria-label="t('aiUi.actions.retry')"
                @click.stop="retryMessage(message)"
              >
                <i class="fas fa-rotate-right" aria-hidden="true" />
              </button>
              <button
                type="button"
                class="ai-msg-action"
                :disabled="!hasActiveTerminal"
                :title="getMessageRenderCache(message).codeBlocks.length ? t('aiUi.actions.insertCode') : t('aiUi.actions.insertText')"
                :aria-label="getMessageRenderCache(message).codeBlocks.length ? t('aiUi.actions.insertCode') : t('aiUi.actions.insertText')"
                @click.stop="insertMessageIntoTerminal(message)"
              >
                <i class="fas fa-terminal" aria-hidden="true" />
              </button>
            </span>
          </div>
          <div v-if="message.role === 'assistant' && hasReasoning(message)" class="ai-reasoning mb-2" :class="{ 'is-live': isStreamingMessage(message) }">
            <button
              type="button"
              class="ai-reasoning-toggle"
              :aria-expanded="isReasoningOpen(message)"
              :title="isReasoningOpen(message) ? t('aiAssistant.reasoning.collapse') : t('aiAssistant.reasoning.expand')"
              @click="toggleReasoning(message)"
            >
              <i class="fas text-[10px]" :class="isStreamingMessage(message) && !message.content?.trim() ? 'fa-circle-notch fa-spin text-primary' : 'fa-brain'" aria-hidden="true" />
              <span class="font-medium">{{ isStreamingMessage(message) && !message.content?.trim() ? t('aiAssistant.reasoning.live') : t('aiAssistant.reasoning.title') }}</span>
              <span class="text-text-secondary/70">{{ t('aiAssistant.reasoning.chars', { count: message.reasoning?.length || 0 }) }}</span>
              <i class="fas ml-auto text-[9px]" :class="isReasoningOpen(message) ? 'fa-chevron-up' : 'fa-chevron-down'" aria-hidden="true" />
            </button>
            <div
              v-if="isReasoningOpen(message)"
              :ref="setReasoningLiveRef"
              class="ai-reasoning-body"
            >{{ message.reasoning }}</div>
          </div>
          <div
            v-if="getMessageRenderCache(message).html"
            class="ai-message-content ai-md"
            :class="{ 'is-pending': !message.content && isToolCallPending(message) }"
            @click="handleMessageContentClick($event, message)"
            v-html="getMessageRenderCache(message).html"
          />
          <div v-if="message.role === 'assistant' && stepsByMessage.get(message)" class="ai-steps">
            <button
              type="button"
              class="ai-steps-toggle"
              :aria-expanded="isStepsOpen(message)"
              @click="toggleSteps(message)"
            >
              <i class="fas fa-list-check text-[10px]" aria-hidden="true" />
              <span class="font-medium">{{ t('aiUi.steps.title') }}</span>
              <span class="text-text-secondary/80">{{ t('aiUi.steps.count', { count: stepsByMessage.get(message)!.length }) }}</span>
              <span v-if="stepProblemCount(stepsByMessage.get(message)!)" class="ai-steps-problems">{{ t('aiUi.steps.problems', { count: stepProblemCount(stepsByMessage.get(message)!) }) }}</span>
              <i class="fas ml-auto text-[9px]" :class="isStepsOpen(message) ? 'fa-chevron-up' : 'fa-chevron-down'" aria-hidden="true" />
            </button>
            <ol v-if="isStepsOpen(message)" class="ai-steps-list">
              <li v-for="(step, stepIndex) in stepsByMessage.get(message)" :key="`${step.id}-${stepIndex}`" class="ai-step">
                <i class="fas ai-step-icon" :class="stepIconClass(step)" :title="stepStatusLabel(step)" aria-hidden="true" />
                <div class="min-w-0 flex-1">
                  <div class="flex min-w-0 items-center gap-1.5">
                    <span class="min-w-0 truncate font-medium text-foreground">{{ formatToolName(step.name) }}</span>
                    <span class="ai-step-status" :class="`is-${step.status}`">{{ stepStatusLabel(step) }}</span>
                    <span v-if="formatStepDuration(step)" class="ml-auto flex-shrink-0 tabular-nums text-text-secondary">{{ formatStepDuration(step) }}</span>
                  </div>
                  <div v-if="step.summary" class="ai-step-summary" :title="stepSummaryText(step)">{{ stepSummaryText(step) }}</div>
                </div>
                <button
                  v-if="findRunForStep(step)"
                  type="button"
                  class="ai-msg-action is-visible"
                  :title="t('aiUi.steps.details')"
                  :aria-label="t('aiUi.steps.details')"
                  @click="openToolRunDetails(step)"
                >
                  <i class="fas fa-up-right-from-square text-[10px]" aria-hidden="true" />
                </button>
              </li>
            </ol>
          </div>
          <div
            v-if="message.role === 'assistant' && turnUsageByMessage.get(message)"
            class="ai-turn-usage mt-1.5 flex items-center gap-1 text-[10px] text-text-secondary/70"
            :title="t('aiAssistant.usage.turnTitle', { requests: turnUsageByMessage.get(message)!.requests, prompt: turnUsageByMessage.get(message)!.promptTokens, completion: turnUsageByMessage.get(message)!.completionTokens })"
          >
            <i class="fas fa-coins text-[9px] opacity-70" aria-hidden="true" />
            <span>{{ t('aiAssistant.usage.turn', { prompt: formatTokens(turnUsageByMessage.get(message)!.promptTokens), completion: formatTokens(turnUsageByMessage.get(message)!.completionTokens) }) }}</span>
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
          <section class="ai-ctx-section mb-3" :aria-label="t('aiUi.usage.sectionTitle')">
            <div class="mb-1.5 flex items-center justify-between gap-2">
              <span class="font-medium text-foreground">{{ t('aiUi.usage.sectionTitle') }}</span>
              <span class="flex-shrink-0 tabular-nums" :class="contextHigh ? 'text-warning' : 'text-text-secondary'" :title="t('aiAssistant.ui.contextUsage', { percent: contextUsagePercent, used: formatBytes(contextRequestBytes), max: maxRequestKb })">{{ contextUsagePercent }}% · {{ formatBytes(contextRequestBytes) }} / {{ maxRequestKb }} KB</span>
            </div>
            <span class="ai-context-meter is-wide" :class="{ 'is-high': contextHigh }" :title="t('aiAssistant.ui.contextUsageTitle')"><span :style="{ width: `${contextUsagePercent}%` }" /></span>
            <div class="mt-2 grid gap-2">
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
              <div class="flex items-center justify-between gap-2">
                <span v-if="compression" class="min-w-0 truncate text-[11px] text-text-secondary">{{ t('aiAssistant.ui.lastCompaction', { before: formatBytes(compression.beforeBytes), after: formatBytes(compression.afterBytes), count: compression.compactedCount }) }}</span>
                <span v-else class="text-[11px] text-text-secondary">{{ t('aiAssistant.ui.notCompacted') }}</span>
                <button type="button" class="flex-shrink-0 rounded border border-border px-2 py-1 text-foreground hover:bg-hover" @click.stop="compactContext">{{ t('aiAssistant.ui.compactNow') }}</button>
              </div>
            </div>
          </section>
          <section v-if="latestToolRuns.length > 0" class="ai-ctx-section mb-3">
            <div class="mb-1.5 font-medium text-foreground">{{ t('aiAssistant.ui.toolCallsAll', { count: latestToolRuns.length }) }}</div>
            <div class="space-y-1">
              <details
                v-for="run in renderedToolRuns"
                :id="`ai-tool-run-${runKey(run)}`"
                :key="runKey(run)"
                class="ai-tool-run rounded border border-border/50 px-2 py-1.5 text-[11px]"
                :class="{ 'is-highlighted': highlightedRunKey === runKey(run) }"
              >
                <summary class="flex cursor-pointer list-none items-center justify-between gap-2">
                  <span class="min-w-0 truncate font-medium text-foreground">{{ formatToolName(run.name) }} · {{ formatToolStatus(run.status) }}</span>
                  <span class="flex-shrink-0 text-text-secondary">{{ formatToolDuration(run) }}</span>
                </summary>
                <div class="mt-0.5 truncate font-mono text-text-secondary">{{ formatToolSummary(run) }}</div>
                <div class="mt-2 border-t border-border/40 pt-2">
                  <div class="mb-1 flex items-center justify-between gap-2 text-text-secondary"><span>{{ t('aiAssistant.ui.arguments') }}</span><button v-if="getToolCommand(run)" type="button" class="rounded border border-border px-1.5 py-0.5 hover:bg-hover" @click="copyText(getToolCommand(run), `tool-${runKey(run)}`)">{{ copiedKey === `tool-${runKey(run)}` ? t('aiAssistant.ui.copied') : t('aiAssistant.ui.copyCommand') }}</button></div>
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
          </section>
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
      <div v-if="showUsageAlert" class="ai-usage-alert" :class="contextHigh ? 'is-high' : 'is-tools'" role="status">
        <template v-if="runningToolRuns.length > 0">
          <i class="fas fa-circle-notch fa-spin text-[10px] text-primary" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate">{{ t('aiUi.usage.toolsRunning', { name: formatToolName(runningToolRuns[0].name), count: runningToolRuns.length }) }}</span>
        </template>
        <template v-else>
          <i class="fas fa-triangle-exclamation text-[10px]" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate">{{ t('aiUi.usage.contextHigh', { percent: contextUsagePercent }) }}</span>
        </template>
        <span v-if="contextHigh && runningToolRuns.length > 0" class="ai-usage-alert-pct">{{ contextUsagePercent }}%</span>
        <button type="button" class="ai-usage-alert-btn" @click="openDrawer('context')">{{ contextHigh ? t('aiUi.usage.manage') : t('aiUi.usage.details') }}</button>
      </div>
      <div class="ai-composer-row flex items-end gap-2">
        <textarea
          ref="textareaInput"
          v-model="userInput"
          rows="1"
          class="ai-composer-input min-w-0 flex-1 resize-none rounded border border-border bg-input px-2.5 py-2 text-sm text-foreground outline-none transition placeholder:text-text-secondary/70 focus:border-primary focus:ring-2 focus:ring-primary/25"
          :class="{ 'is-running': isRunning }"
          :placeholder="isRunning ? t('aiAssistant.ui.guidancePlaceholder') : t('aiAssistant.ui.inputPlaceholder')"
          :aria-label="isRunning ? t('aiAssistant.ui.guidancePlaceholder') : t('aiAssistant.ui.inputPlaceholder')"
          @keydown="handleInputKeydown"
          @input="autoGrowInput"
        />
        <button
          v-if="!isRunning"
          type="button"
          class="ai-send-btn flex-shrink-0 rounded bg-primary px-3 text-sm font-medium text-white disabled:opacity-60"
          :disabled="!canSend"
          @click="sendMessage"
        >
          {{ t('aiAssistant.ui.send') }}
        </button>
        <div v-else class="ai-run-actions flex flex-shrink-0 flex-col gap-1.5">
          <button type="button" class="min-h-0 flex-1 rounded bg-primary px-2 text-xs font-medium text-white disabled:opacity-50" :disabled="!canQueueGuidance" @click="sendMessage">{{ t('aiAssistant.ui.addGuidance') }}</button>
          <button type="button" class="ai-stop-btn min-h-0 flex-1 rounded bg-error px-2 text-xs font-medium text-white" @click="stopAi">{{ t('aiAssistant.ui.stopAi') }}</button>
        </div>
      </div>
      <div class="ai-composer-bar mt-1.5 flex min-w-0 items-center gap-2 text-[11px] text-text-secondary">
        <span class="ai-composer-hint min-w-0 truncate">{{ isRunning ? t('aiAssistant.ui.hintRunning') : t('aiAssistant.ui.hintIdle') }}</span>
        <button
          type="button"
          class="ai-ctx-chip"
          :class="{ 'is-high': contextHigh }"
          :title="t('aiAssistant.ui.contextUsage', { percent: contextUsagePercent, used: formatBytes(contextRequestBytes), max: maxRequestKb })"
          :aria-label="t('aiAssistant.ui.contextUsage', { percent: contextUsagePercent, used: formatBytes(contextRequestBytes), max: maxRequestKb })"
          @click="openDrawer('context')"
        >
          <span class="ai-context-meter" :class="{ 'is-high': contextHigh }" aria-hidden="true"><span :style="{ width: `${contextUsagePercent}%` }" /></span>
          <span class="tabular-nums">{{ contextUsagePercent }}%</span>
        </button>
        <span
          v-if="usageTotals && usageTotals.totalTokens > 0"
          class="ai-session-usage flex min-w-0 items-center gap-1 overflow-hidden text-text-secondary/80"
          :title="t('aiAssistant.usage.sessionTitle', { requests: usageTotals.requests, prompt: usageTotals.promptTokens, completion: usageTotals.completionTokens })"
        >
          <i class="fas fa-coins flex-shrink-0 text-[9px] opacity-70" aria-hidden="true" />
          <span class="min-w-0 truncate">{{ t('aiAssistant.usage.session', { total: formatTokens(usageTotals.totalTokens) }) }}</span>
        </span>
        <div class="ai-composer-controls ml-auto flex flex-shrink-0 items-center gap-2">
          <label class="flex items-center gap-1.5" :title="t('aiAssistant.ui.backgroundToolsTitle')">
            <input v-model="config.enableBackgroundTools" type="checkbox" class="accent-primary" :disabled="isRunning" />
            <span>{{ t('aiAssistant.ui.backgroundTools') }}</span>
          </label>
          <div ref="modeMenuRef" class="relative">
            <button
              type="button"
              class="flex items-center gap-1.5 rounded border bg-input px-2 py-1 text-foreground transition-colors hover:bg-hover"
              :class="isAutoMode ? 'border-warning/60' : 'border-border'"
              :aria-expanded="modeMenuOpen"
              aria-haspopup="menu"
              @click="modeMenuOpen = !modeMenuOpen"
              @keydown.down.prevent="modeMenuOpen = true; focusFirstPopupItem(modeMenuRef)"
            >
              <span class="text-text-secondary">{{ t('aiAssistant.ui.mode') }}</span>
              <span class="font-medium" :class="isAutoMode ? 'text-warning' : ''">{{ activeModeOption.label }}</span>
              <i class="fas text-[10px] text-text-secondary" :class="modeMenuOpen ? 'fa-chevron-down' : 'fa-chevron-up'" aria-hidden="true" />
            </button>
            <div
              v-if="modeMenuOpen"
              role="menu"
              class="ai-popup-menu absolute bottom-full right-0 z-30 mb-1 w-44 overflow-hidden rounded border border-border bg-background py-1 shadow-xl"
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
            type="button"
            class="ai-ctrlc-btn"
            :disabled="!hasActiveTerminal"
            :title="t('aiAssistant.ui.sendCtrlC')"
            :aria-label="t('aiAssistant.ui.sendCtrlC')"
            @click="interruptTerminal"
          >^C</button>
        </div>
        <button
          type="button"
          class="ai-options-btn ml-auto"
          :class="{ 'is-auto': isAutoMode }"
          :aria-expanded="optionsSheetOpen"
          aria-haspopup="dialog"
          :title="t('aiUi.options.title')"
          @click="openOptionsSheet"
        >
          <i class="fas fa-sliders text-[11px]" aria-hidden="true" />
          <span class="truncate">{{ activeModeOption.label }}</span>
          <span class="sr-only">{{ t('aiUi.options.title') }}</span>
        </button>
      </div>
    </div>

    <div v-if="optionsSheetOpen" class="ai-sheet-scrim" @click="closeOptionsSheet" />
    <div
      v-if="optionsSheetOpen"
      ref="optionsSheetRef"
      class="ai-options-sheet"
      role="dialog"
      aria-modal="true"
      :aria-label="t('aiUi.options.title')"
    >
      <div class="ai-sheet-handle" aria-hidden="true" />
      <div class="ai-sheet-head">
        <span class="text-sm font-semibold">{{ t('aiUi.options.title') }}</span>
        <button type="button" class="ai-drawer-close" :title="t('aiAssistant.common.close')" :aria-label="t('aiAssistant.common.close')" @click="closeOptionsSheet">
          <i class="fas fa-xmark" aria-hidden="true" />
        </button>
      </div>
      <div class="ai-sheet-label">{{ t('aiAssistant.ui.mode') }}</div>
      <div role="radiogroup" :aria-label="t('aiAssistant.ui.mode')" class="ai-sheet-group">
        <button
          v-for="option in modeOptions"
          :key="option.value"
          type="button"
          role="radio"
          :aria-checked="runMode === option.value"
          class="ai-sheet-item"
          :class="{ 'is-selected': runMode === option.value, 'is-auto': option.value === 'auto' }"
          @click="selectRunMode(option.value)"
        >
          <i class="w-4 flex-shrink-0 text-center" :class="runMode === option.value ? 'fas fa-circle-dot text-primary' : 'far fa-circle text-text-secondary'" aria-hidden="true" />
          <span class="min-w-0 flex-1">
            <span class="block font-medium">{{ option.label }}</span>
            <span class="mt-0.5 block text-xs text-text-secondary">{{ option.description }}</span>
          </span>
        </button>
      </div>
      <div class="ai-sheet-group mt-2">
        <label class="ai-sheet-item" :title="t('aiAssistant.ui.backgroundToolsTitle')">
          <i class="fas fa-toolbox w-4 flex-shrink-0 text-center text-text-secondary" aria-hidden="true" />
          <span class="min-w-0 flex-1">
            <span class="block font-medium">{{ t('aiAssistant.ui.backgroundTools') }}</span>
            <span class="mt-0.5 block text-xs text-text-secondary">{{ t('aiAssistant.ui.backgroundToolsTitle') }}</span>
          </span>
          <input v-model="config.enableBackgroundTools" type="checkbox" role="switch" class="ai-switch" :disabled="isRunning" />
        </label>
        <button type="button" class="ai-sheet-item" :disabled="!hasActiveTerminal" @click="interruptFromSheet">
          <span class="ai-ctrlc-btn pointer-events-none flex-shrink-0" aria-hidden="true">^C</span>
          <span class="min-w-0 flex-1 font-medium">{{ t('aiAssistant.ui.sendCtrlC') }}</span>
        </button>
        <button type="button" class="ai-sheet-item" @click="openContextFromSheet">
          <i class="fas fa-database w-4 flex-shrink-0 text-center text-text-secondary" aria-hidden="true" />
          <span class="min-w-0 flex-1 font-medium">{{ t('aiAssistant.ui.contextMemory') }}</span>
          <span class="flex-shrink-0 text-xs tabular-nums" :class="contextHigh ? 'text-warning' : 'text-text-secondary'">{{ contextUsagePercent }}%</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-terminal-assistant {
  container-type: inline-size;
}

.ai-context-meter {
  display: inline-block;
  width: 28px;
  height: 4px;
  flex-shrink: 0;
  overflow: hidden;
  border-radius: 2px;
  background: color-mix(in srgb, var(--border-color, #334155) 80%, transparent);
}

.ai-context-meter.is-wide {
  display: block;
  width: 100%;
  height: 5px;
}

.ai-context-meter > span {
  display: block;
  height: 100%;
  background: var(--link-active-color, #e83e67);
}

.ai-context-meter.is-high > span {
  background: var(--color-warning, #f59e0b);
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


.ai-activity {
  opacity: 0.92;
}

.ai-icon-btn {
  display: inline-grid;
  width: 26px;
  height: 24px;
  flex-shrink: 0;
  place-items: center;
  border: 1px solid var(--border-color, #334155);
  border-radius: 4px;
  color: var(--text-color-secondary, #94a3b8);
  font-size: 11px;
}

.ai-icon-btn:hover:not(:disabled) {
  color: var(--text-color, #e8ebef);
  background: color-mix(in srgb, var(--text-color, #e8ebef) 8%, transparent);
}

.ai-icon-btn:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.ai-icon-btn-danger:hover:not(:disabled) {
  color: var(--color-error, #ef4444);
}

.ai-reasoning {
  border-left: 2px solid color-mix(in srgb, var(--text-color-secondary, #94a3b8) 45%, transparent);
  padding-left: 8px;
}

.ai-reasoning.is-live {
  border-left-color: color-mix(in srgb, var(--link-active-color, #e83e67) 70%, transparent);
}

.ai-reasoning-toggle {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  color: var(--text-color-secondary, #94a3b8);
  font-size: 11px;
  text-align: left;
}

.ai-reasoning-toggle:hover {
  color: var(--text-color, #e8ebef);
}

.ai-reasoning-body {
  max-height: 12rem;
  margin-top: 4px;
  overflow-y: auto;
  color: var(--text-color-secondary, #94a3b8);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.ai-activity-item {
  min-height: 1.25rem;
}

/* ---------- Composer ---------- */
.ai-composer-input {
  min-height: 2.5rem;
  max-height: calc(8 * 1.5em + 1rem + 2px);
  line-height: 1.5;
  overflow-y: hidden;
}

.ai-composer-input::placeholder {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-composer-input.is-running {
  min-height: 4.25rem;
}

.ai-send-btn {
  height: 2.5rem;
  min-width: 4.5rem;
}

.ai-run-actions {
  width: 4.5rem;
  height: 4.25rem;
}

.ai-ctx-chip {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 5px;
  padding: 1px 5px;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--text-color-secondary, #94a3b8);
}

.ai-ctx-chip:hover {
  border-color: var(--border-color, #334155);
  color: var(--text-color, #e8ebef);
}

.ai-ctx-chip.is-high {
  color: var(--color-warning, #f59e0b);
}

.ai-ctrlc-btn {
  display: inline-grid;
  min-width: 28px;
  height: 24px;
  place-items: center;
  padding: 0 5px;
  border: 1px solid var(--border-color, #334155);
  border-radius: 4px;
  color: var(--text-color-secondary, #94a3b8);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  font-weight: 600;
}

.ai-ctrlc-btn:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--color-error, #ef4444) 55%, var(--border-color, #334155));
  color: var(--text-color, #e8ebef);
}

.ai-ctrlc-btn:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.ai-options-btn {
  display: none;
  min-width: 0;
  max-width: 9rem;
  flex-shrink: 0;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border: 1px solid var(--border-color, #334155);
  border-radius: 6px;
  color: var(--text-color, #e8ebef);
}

.ai-options-btn.is-auto {
  border-color: color-mix(in srgb, var(--color-warning, #f59e0b) 65%, transparent);
  color: var(--color-warning, #f59e0b);
}

.ai-usage-alert {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  padding: 4px 6px 4px 8px;
  border: 1px solid color-mix(in srgb, var(--link-active-color, #e83e67) 35%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--link-active-color, #e83e67) 8%, transparent);
  color: var(--text-color, #e8ebef);
  font-size: 11px;
}

.ai-usage-alert.is-high {
  border-color: color-mix(in srgb, var(--color-warning, #f59e0b) 55%, transparent);
  background: color-mix(in srgb, var(--color-warning, #f59e0b) 12%, transparent);
  color: var(--color-warning, #f59e0b);
}

.ai-usage-alert-pct {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.ai-usage-alert-btn {
  flex-shrink: 0;
  padding: 1px 6px;
  border: 1px solid currentColor;
  border-radius: 4px;
  opacity: 0.9;
}

.ai-usage-alert-btn:hover {
  opacity: 1;
}

/* ---------- Header badges ---------- */
.ai-badge {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 3px;
  padding: 0 5px;
  height: 18px;
  border: 1px solid transparent;
  border-radius: 9px;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}

.ai-badge-auto {
  border-color: color-mix(in srgb, var(--color-warning, #f59e0b) 60%, transparent);
  background: color-mix(in srgb, var(--color-warning, #f59e0b) 16%, transparent);
  color: var(--color-warning, #f59e0b);
}

.ai-badge-pending {
  border-color: color-mix(in srgb, var(--color-error, #ef4444) 65%, transparent);
  background: color-mix(in srgb, var(--color-error, #ef4444) 18%, transparent);
  color: var(--color-error, #ef4444);
  animation: ai-badge-pulse 1.4s ease-in-out infinite;
}

@keyframes ai-badge-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-error, #ef4444) 45%, transparent); }
  50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-error, #ef4444) 0%, transparent); }
}

/* ---------- Messages ---------- */
.ai-message-row,
.ai-message-shell {
  min-width: 0;
}

.ai-msg-model {
  max-width: 14rem;
  padding: 0 5px;
  border: 1px solid color-mix(in srgb, var(--border-color, #334155) 80%, transparent);
  border-radius: 4px;
  color: var(--text-color-secondary, #94a3b8);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px;
  font-weight: 400;
}

.ai-msg-actions {
  opacity: 0;
  transition: opacity 120ms ease;
}

.ai-message-shell:hover .ai-msg-actions,
.ai-message-shell:focus-within .ai-msg-actions {
  opacity: 1;
}

.ai-msg-action {
  display: inline-grid;
  width: 26px;
  height: 24px;
  place-items: center;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--text-color-secondary, #94a3b8);
  font-size: 11px;
}

.ai-msg-action:hover:not(:disabled) {
  border-color: var(--border-color, #334155);
  color: var(--text-color, #e8ebef);
  background: color-mix(in srgb, var(--text-color, #e8ebef) 7%, transparent);
}

.ai-msg-action:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

@media (hover: none) {
  .ai-msg-actions {
    opacity: 1;
  }

  .ai-msg-action {
    width: 34px;
    height: 32px;
    font-size: 13px;
  }
}

/* ---------- Reply typography (rendered Markdown) ---------- */
.ai-md {
  min-width: 0;
  max-width: 100%;
  font-size: 14px;
  line-height: 1.65;
  overflow-wrap: anywhere;
  word-break: normal;
  line-break: auto;
  text-autospace: normal;
  hyphens: manual;
}

.ai-md.is-pending {
  color: var(--text-color-secondary, #94a3b8);
  font-size: 12px;
}

.ai-md :deep(p) {
  margin: 0 0 0.65em;
}

.ai-md :deep(> :last-child),
.ai-md :deep(li > :last-child),
.ai-md :deep(blockquote > :last-child) {
  margin-bottom: 0;
}

.ai-md :deep(> :first-child) {
  margin-top: 0;
}

.ai-md :deep(.ai-md-h) {
  margin: 1em 0 0.45em;
  color: var(--text-color, #e8ebef);
  font-weight: 650;
  line-height: 1.35;
}

.ai-md :deep(h1.ai-md-h) { font-size: 1.28em; }
.ai-md :deep(h2.ai-md-h) { font-size: 1.16em; }
.ai-md :deep(h3.ai-md-h) { font-size: 1.06em; }
.ai-md :deep(h4.ai-md-h),
.ai-md :deep(h5.ai-md-h),
.ai-md :deep(h6.ai-md-h) { font-size: 1em; }

.ai-md :deep(h1.ai-md-h),
.ai-md :deep(h2.ai-md-h) {
  padding-bottom: 0.2em;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color, #334155) 70%, transparent);
}

.ai-md :deep(ul),
.ai-md :deep(ol) {
  margin: 0.25em 0 0.7em;
  padding-left: 1.45em;
}

.ai-md :deep(ul) { list-style: disc; }
.ai-md :deep(ul ul) { list-style: circle; }
.ai-md :deep(ol) { list-style: decimal; }

.ai-md :deep(li) {
  margin: 0.2em 0;
  padding-left: 0.15em;
}

.ai-md :deep(li > ul),
.ai-md :deep(li > ol),
.ai-md :deep(li > p) {
  margin-top: 0.2em;
  margin-bottom: 0.2em;
}

.ai-md :deep(li::marker) {
  color: var(--text-color-secondary, #94a3b8);
}

.ai-md :deep(strong) {
  color: var(--text-color, #e8ebef);
  font-weight: 650;
}

.ai-md :deep(a) {
  color: var(--link-active-color, #e83e67);
  text-decoration: underline;
  text-underline-offset: 2px;
  overflow-wrap: anywhere;
}

.ai-md :deep(.ai-md-inline-code) {
  padding: 0.08em 0.36em;
  border: 1px solid color-mix(in srgb, var(--border-color, #334155) 65%, transparent);
  border-radius: 4px;
  background: color-mix(in srgb, var(--text-color, #e8ebef) 8%, transparent);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 0.86em;
  overflow-wrap: anywhere;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}

.ai-md :deep(.ai-md-code) {
  max-width: 100%;
  margin: 0.6em 0 0.75em;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--border-color, #334155) 85%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--text-color, #e8ebef) 5%, var(--app-bg-color, #0b0e12));
}

.ai-md :deep(.ai-md-code-head) {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  padding: 2px 3px 2px 9px;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color, #334155) 70%, transparent);
  color: var(--text-color-secondary, #94a3b8);
  font-size: 11px;
  line-height: 1.4;
}

.ai-md :deep(.ai-md-code-lang) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.ai-md :deep(.ai-md-code-badge) {
  flex-shrink: 0;
  padding: 0 5px;
  border: 1px solid currentColor;
  border-radius: 4px;
  font-size: 10px;
}

.ai-md :deep(.ai-md-code-badge.is-danger) { color: var(--color-error, #ef4444); }
.ai-md :deep(.ai-md-code-badge.is-confirm) { color: var(--color-warning, #f59e0b); }

.ai-md :deep(.ai-md-code-actions) {
  display: flex;
  flex-shrink: 0;
  gap: 2px;
  margin-left: auto;
}

.ai-md :deep(.ai-md-code-btn) {
  display: inline-grid;
  width: 26px;
  height: 24px;
  place-items: center;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--text-color-secondary, #94a3b8);
}

.ai-md :deep(.ai-md-code-btn:hover),
.ai-md :deep(.ai-md-code-btn:focus-visible) {
  border-color: var(--border-color, #334155);
  color: var(--text-color, #e8ebef);
}

.ai-md :deep(.ai-md-code-btn.is-done) {
  color: var(--color-success, #22c55e);
}

@media (hover: none) {
  .ai-md :deep(.ai-md-code-btn) {
    width: 34px;
    height: 32px;
  }
}

.ai-md :deep(.ai-md-pre) {
  margin: 0;
  padding: 8px 10px;
  overflow-x: auto;
  border: 0;
  background: transparent;
  color: var(--text-color, #e8ebef);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre;
  overflow-wrap: normal;
  word-break: normal;
  tab-size: 4;
}

.ai-md :deep(.ai-md-table-wrap) {
  max-width: 100%;
  margin: 0.6em 0 0.75em;
  overflow-x: auto;
  border: 1px solid color-mix(in srgb, var(--border-color, #334155) 80%, transparent);
  border-radius: 6px;
}

.ai-md :deep(table) {
  width: max-content;
  min-width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
  line-height: 1.5;
}

.ai-md :deep(th),
.ai-md :deep(td) {
  max-width: 24em;
  padding: 4px 9px;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color, #334155) 60%, transparent);
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
}

.ai-md :deep(th) {
  background: color-mix(in srgb, var(--text-color, #e8ebef) 6%, transparent);
  color: var(--text-color, #e8ebef);
  font-weight: 600;
  white-space: nowrap;
}

.ai-md :deep(tr:last-child td) {
  border-bottom: 0;
}

.ai-md :deep(blockquote) {
  margin: 0.6em 0 0.75em;
  padding: 0.25em 0.8em;
  border-left: 3px solid color-mix(in srgb, var(--link-active-color, #e83e67) 55%, transparent);
  border-radius: 0 4px 4px 0;
  background: color-mix(in srgb, var(--text-color, #e8ebef) 4%, transparent);
  color: var(--text-color-secondary, #94a3b8);
}

.ai-md :deep(hr) {
  margin: 0.9em 0;
  border: 0;
  border-top: 1px solid color-mix(in srgb, var(--border-color, #334155) 80%, transparent);
}

.ai-md :deep(.ai-md-task) {
  color: var(--text-color-secondary, #94a3b8);
}

/* ---------- 执行步骤 timeline ---------- */
.ai-steps {
  margin-top: 8px;
  border-left: 2px solid color-mix(in srgb, var(--text-color-secondary, #94a3b8) 35%, transparent);
  padding-left: 8px;
}

.ai-steps-toggle {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  color: var(--text-color-secondary, #94a3b8);
  font-size: 11px;
  text-align: left;
}

.ai-steps-problems {
  /* warning yellow mixed toward the text colour: readable on light themes too */
  color: color-mix(in srgb, var(--color-warning, #f59e0b) 70%, var(--text-color, #e8ebef));
}

.ai-steps-toggle:hover {
  color: var(--text-color, #e8ebef);
}

.ai-steps-list {
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}

.ai-step {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 7px;
  padding: 4px 0;
  font-size: 11px;
  line-height: 1.45;
}

.ai-step + .ai-step {
  border-top: 1px dashed color-mix(in srgb, var(--border-color, #334155) 60%, transparent);
}

.ai-step-icon.is-ok { color: var(--color-success, #22c55e); }
.ai-step-icon.is-error { color: var(--color-error, #ef4444); }
.ai-step-icon.is-denied { color: var(--color-warning, #f59e0b); }
.ai-step-icon.is-cancelled { color: var(--text-color-secondary, #94a3b8); }
.ai-step-icon.is-running { color: var(--link-active-color, #e83e67); }

.ai-step-icon {
  width: 12px;
  margin-top: 2px;
  flex-shrink: 0;
  font-size: 11px;
  text-align: center;
}

.ai-step-status {
  flex-shrink: 0;
  padding: 0 4px;
  border-radius: 3px;
  font-size: 10px;
}

.ai-step-status.is-ok { color: var(--color-success, #22c55e); }
.ai-step-status.is-error { color: var(--color-error, #ef4444); }
.ai-step-status.is-denied { color: color-mix(in srgb, var(--color-warning, #f59e0b) 70%, var(--text-color, #e8ebef)); }
.ai-step-status.is-cancelled,
.ai-step-status.is-running { color: var(--text-color-secondary, #94a3b8); }

.ai-step-summary {
  margin-top: 1px;
  overflow: hidden;
  color: var(--text-color-secondary, #94a3b8);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-tool-run.is-highlighted {
  border-color: color-mix(in srgb, var(--link-active-color, #e83e67) 70%, transparent);
}

/* ---------- Empty state ---------- */
.ai-empty-state {
  display: flex;
  min-height: 100%;
  align-items: center;
  justify-content: center;
  padding: 8px 0;
}

.ai-empty-card {
  width: 100%;
  max-width: 26rem;
  padding: 4px 6px;
  text-align: center;
}

.ai-empty-caps {
  display: inline-flex;
  flex-direction: column;
  gap: 5px;
  margin: 12px auto 0;
  padding: 0;
  list-style: none;
  color: var(--text-color, #e8ebef);
  font-size: 12.5px;
  text-align: left;
}

.ai-empty-caps li {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.ai-empty-caps li i {
  width: 14px;
  flex-shrink: 0;
  color: var(--link-active-color, #e83e67);
  font-size: 11px;
  text-align: center;
}

.ai-empty-caps li.is-off {
  color: var(--text-color-secondary, #94a3b8);
}

.ai-empty-caps li.is-off i {
  color: var(--text-color-secondary, #94a3b8);
}

.ai-empty-meta {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
  margin-top: 12px;
}

.ai-empty-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border: 1px solid color-mix(in srgb, var(--border-color, #334155) 90%, transparent);
  border-radius: 999px;
  font-size: 11px;
}

.ai-empty-chip.is-auto {
  border-color: color-mix(in srgb, var(--color-warning, #f59e0b) 60%, transparent);
  color: var(--color-warning, #f59e0b);
}

.ai-quick-chip {
  padding: 4px 10px;
  border: 1px solid color-mix(in srgb, var(--border-color, #334155) 90%, transparent);
  border-radius: 999px;
  color: var(--text-color-secondary, #94a3b8);
  font-size: 11.5px;
  transition: border-color 120ms ease, color 120ms ease;
}

.ai-quick-chip:hover {
  border-color: color-mix(in srgb, var(--link-active-color, #e83e67) 60%, transparent);
  color: var(--text-color, #e8ebef);
}

/* ---------- Options bottom sheet (opaque even in glass themes) ---------- */
.ai-sheet-scrim {
  position: absolute;
  inset: 0;
  z-index: 40;
  background: rgba(0, 0, 0, 0.45);
}

.ai-options-sheet {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 41;
  max-height: 85%;
  overflow-y: auto;
  padding: 6px 12px calc(12px + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--border-color, #334155);
  border-radius: 14px 14px 0 0;
  background: var(--app-bg-color, #0b0e12);
  box-shadow: 0 -16px 40px rgba(0, 0, 0, 0.35);
  color: var(--text-color, #e8ebef);
}

.ai-sheet-handle {
  width: 36px;
  height: 4px;
  margin: 2px auto 6px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--text-color-secondary, #94a3b8) 55%, transparent);
}

.ai-sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.ai-sheet-label {
  margin: 6px 2px 4px;
  color: var(--text-color-secondary, #94a3b8);
  font-size: 11px;
}

.ai-sheet-group {
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--border-color, #334155) 85%, transparent);
  border-radius: 10px;
}

.ai-sheet-item {
  display: flex;
  width: 100%;
  min-height: 52px;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
}

.ai-sheet-item + .ai-sheet-item {
  border-top: 1px solid color-mix(in srgb, var(--border-color, #334155) 70%, transparent);
}

.ai-sheet-item:hover:not(:disabled) {
  background: color-mix(in srgb, var(--text-color, #e8ebef) 6%, transparent);
}

.ai-sheet-item:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.ai-sheet-item.is-selected {
  background: color-mix(in srgb, var(--link-active-color, #e83e67) 12%, transparent);
}

.ai-sheet-item.is-selected.is-auto {
  background: color-mix(in srgb, var(--color-warning, #f59e0b) 14%, transparent);
}

.ai-switch {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  accent-color: var(--link-active-color, #e83e67);
}

@media (prefers-reduced-motion: reduce) {
  .ai-message-shell,
  .ai-msg-actions {
    transition: none;
  }

  .ai-badge-pending {
    animation: none;
  }
}

/* ---------- Responsive (container = the AI pane) ---------- */
@container (max-width: 639px) {
  .ai-composer-hint {
    display: none;
  }
}

@container (max-width: 420px) {
  .ai-assistant-header {
    gap: 6px;
    padding-left: 8px;
    padding-right: 6px;
  }

  .ai-header-main {
    gap: 6px;
  }

  .ai-header-title,
  .ai-header-divider,
  .ai-header-session,
  .ai-header-status-text {
    display: none;
  }

  .ai-header-model {
    flex: 1 1 auto;
  }

  .ai-badge > span {
    display: none;
  }

  .ai-badge {
    width: 18px;
    justify-content: center;
    padding: 0;
  }

  .ai-composer-controls {
    display: none;
  }

  .ai-options-btn {
    display: inline-flex;
  }

  .ai-msg-model {
    max-width: 7rem;
  }
}

.is-mobile-overlay .ai-composer-controls {
  display: none;
}

.is-mobile-overlay .ai-options-btn {
  display: inline-flex;
  min-height: 36px;
  padding: 4px 12px;
  font-size: 13px;
}

.is-mobile-overlay .ai-send-btn {
  height: 2.75rem;
}

.is-mobile-overlay .ai-composer-input {
  min-height: 2.75rem;
  font-size: 16px;
}
</style>
