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
    ...(typeof message.reasoning === 'string' && message.reasoning
      ? { reasoning: message.reasoning.slice(0, MAX_SAVED_CONTENT_LENGTH) }
      : {}),
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
  ...(memory.usageTotals && typeof memory.usageTotals === 'object' ? { usageTotals: memory.usageTotals } : {}),
  ...(memory.connectionId ? { connectionId: String(memory.connectionId) } : {}),
  ...(memory.updatedAt ? { updatedAt: memory.updatedAt } : {}),
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
    return memoryLastActivity(right) - memoryLastActivity(left);
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

// ---------------------------------------------------------------------------
// Memory keys
//
// Session IDs are random per page load, so AI memories are keyed by the
// connection instead: `conn:<connectionId>` for the first open tab of a
// connection and `conn:<connectionId>#<n>` for additional tabs of the same
// connection that are open at the same time. Keys from older versions were the
// raw session ID; those are "orphans" that get adopted by the next session of
// the matching connection, or pruned.
// ---------------------------------------------------------------------------

export const CONNECTION_MEMORY_PREFIX = 'conn:';
export const GLOBAL_MEMORY_KEY = 'global';
export const MAX_ORPHAN_MEMORIES = 5;
export const MAX_ORPHAN_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const connectionMemoryKey = (connectionId: string, slot = 0) => (
  slot > 0 ? `${CONNECTION_MEMORY_PREFIX}${connectionId}#${slot + 1}` : `${CONNECTION_MEMORY_PREFIX}${connectionId}`
);

export const isConnectionMemoryKey = (key: string) => key.startsWith(CONNECTION_MEMORY_PREFIX);

export const isOrphanMemoryKey = (key: string) => key !== GLOBAL_MEMORY_KEY && !isConnectionMemoryKey(key);

export const isMemoryEmpty = (memory?: AiSessionMemory) => !memory || (
  (memory.messages?.length || 0) === 0 && (memory.toolRuns?.length || 0) === 0 && !memory.summary
);

export const memoryLastActivity = (memory?: AiSessionMemory) => {
  if (!memory) return 0;
  let latest = Math.max(memory.updatedAt || 0, memory.summaryUpdatedAt || 0, memory.lastCompactedAt || 0, memory.compression?.at || 0);
  for (const run of memory.toolRuns || []) {
    latest = Math.max(latest, Number(run.finishedAt) || 0, Number(run.startedAt) || 0);
  }
  return latest;
};

/** Old memories carry no connection ID; terminal tool results recorded the connection name. */
export const inferMemoryConnectionName = (memory: AiSessionMemory): string => {
  const runs = memory.toolRuns || [];
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const result = runs[index]?.result as { connectionName?: unknown } | undefined;
    if (result && typeof result === 'object' && typeof result.connectionName === 'string' && result.connectionName.trim()) {
      return result.connectionName.trim();
    }
  }
  return '';
};

/**
 * Picks the most recent orphan memory that belongs to the given connection.
 * `connectionName` is only used for legacy memories without a stored
 * connectionId, and only when the caller knows the name is unambiguous.
 */
export const findOrphanMemoryKey = (
  memories: Record<string, AiSessionMemory>,
  target: { connectionId: string; connectionName?: string },
): string | null => {
  let bestKey: string | null = null;
  let bestActivity = -1;
  for (const [key, memory] of Object.entries(memories)) {
    if (!isOrphanMemoryKey(key) || isMemoryEmpty(memory)) continue;
    const matches = memory.connectionId
      ? String(memory.connectionId) === String(target.connectionId)
      : !!target.connectionName && inferMemoryConnectionName(memory) === target.connectionName;
    if (!matches) continue;
    const activity = memoryLastActivity(memory);
    if (activity > bestActivity) {
      bestActivity = activity;
      bestKey = key;
    }
  }
  return bestKey;
};

/**
 * Removes orphan memories that can never be shown again: empty ones, ones
 * older than MAX_ORPHAN_AGE_MS, and all but the MAX_ORPHAN_MEMORIES most
 * recent. Returns the removed keys. Mutates `memories`.
 */
export const pruneOrphanMemories = (
  memories: Record<string, AiSessionMemory>,
  options: { keep?: Set<string>; now?: number; maxAgeMs?: number; maxOrphans?: number } = {},
) => {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? MAX_ORPHAN_AGE_MS;
  const maxOrphans = options.maxOrphans ?? MAX_ORPHAN_MEMORIES;
  const removed: string[] = [];
  const survivors: Array<[string, number]> = [];
  for (const [key, memory] of Object.entries(memories)) {
    if (!isOrphanMemoryKey(key) || options.keep?.has(key)) continue;
    const activity = memoryLastActivity(memory);
    if (isMemoryEmpty(memory) || (activity > 0 && now - activity > maxAgeMs)) {
      delete memories[key];
      removed.push(key);
      continue;
    }
    survivors.push([key, activity]);
  }
  survivors.sort((left, right) => right[1] - left[1]);
  for (const [key] of survivors.slice(maxOrphans)) {
    delete memories[key];
    removed.push(key);
  }
  return removed;
};
