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

export type TerminalInputArgs = {
  text: string;
  pressEnter?: boolean;
  sessionId?: string;
  waitMs?: number;
  reason?: string;
};

export type AiToolRunStatus = 'running' | 'done' | 'error' | 'cancelled';
export type AiRunMode = 'readOnly' | 'confirm' | 'auto';
export type AiTaskStatus = 'idle' | 'thinking' | 'awaitingConfirmation' | 'runningTool' | 'waitingOutput' | 'compressing' | 'done' | 'stopped' | 'interrupted' | 'error';

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

// UI-only progress events. They are deliberately kept out of AiSessionMemory
// so they never become part of the model context or the compressed summary.
export type AiActivityEvent = {
  id: string;
  title: string;
  detail?: string;
  state: 'active' | 'done' | 'error';
  createdAt: number;
};

export type RiskConfirmation = {
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

export type AiCompactResult = {
  compacted: boolean;
  reason: 'empty' | 'underBudget' | 'compacted';
  requestBytes: number;
  thresholdBytes: number;
  compactedCount?: number;
  retainedCount?: number;
  finalRequestBytes?: number;
  hardLimitBytes?: number;
  summaryMode?: 'local' | 'ai' | 'pending';
};

export type AiCompressionStats = {
  at: number;
  beforeBytes: number;
  afterBytes: number;
  hardLimitBytes: number;
  compactedCount: number;
  retainedCount: number;
  summaryMode: 'local' | 'ai' | 'pending';
};

export type SendMessageOptions = {
  confirmCommand?: (preview: CommandPreview) => Promise<boolean>;
};

export type AiSessionMemory = {
  messages: AiChatMessage[];
  toolRuns: AiToolRun[];
  summary: string;
  summaryUpdatedAt?: number;
  lastCompactedAt?: number;
  compression?: AiCompressionStats;
};

export type AiSessionExport = {
  format: 'nexus-terminal-ai-session';
  version: 3;
  exportedAt: string;
  sessionId: string;
  connectionName: string;
  connection: {
    name: string;
    host: string;
    port: string;
  };
  memory: AiSessionMemory;
};

export type CompactContextOptions = {
  force?: boolean;
  title: string;
  awaitAiSummary: boolean;
  sessionId?: string;
  runtime?: AiRuntimeState;
  compactTriggerBytes?: number;
  maxRequestBytes?: number;
};

export type AiRunContext = {
  sessionId: string;
  memory: AiSessionMemory;
  runtime: AiRuntimeState;
};

export type AiRuntimeState = {
  isRunning: boolean;
  stopRequested: boolean;
  taskStatus: AiTaskStatus;
  errorMessage: string;
  abortController: AbortController | null;
  activityEvents: AiActivityEvent[];
  continuationAvailable: boolean;
  // Counts automatic size-based compactions within one user-message task.
  autoCompactCount: number;
};
