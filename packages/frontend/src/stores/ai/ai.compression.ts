import {
  AI_REQUEST_COMPACT_BYTES,
  COMPACT_CHAR_TRIGGER,
  COMPACT_MESSAGE_TRIGGER,
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
import { appendSummarySection, trimSummaryForStorage } from './ai.memory';

export const estimateJsonBytes = (value: unknown) => new Blob([JSON.stringify(value)]).size;

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
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const toolCalls = message.tool_calls.map(call => {
        const args = call.function.arguments || '';
        if (args.length <= 1200) return call;
        changed = true;
        return {
          ...call,
          function: {
            ...call.function,
            arguments: `${args.slice(0, 1200)}...<tool arguments truncated>`,
          },
        };
      });
      return { ...message, tool_calls: toolCalls };
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
  const assistantNotes: string[] = [];
  const toolCalls: string[] = [];
  const toolResults: string[] = [];
  const commands: string[] = [];
  for (const message of items) {
    if (message.role === 'user' && message.content) {
      goals.push(`- ${String(message.content).slice(0, 500)}`);
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
      toolResults.push(`- ${summarizeToolResultContent(String(message.content)).slice(0, 900)}`);
    }
  }

  return [
    '## Historical Task Snapshot',
    '## Goal',
    goals.slice(-12).join('\n') || '- 未记录明确用户目标',
    '## Completed Actions',
    commands.slice(-20).join('\n') || toolCalls.slice(-20).join('\n') || '- 暂无已执行命令',
    '## Active State',
    assistantNotes.slice(-10).join('\n') || '- 暂无明确结论',
    '## Key Tool Results',
    toolResults.slice(-16).join('\n') || '- 暂无工具结果',
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
  return lines.join('\n');
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
}: CompactSessionContextOptions): Promise<AiCompactResult> => {
  const memory = getMemory(sessionId);
  const runtimeState = runtime || getRuntime(sessionId || activeMemoryKey);
  memory.summary = trimSummaryForStorage(memory.summary || '');
  const pruned = pruneToolMessages(memory.messages);
  if (pruned.changed) {
    memory.messages = pruned.messages;
  }
  const requestBytes = estimateMemoryRequestBytes(memory);
  const totalChars = estimateMessageChars(memory.messages);
  const isOverBudget = requestBytes > AI_REQUEST_COMPACT_BYTES;
  const isOverAutoTrigger = memory.messages.length > COMPACT_MESSAGE_TRIGGER || totalChars > COMPACT_CHAR_TRIGGER;

  if (!force && !isOverBudget && !isOverAutoTrigger) {
    return {
      compacted: pruned.changed,
      reason: 'underBudget',
      requestBytes,
      thresholdBytes: AI_REQUEST_COMPACT_BYTES,
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
      thresholdBytes: AI_REQUEST_COMPACT_BYTES,
    };
  }

  const localSummary = summarizeMessages(olderMessages);
  if (!localSummary.trim()) {
    return {
      compacted: pruned.changed,
      reason: 'empty',
      requestBytes,
      thresholdBytes: AI_REQUEST_COMPACT_BYTES,
    };
  }

  runtimeState.taskStatus = 'compressing';
  memory.summary = trimSummaryForStorage(appendSummarySection(memory.summary || '', title, localSummary));
  memory.messages = tailMessages;
  memory.summaryUpdatedAt = Date.now();
  memory.lastCompactedAt = Date.now();
  const aiSummaryPromise = summarizeWithAi(olderMessages, memory, runtimeState);
  if (awaitAiSummary) {
    await aiSummaryPromise;
  } else {
    void aiSummaryPromise;
  }

  return {
    compacted: true,
    reason: 'compacted',
    requestBytes,
    thresholdBytes: AI_REQUEST_COMPACT_BYTES,
  };
};

export const shrinkModelMessagesToBudget = (items: AiChatMessage[], summary: string) => {
  const firstRecentMessageIndex = summary ? 2 : 1;
  while (items.length > 6 && estimateMessageChars(items) > MAX_MODEL_CONTEXT_CHARS) {
    removeOldestModelContextMessage(items, firstRecentMessageIndex);
  }
};
