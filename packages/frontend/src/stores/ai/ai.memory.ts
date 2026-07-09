import {
  LEGACY_MESSAGES_KEY,
  LEGACY_TOOL_RUNS_KEY,
  MAX_SAVED_CONTENT_LENGTH,
  MAX_SAVED_MESSAGES,
  MAX_SAVED_TOOL_RUNS,
  MEMORIES_KEY,
  SUMMARY_SECTION_TITLES,
} from './ai.constants';
import type { AiChatMessage, AiSessionMemory, AiToolRun } from './ai.types';

const cleanSummaryText = (summary: string) => {
  const lines = summary.split('\n');
  const sections: string[] = [];
  let currentTitle = '';
  let currentBody: string[] = [];

  const flush = () => {
    const body = currentBody.join('\n').trim();
    if (currentTitle && body) {
      sections.push(`${currentTitle}:\n${body}`);
    } else if (!currentTitle && body) {
      sections.push(body);
    }
    currentTitle = '';
    currentBody = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '此前摘要:') continue;
    const title = SUMMARY_SECTION_TITLES.find(item => trimmed === `${item}:`);
    if (title) {
      flush();
      currentTitle = title;
      continue;
    }
    currentBody.push(line);
  }
  flush();
  return sections.join('\n\n').trim();
};

export const appendSummarySection = (current: string, title: string, body: string) => {
  const sectionBody = body.trim();
  if (!sectionBody) return current;
  const section = `${title}:\n${sectionBody}`;
  const cleanedCurrent = cleanSummaryText(current);
  return cleanedCurrent ? `${cleanedCurrent}\n\n${section}` : section;
};

export const trimSummaryForStorage = (summary: string) => {
  const cleaned = cleanSummaryText(summary);
  if (cleaned.length <= MAX_SAVED_CONTENT_LENGTH) return cleaned;

  const sections = cleaned.split(/\n{2,}/).filter(Boolean);
  const kept: string[] = [];
  let length = 0;
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    const section = sections[index];
    const nextLength = length + section.length + (kept.length > 0 ? 2 : 0);
    if (nextLength > MAX_SAVED_CONTENT_LENGTH) break;
    kept.unshift(section);
    length = nextLength;
  }
  return kept.length > 0 ? kept.join('\n\n') : cleaned.slice(-MAX_SAVED_CONTENT_LENGTH);
};

const normalizeMessagesForStorage = (items: AiChatMessage[]) => items
  .slice(-MAX_SAVED_MESSAGES)
  .map(message => ({
    ...message,
    content: typeof message.content === 'string'
      ? message.content.slice(0, MAX_SAVED_CONTENT_LENGTH)
      : message.content,
  }));

const normalizeToolRunsForStorage = (items: AiToolRun[]) => items.slice(-MAX_SAVED_TOOL_RUNS);

export const createEmptyMemory = (): AiSessionMemory => ({
  messages: [],
  toolRuns: [],
  summary: '',
});

export const normalizeMemoryForStorage = (memory: AiSessionMemory): AiSessionMemory => ({
  messages: normalizeMessagesForStorage(memory.messages || []),
  toolRuns: normalizeToolRunsForStorage(memory.toolRuns || []),
  summary: typeof memory.summary === 'string' ? trimSummaryForStorage(memory.summary) : '',
  summaryUpdatedAt: memory.summaryUpdatedAt,
  lastCompactedAt: memory.lastCompactedAt,
});

export const loadStoredMemories = () => {
  const memories: Record<string, AiSessionMemory> = {};

  try {
    const raw = localStorage.getItem(MEMORIES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return Object.fromEntries(
          Object.entries(parsed).map(([key, value]) => [key, normalizeMemoryForStorage(value as AiSessionMemory)]),
        );
      }
    }
  } catch (error) {
    console.warn('[AI Terminal] Failed to load memories:', error);
  }

  try {
    const legacyMessages = JSON.parse(localStorage.getItem(LEGACY_MESSAGES_KEY) || '[]');
    const legacyToolRuns = JSON.parse(localStorage.getItem(LEGACY_TOOL_RUNS_KEY) || '[]');
    if (Array.isArray(legacyMessages) || Array.isArray(legacyToolRuns)) {
      memories.global = normalizeMemoryForStorage({
        messages: Array.isArray(legacyMessages) ? legacyMessages : [],
        toolRuns: Array.isArray(legacyToolRuns) ? legacyToolRuns : [],
        summary: '',
      });
      localStorage.removeItem(LEGACY_MESSAGES_KEY);
      localStorage.removeItem(LEGACY_TOOL_RUNS_KEY);
    }
  } catch (error) {
    console.warn('[AI Terminal] Failed to migrate legacy memories:', error);
  }

  return memories;
};

export const persistMemories = (memories: Record<string, AiSessionMemory>) => {
  const normalized = Object.fromEntries(
    Object.entries(memories).map(([key, value]) => [key, normalizeMemoryForStorage(value)]),
  );
  localStorage.setItem(MEMORIES_KEY, JSON.stringify(normalized));
};
