// UI-only "执行步骤" timeline helpers. Steps live on the assistant message that
// issued the tool calls so they persist after a run (and in saved history); they
// are stripped before anything is sent to the model.
import type { AiChatMessage, AiMessageStep, AiStepStatus, AiToolRun } from './ai.types';

export const MAX_STEPS_PER_MESSAGE = 40;
const MAX_SUMMARY_CHARS = 120;

const clip = (value: string, max = MAX_SUMMARY_CHARS) => {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
};

/** A short, language-neutral summary of a tool call's arguments. */
export const summarizeToolArgs = (name: string, args: Record<string, unknown>) => {
  const str = (key: string) => (typeof args[key] === 'string' ? String(args[key]) : '');
  if (name === 'terminal_input') return clip(str('text'));
  if (name === 'execute_command') return clip(str('command'));
  if (name === 'execute_command_batch') {
    const count = Array.isArray(args.targetSessionIds) ? args.targetSessionIds.length : 0;
    return clip(`${count ? `×${count} ` : ''}${str('command')}`);
  }
  if (name === 'read_remote_file' || name === 'write_remote_file' || name === 'list_remote_directory') return clip(str('path'));
  if (name === 'send_terminal_key') return clip(str('key'));
  if (name === 'get_terminal_output') return args.maxLines ? String(Number(args.maxLines)) : '';
  if (name === 'wait_for_terminal_output') return args.timeoutMs ? `≤${(Number(args.timeoutMs) / 1000).toFixed(1)}s` : '';
  if (name === 'propose_system_prompt_update') return clip(str('reason'));
  return '';
};

/**
 * Maps a finished tool run to a step status. A cancelled run is "denied" (user
 * rejected it, or the mode blocked it) unless the whole AI run was stopped.
 */
export const stepStatusFromRun = (run: Pick<AiToolRun, 'status'>, stopRequested = false): AiStepStatus => {
  if (run.status === 'running') return 'running';
  if (run.status === 'done') return 'ok';
  if (run.status === 'cancelled') return stopRequested ? 'cancelled' : 'denied';
  return 'error';
};

export const createStep = (toolCallId: string, name: string, args: Record<string, unknown>, startedAt = Date.now()): AiMessageStep => ({
  id: toolCallId,
  name,
  summary: summarizeToolArgs(name, args),
  status: 'running',
  startedAt,
});

/** Adds (or replaces) a step on a message, keeping the list bounded. Returns the stored step. */
export const upsertStep = (message: AiChatMessage, step: AiMessageStep) => {
  const steps = Array.isArray(message.steps) ? message.steps : [];
  const index = steps.findIndex(item => item.id === step.id);
  if (index >= 0) steps.splice(index, 1, step);
  else steps.push(step);
  if (steps.length > MAX_STEPS_PER_MESSAGE) steps.splice(0, steps.length - MAX_STEPS_PER_MESSAGE);
  message.steps = steps;
  return message.steps.find(item => item.id === step.id) || step;
};

export const finishStep = (step: AiMessageStep, run: Pick<AiToolRun, 'status' | 'args' | 'finishedAt' | 'startedAt' | 'name'>, stopRequested = false) => {
  step.status = stepStatusFromRun(run, stopRequested);
  const finishedAt = run.finishedAt || Date.now();
  step.durationMs = Math.max(0, finishedAt - (run.startedAt || step.startedAt));
  const summary = summarizeToolArgs(run.name, run.args || {});
  if (summary) step.summary = summary;
  return step;
};

/** The assistant message (from the end) that issued the given tool call. */
export const findToolCallOwner = (messages: AiChatMessage[], toolCallId: string) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant' && message.tool_calls?.some(call => call.id === toolCallId)) return message;
  }
  return undefined;
};

/**
 * Steps of every assistant message in one user turn, grouped onto the turn's last
 * visible reply (tool-only messages are hidden in the conversation).
 */
export const collectTurnSteps = (
  messages: AiChatMessage[],
  isVisibleAssistant: (message: AiChatMessage) => boolean,
) => {
  const result = new Map<AiChatMessage, AiMessageStep[]>();
  let steps: AiMessageStep[] = [];
  let lastVisible: AiChatMessage | null = null;
  const flush = () => {
    if (lastVisible && steps.length > 0) result.set(lastVisible, steps);
    steps = [];
    lastVisible = null;
  };
  for (const message of messages) {
    if (message.role === 'user') {
      flush();
      continue;
    }
    if (message.role !== 'assistant') continue;
    if (Array.isArray(message.steps) && message.steps.length > 0) steps = steps.concat(message.steps);
    if (isVisibleAssistant(message)) lastVisible = message;
  }
  flush();
  return result;
};

/**
 * Where to cut the message list to regenerate the assistant turn that contains
 * `messages[index]`: just after the user message that started that turn.
 * Returns -1 when there is no preceding user message.
 */
export const retryTruncateIndex = (messages: AiChatMessage[], index: number) => {
  if (index < 0 || index >= messages.length) return -1;
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (messages[cursor].role === 'user') return cursor + 1;
  }
  return -1;
};
