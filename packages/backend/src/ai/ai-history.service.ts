import fs from 'fs';
import path from 'path';
import { settingsRepository } from '../settings/settings.repository';
import { resolveBackendDataPath } from '../utils/paths';

const AI_HISTORY_CONFIG_KEY = 'aiSessionHistoryConfig';
const DEFAULT_MAX_STORAGE_MB = 500;
const DEFAULT_MAX_SESSION_MB = 20;

export interface AiHistoryConfig {
  enabled: boolean;
  storagePath: string;
  maxStorageMb: number;
  maxSessionMb: number;
  writeMarkdown: boolean;
}

type AiHistorySession = {
  format?: unknown;
  version?: unknown;
  exportedAt?: unknown;
  sessionId?: unknown;
  connectionName?: unknown;
  connection?: {
    name?: unknown;
    host?: unknown;
    port?: unknown;
  };
  memory?: {
    messages?: unknown[];
    toolRuns?: unknown[];
    summary?: unknown;
  };
};

const defaultConfig = (): AiHistoryConfig => ({
  enabled: true,
  storagePath: '',
  maxStorageMb: DEFAULT_MAX_STORAGE_MB,
  maxSessionMb: DEFAULT_MAX_SESSION_MB,
  writeMarkdown: true,
});

const clampInteger = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
};

const normalizeConfig = (value: Partial<AiHistoryConfig> | undefined): AiHistoryConfig => {
  const storagePath = typeof value?.storagePath === 'string' ? value.storagePath.trim() : '';
  if (storagePath && !path.isAbsolute(storagePath)) {
    throw new Error('AI 会话存储目录必须使用绝对路径。');
  }
  const maxStorageMb = clampInteger(value?.maxStorageMb, DEFAULT_MAX_STORAGE_MB, 50, 4096);
  const maxSessionMb = clampInteger(value?.maxSessionMb, DEFAULT_MAX_SESSION_MB, 1, Math.min(512, maxStorageMb));
  return {
    enabled: value?.enabled !== false,
    storagePath,
    maxStorageMb,
    maxSessionMb,
    writeMarkdown: value?.writeMarkdown !== false,
  };
};

const getEffectiveStoragePath = (config: AiHistoryConfig) => config.storagePath || resolveBackendDataPath('ai-sessions');

const readConfig = async (): Promise<AiHistoryConfig> => {
  const raw = await settingsRepository.getSetting(AI_HISTORY_CONFIG_KEY);
  if (!raw) return defaultConfig();
  try {
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return defaultConfig();
  }
};

const toPublicConfig = (config: AiHistoryConfig) => ({
  ...config,
  effectiveStoragePath: getEffectiveStoragePath(config),
});

const safePathSegment = (value: unknown, fallback: string) => {
  const normalized = String(value || '')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 80);
  return normalized || fallback;
};

const validateSession = (value: unknown): AiHistorySession => {
  if (!value || typeof value !== 'object') throw new Error('AI 会话记录格式无效。');
  const session = value as AiHistorySession;
  if (session.format !== 'nexus-terminal-ai-session' || session.version !== 3 || !session.connection || !session.memory) {
    throw new Error('AI 会话记录缺少必要字段。');
  }
  if (typeof session.sessionId !== 'string' || !session.sessionId.trim()) throw new Error('AI 会话记录缺少会话 ID。');
  if (typeof session.connection.host !== 'string' || !session.connection.host.trim() || !session.connection.port) {
    throw new Error('AI 会话记录缺少终端地址或端口。');
  }
  if (!Array.isArray(session.memory.messages) || !Array.isArray(session.memory.toolRuns)) {
    throw new Error('AI 会话记录缺少消息或工具记录。');
  }
  return session;
};

const getSessionDirectory = (config: AiHistoryConfig, session: AiHistorySession, connectionId?: unknown) => {
  const connection = session.connection!;
  const folderName = [
    `connection-${safePathSegment(connectionId, 'unknown')}`,
    safePathSegment(connection.name || session.connectionName, 'unnamed'),
    safePathSegment(connection.host, 'host'),
    safePathSegment(connection.port, 'port'),
  ].join('_');
  return path.join(getEffectiveStoragePath(config), folderName);
};

const truncateForMarkdown = (value: unknown, maxLength = 6000) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n\n...<内容已截断，完整结构化记录请查看 JSON 文件>`;
};

const buildMarkdown = (session: AiHistorySession) => {
  const memory = session.memory!;
  const messageSections = (memory.messages || []).map((message: any) => {
    const role = message?.role === 'user' ? '用户' : message?.role === 'assistant' ? 'Nexus AI' : message?.role === 'tool' ? '工具结果' : '系统';
    const content = message?.content || (message?.tool_calls ? JSON.stringify(message.tool_calls, null, 2) : '');
    return `### ${role}\n\n${truncateForMarkdown(content)}`;
  });
  const toolSections = (memory.toolRuns || []).map((run: any) => [
    `### ${run?.name || 'unknown'} · ${run?.status || 'unknown'}`,
    `开始时间：${run?.startedAt ? new Date(run.startedAt).toLocaleString() : '未知'}`,
    `参数：\n\n\`\`\`json\n${truncateForMarkdown(run?.args, 3000)}\n\`\`\``,
    `结果：\n\n\`\`\`\n${truncateForMarkdown(run?.result ?? run?.error ?? '', 6000)}\n\`\`\``,
  ].join('\n\n'));

  return [
    '# Nexus Terminal AI 会话记录',
    `- 导出时间：${String(session.exportedAt || new Date().toISOString())}`,
    `- 终端名称：${String(session.connectionName || session.connection?.name || '未命名终端')}`,
    `- 目标：${String(session.connection?.host)}:${String(session.connection?.port)}`,
    `- 会话 ID：${String(session.sessionId)}`,
    '## 记忆摘要',
    String(memory.summary || '暂无摘要'),
    '## 对话记录',
    messageSections.join('\n\n') || '暂无对话记录。',
    '## 工具调用记录',
    toolSections.join('\n\n') || '暂无工具调用记录。',
  ].join('\n\n');
};

const writeAtomically = (filePath: string, content: string) => {
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, content, 'utf8');
  fs.renameSync(temporaryPath, filePath);
};

type HistoryRecord = { jsonPath: string; markdownPath: string; modifiedAt: number; size: number };

const listHistoryRecords = (rootPath: string): HistoryRecord[] => {
  if (!fs.existsSync(rootPath)) return [];
  const records: HistoryRecord[] = [];
  for (const directory of fs.readdirSync(rootPath, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const directoryPath = path.join(rootPath, directory.name);
    for (const file of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.startsWith('session-') || !file.name.endsWith('.json')) continue;
      const jsonPath = path.join(directoryPath, file.name);
      const markdownPath = jsonPath.replace(/\.json$/, '.md');
      const jsonStats = fs.statSync(jsonPath);
      const markdownSize = fs.existsSync(markdownPath) ? fs.statSync(markdownPath).size : 0;
      records.push({ jsonPath, markdownPath, modifiedAt: jsonStats.mtimeMs, size: jsonStats.size + markdownSize });
    }
  }
  return records;
};

const pruneHistoryStorage = (rootPath: string, maxStorageBytes: number, currentJsonPath: string) => {
  let totalBytes = 0;
  let removedSessionCount = 0;
  const records = listHistoryRecords(rootPath).sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const record of records) {
    if (record.jsonPath === currentJsonPath || totalBytes + record.size <= maxStorageBytes) {
      totalBytes += record.size;
      continue;
    }
    fs.rmSync(record.jsonPath, { force: true });
    fs.rmSync(record.markdownPath, { force: true });
    removedSessionCount += 1;
  }
  return { removedSessionCount, totalBytes };
};

export const getHistoryConfig = async () => toPublicConfig(await readConfig());

export const saveHistoryConfig = async (payload: Partial<AiHistoryConfig>) => {
  const config = normalizeConfig(payload);
  const effectiveStoragePath = getEffectiveStoragePath(config);
  fs.mkdirSync(effectiveStoragePath, { recursive: true });
  await settingsRepository.setSetting(AI_HISTORY_CONFIG_KEY, JSON.stringify(config));
  return toPublicConfig(config);
};

export const saveSessionHistory = async (payload: { session?: unknown; connectionId?: unknown }) => {
  const config = await readConfig();
  if (!config.enabled) return { saved: false, disabled: true };

  const session = validateSession(payload.session);
  const serialized = JSON.stringify(session, null, 2);
  const maxSessionBytes = config.maxSessionMb * 1024 * 1024;
  if (Buffer.byteLength(serialized, 'utf8') > maxSessionBytes) {
    const error = new Error(`AI 会话超过单会话 ${config.maxSessionMb}MB 上限，请先压缩或导出后清理历史。`);
    (error as any).status = 413;
    throw error;
  }

  const directory = getSessionDirectory(config, session, payload.connectionId);
  fs.mkdirSync(directory, { recursive: true });
  const sessionFileName = `session-${safePathSegment(session.sessionId, 'unknown')}`;
  const jsonPath = path.join(directory, `${sessionFileName}.json`);
  const markdownPath = path.join(directory, `${sessionFileName}.md`);
  writeAtomically(jsonPath, serialized);
  if (config.writeMarkdown) {
    writeAtomically(markdownPath, buildMarkdown(session));
  } else {
    fs.rmSync(markdownPath, { force: true });
  }

  const pruned = pruneHistoryStorage(getEffectiveStoragePath(config), config.maxStorageMb * 1024 * 1024, jsonPath);
  return { saved: true, directory, jsonPath, removedSessionCount: pruned.removedSessionCount };
};

export const getHistoryDirectory = async (payload: { session?: unknown; connectionId?: unknown }) => {
  const config = await readConfig();
  const session = validateSession(payload.session);
  const directory = getSessionDirectory(config, session, payload.connectionId);
  fs.mkdirSync(directory, { recursive: true });
  return { directory };
};
