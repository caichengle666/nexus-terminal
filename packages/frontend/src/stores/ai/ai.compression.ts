import {
  AI_REQUEST_COMPACT_BYTES,
  MAX_AI_REQUEST_BYTES,
  MAX_COMPACT_TOOL_RUNS,
  MAX_MODEL_CONTEXT_CHARS,
  MIN_TAIL_MESSAGES,
  TAIL_CONTEXT_BUDGET_CHARS,
} from './ai.constants';
import { aiTools, parseToolArgs, summarizeToolResultContent } from './ai.tools';
import type {
  AiChatMessage,
  AiCompactResult,
  AiRunContext,
  AiRuntimeState,
  AiSessionMemory,
  CompactContextOptions,
} from './ai.types';
import { mergeSummarySections, trimSummaryForStorage } from './ai.memory';

export const estimateJsonBytes = (value: unknown) => new Blob([JSON.stringify(value)]).size;
const aiSummaryInFlight = new WeakMap<AiSessionMemory, Promise<boolean>>();

export const estimateMessageChars = (items: AiChatMessage[]) => items.reduce((total, message) => {
  const contentLength = typeof message.content === 'string' ? message.content.length : 0;
  const toolLength = message.tool_calls ? JSON.stringify(message.tool_calls).length : 0;
  return total + contentLength + toolLength;
}, 0);

export const sanitizeToolMessages = (items: AiChatMessage[]): AiChatMessage[] => {
  const toolCallIds = new Set<string>();
  for (const message of items) {
    if (message.role === 'assistant' && message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        toolCallIds.add(call.id);
      }
    }
  }
  const result: AiChatMessage[] = [];
  for (const message of items) {
    if (message.role === 'tool' && message.tool_call_id && !toolCallIds.has(String(message.tool_call_id))) {
      continue;
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const keptCalls = message.tool_calls.filter(call => {
        for (const other of items) {
          if (other.role === 'tool' && String(other.tool_call_id || '') === call.id) return true;
        }
        return false;
      });
      if (keptCalls.length === 0 && !message.content) {
        continue;
      }
      result.push({ ...message, tool_calls: keptCalls });
      continue;
    }
    result.push(message);
  }
  return result;
};

export const pruneToolMessages = (items: AiChatMessage[]) => {
  const seenToolResults = new Set<string>();
  let changed = false;
  const pruned = [...items].reverse().map(message => {
    // Never truncate tool_call arguments. Providers require the original JSON
    // arguments to stay intact when tool history is replayed.
    if (message.role === 'assistant' && message.tool_calls?.length) {
      return message;
    }

    if (message.role !== 'tool' || typeof message.content !== 'string') {
      return message;
    }

    const summarized = summarizeToolResultContent(message.content);
    const duplicateKey = summarized.replace(/\s+/g, ' ').slice(0, 2000);
    if (seenToolResults.has(duplicateKey)) {
      changed = true;
      return {
        ...message,
        content: '<duplicate tool result omitted; same as a newer tool result>',
      };
    }
    seenToolResults.add(duplicateKey);
    if (summarized !== message.content) {
      changed = true;
      return { ...message, content: summarized };
    }
    return message;
  }).reverse();

  return {
    changed,
    messages: pruned,
  };
};

export const selectTailMessages = (items: AiChatMessage[], budgetChars: number) => {
  const protectedIndexes = new Set<number>();
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].role === 'user') {
      protectedIndexes.add(index);
      break;
    }
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].role === 'assistant') {
      protectedIndexes.add(index);
      break;
    }
  }

  const selectedIndexes = new Set<number>();
  let usedChars = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const messageChars = estimateMessageChars([items[index]]);
    const mustKeep = protectedIndexes.has(index) || selectedIndexes.size < MIN_TAIL_MESSAGES;
    if (!mustKeep && usedChars + messageChars > budgetChars) break;
    selectedIndexes.add(index);
    usedChars += messageChars;
  }

  for (const index of protectedIndexes) {
    selectedIndexes.add(index);
  }

  const tailMessages = items.filter((_, index) => selectedIndexes.has(index));
  const olderMessages = items.filter((_, index) => !selectedIndexes.has(index));

  return {
    olderMessages,
    tailMessages: sanitizeToolMessages(tailMessages),
  };
};

export const removeOldestModelContextMessage = (items: AiChatMessage[], startIndex: number) => {
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

export const summarizeMessages = (items: AiChatMessage[]) => {
  const goals: string[] = [];
  const constraints: string[] = [];
  const assistantNotes: string[] = [];
  const toolCalls: string[] = [];
  const toolResults: string[] = [];
  const commands: string[] = [];
  const blocked: string[] = [];
  const files: string[] = [];
  for (const message of items) {
    if (message.role === 'user' && message.content) {
      const content = String(message.content).replace(/\s+/g, ' ').trim();
      goals.push(`- ${content.slice(0, 500)}`);
      if (/必须|不要|不能|需要|要求|只要|最好|支持|保留/i.test(content)) {
        constraints.push(`- ${content.slice(0, 500)}`);
      }
    } else if (message.role === 'assistant' && message.content) {
      assistantNotes.push(`- ${String(message.content).slice(0, 700)}`);
    } else if (message.role === 'assistant' && message.tool_calls?.length) {
      const names = message.tool_calls.map(call => call.function.name).join(', ');
      toolCalls.push(`- ${names}`);
      for (const call of message.tool_calls) {
        const args = parseToolArgs(call);
        if (call.function.name === 'terminal_input' && typeof args.text === 'string') {
          commands.push(`- ${args.text.slice(0, 500)}`);
        }
      }
    } else if (message.role === 'tool' && message.content) {
      const result = summarizeToolResultContent(String(message.content)).slice(0, 900);
      toolResults.push(`- ${result}`);
      if (/error|failed|失败|错误|exception|拒绝|不存在/i.test(result)) blocked.push(`- ${result.slice(0, 700)}`);
      const pathMatches = result.match(/(?:[A-Za-z]:\\|\/)[^\s,;，；)]+/g) || [];
      files.push(...pathMatches.slice(0, 4).map(path => `- ${path}`));
    }
  }

  return [
    '## Historical Task Snapshot',
    '## Goal',
    goals.slice(-12).join('\n') || '- 未记录明确用户目标',
    '## Constraints & Preferences',
    constraints.slice(-8).join('\n') || '- 未记录特殊约束',
    '## Completed Actions',
    commands.slice(-20).join('\n') || toolCalls.slice(-20).join('\n') || '- 暂无已执行命令',
    '## Active State',
    assistantNotes.slice(-10).join('\n') || '- 暂无明确结论',
    '## Blocked',
    blocked.slice(-8).join('\n') || '- 当前没有明确阻塞',
    '## Key Decisions',
    assistantNotes.slice(-6).join('\n') || '- 暂无关键决定',
    '## Key Tool Results',
    toolResults.slice(-16).join('\n') || '- 暂无工具结果',
    '## Relevant Files',
    [...new Set(files)].slice(-12).join('\n') || '- 未发现相关文件路径',
    '## Remaining Work',
    '- 根据最近未压缩上下文继续处理用户最新请求',
  ].join('\n');
};

export const formatMessagesForSummary = (items: AiChatMessage[]) => {
  const lines: string[] = [];
  for (const message of items) {
    if (message.role === 'user' && message.content) {
      lines.push(`[用户] ${String(message.content).slice(0, 800)}`);
    } else if (message.role === 'assistant' && message.content) {
      lines.push(`[AI] ${String(message.content).slice(0, 800)}`);
    } else if (message.role === 'assistant' && message.tool_calls?.length) {
      const names = message.tool_calls.map(call => call.function.name).join(', ');
      lines.push(`[AI 调用工具] ${names}`);
    } else if (message.role === 'tool' && message.content) {
      lines.push(`[工具结果] ${String(message.content).slice(0, 800)}`);
    }
  }
  // Prefer tail: keep the most recent 18000 chars when content is too long
  const joined = lines.join('\n');
  if (joined.length <= 18000) return joined;
  return joined.slice(-18000);
};

export const estimateMemoryRequestBytes = (memory: AiSessionMemory) => estimateJsonBytes({
  messages: memory.messages,
  summary: memory.summary,
  tools: aiTools,
});

type CompactSessionContextOptions = CompactContextOptions & {
  getMemory: (sessionId?: string) => AiSessionMemory;
  getRuntime: (sessionId?: string) => AiRuntimeState;
  summarizeWithAi: (olderMessages: AiChatMessage[], memory: AiSessionMemory, runtime: AiRuntimeState) => Promise<boolean>;
  activeMemoryKey: string;
};

export const compactSessionContext = async ({
  force = false,
  title,
  awaitAiSummary,
  sessionId,
  runtime,
  getMemory,
  getRuntime,
  summarizeWithAi,
  activeMemoryKey,
  compactTriggerBytes,
  maxRequestBytes,
}: CompactSessionContextOptions): Promise<AiCompactResult> => {
  const memory = getMemory(sessionId);
  const runtimeState = runtime || getRuntime(sessionId || activeMemoryKey);
  const effectiveCompactTriggerBytes = Math.min(
    maxRequestBytes ?? MAX_AI_REQUEST_BYTES,
    Math.max(1, compactTriggerBytes ?? AI_REQUEST_COMPACT_BYTES),
  );
  const effectiveMaxRequestBytes = maxRequestBytes ?? MAX_AI_REQUEST_BYTES;
  const existingSummary = aiSummaryInFlight.get(memory);
  if (existingSummary) {
    await existingSummary;
    const currentBytes = estimateMemoryRequestBytes(memory);
    return {
      compacted: false,
      reason: 'underBudget',
      requestBytes: currentBytes,
      thresholdBytes: effectiveCompactTriggerBytes,
      finalRequestBytes: currentBytes,
      hardLimitBytes: effectiveMaxRequestBytes,
      summaryMode: 'ai',
    };
  }
  memory.summary = trimSummaryForStorage(memory.summary || '');
  const pruned = pruneToolMessages(memory.messages);
  if (pruned.changed) {
    memory.messages = pruned.messages;
  }
  const requestBytes = estimateMemoryRequestBytes(memory);
  const isOverBudget = requestBytes > effectiveCompactTriggerBytes;

  // Auto-compaction is size-driven only. Message count is intentionally not a trigger.
  if (!force && !isOverBudget) {
    return {
      compacted: pruned.changed,
      reason: 'underBudget',
      requestBytes,
      thresholdBytes: effectiveCompactTriggerBytes,
      finalRequestBytes: requestBytes,
      hardLimitBytes: effectiveMaxRequestBytes,
    };
  }

  const tailBudget = force || isOverBudget
    ? Math.floor(TAIL_CONTEXT_BUDGET_CHARS * 0.7)
    : TAIL_CONTEXT_BUDGET_CHARS;
  const { olderMessages, tailMessages } = selectTailMessages(memory.messages, tailBudget);

  if (olderMessages.length === 0) {
    return {
      compacted: pruned.changed,
      reason: 'empty',
      requestBytes,
      thresholdBytes: effectiveCompactTriggerBytes,
      finalRequestBytes: requestBytes,
      hardLimitBytes: effectiveMaxRequestBytes,
    };
  }

  const localSummary = summarizeMessages(olderMessages);
  if (!localSummary.trim()) {
    return {
      compacted: pruned.changed,
      reason: 'empty',
      requestBytes,
      thresholdBytes: effectiveCompactTriggerBytes,
      finalRequestBytes: requestBytes,
      hardLimitBytes: effectiveMaxRequestBytes,
    };
  }

  const compactedCount = olderMessages.length;
  const retainedCount = tailMessages.length;
  runtimeState.taskStatus = 'compressing';
  memory.summary = trimSummaryForStorage(mergeSummarySections(memory.summary || '', `${title}:\n${localSummary}`));
  memory.messages = tailMessages;
  // Keep recent tool history for the drawer, but drop older tool runs after compaction.
  if (Array.isArray(memory.toolRuns) && memory.toolRuns.length > MAX_COMPACT_TOOL_RUNS) {
    memory.toolRuns = memory.toolRuns.slice(-MAX_COMPACT_TOOL_RUNS);
  }
  memory.summaryUpdatedAt = Date.now();
  memory.lastCompactedAt = Date.now();

  const beforeBytes = requestBytes;
  const afterBytes = estimateMemoryRequestBytes(memory);
  memory.compression = {
    at: Date.now(),
    beforeBytes,
    afterBytes,
    hardLimitBytes: effectiveMaxRequestBytes,
    compactedCount,
    retainedCount,
    summaryMode: 'pending',
  };

  const aiSummaryPromise = summarizeWithAi(olderMessages, memory, runtimeState)
    .then(usedAiSummary => {
      if (!usedAiSummary && memory.compression) memory.compression.summaryMode = 'local';
      return usedAiSummary;
    })
    .finally(() => aiSummaryInFlight.delete(memory));
  aiSummaryInFlight.set(memory, aiSummaryPromise);
  if (awaitAiSummary) {
    await aiSummaryPromise;
  } else {
    void aiSummaryPromise;
  }

  const finalRequestBytes = awaitAiSummary ? estimateMemoryRequestBytes(memory) : afterBytes;
  if (awaitAiSummary && memory.compression) {
    memory.compression.afterBytes = finalRequestBytes;
    memory.compression.at = Date.now();
  }

  return {
    compacted: true,
    reason: 'compacted',
    requestBytes,
    thresholdBytes: effectiveCompactTriggerBytes,
    compactedCount,
    retainedCount,
    finalRequestBytes,
    hardLimitBytes: effectiveMaxRequestBytes,
    summaryMode: awaitAiSummary ? (memory.compression?.summaryMode || 'local') : 'pending',
  };
};

export const shrinkModelMessagesToBudget = (items: AiChatMessage[], summary: string) => {
  const firstRecentMessageIndex = summary ? 2 : 1;
  while (items.length > 6 && estimateMessageChars(items) > MAX_MODEL_CONTEXT_CHARS) {
    removeOldestModelContextMessage(items, firstRecentMessageIndex);
  }
};
