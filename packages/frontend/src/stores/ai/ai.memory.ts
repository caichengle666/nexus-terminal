import {
  LEGACY_MESSAGES_KEY,
  LEGACY_TOOL_RUNS_KEY,
  MAX_SAVED_MEMORY_BYTES,
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
    const knownTitle = SUMMARY_SECTION_TITLES.find(item => trimmed === `${item}:`)
      || SUMMARY_SECTION_TITLES.find(item => trimmed === `## ${item}` || trimmed === `## ${item}:`);
    const title = knownTitle || (trimmed.startsWith('## ') ? trimmed.replace(/:$/, '') : '');
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

const splitSummarySections = (summary: string) => cleanSummaryText(summary)
  .split(/\n{2,}/)
  .map(section => section.trim())
  .filter(Boolean);

const sectionKey = (section: string) => section
  .split('\n', 1)[0]
  .replace(/^##\s*/, '')
  .replace(/:$/, '')
  .trim()
  .toLowerCase();

// Keep one canonical section per topic. New information replaces the old
// section while sections not mentioned by the local fallback are preserved.
export const mergeSummarySections = (current: string, incoming: string) => {
  const sections = new Map<string, string>();
  for (const section of [...splitSummarySections(current), ...splitSummarySections(incoming)]) {
    const key = sectionKey(section);
    if (key) sections.set(key, section);
  }
  return [...sections.values()].join('\n\n').trim();
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
  compression: memory.compression,
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

export const persistMemories = (memories: Record<string, AiSessionMemory>, priorityKey?: string) => {
  const normalized = Object.fromEntries(
    Object.entries(memories).map(([key, value]) => [key, normalizeMemoryForStorage(value)]),
  );
  const entries = Object.entries(normalized).reverse().sort(([leftKey, left], [rightKey, right]) => {
    if (leftKey === priorityKey) return -1;
    if (rightKey === priorityKey) return 1;
    return (
    (right.summaryUpdatedAt || right.lastCompactedAt || 0) - (left.summaryUpdatedAt || left.lastCompactedAt || 0)
    );
  });
  const retained: Record<string, AiSessionMemory> = {};
  let droppedSessionCount = 0;
  for (const [key, value] of entries) {
    const candidate = { ...retained, [key]: value };
    if (JSON.stringify(candidate).length * 2 > MAX_SAVED_MEMORY_BYTES && Object.keys(retained).length > 0) {
      droppedSessionCount += 1;
      continue;
    }
    retained[key] = value;
  }

  try {
    localStorage.setItem(MEMORIES_KEY, JSON.stringify(retained));
    return { ok: true, droppedSessionCount };
  } catch (error) {
    console.warn('[AI Terminal] Failed to persist AI memories:', error);
    return { ok: false, droppedSessionCount };
  }
};
