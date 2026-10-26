/**
 * 重启时生效的完整恢复 (pending restore)。
 *
 * 为什么不在运行中直接替换 data 目录：
 *  - Windows 上 data 目录里有打开的句柄 (SQLite / WAL、会话文件、日志、杀毒软件扫描)，
 *    rename 目录会 EPERM / EBUSY；
 *  - 便携版 data 在 D:，%TEMP% 在 C:，跨卷 rename 会 EXDEV；
 *  - Docker 中 /app/data 是挂载点，挂载点本身不能被 rename。
 *
 * 做法：恢复时把备份解压到 data 目录内的保留目录 `.nexus-restore/staging/data`
 * (与 data 同卷)，写入标记文件后退出进程；下次启动时、在加载 data/.env 和打开数据库之前，
 * 逐个“顶层条目”替换：旧条目移入 `.nexus-restore/pre-restore-<ts>/`，新条目移入 data。
 * 任一步失败即回滚；中途崩溃的半成品在下次启动时自动回滚。
 *
 * 本模块只依赖 fs / path，必须能在 index.ts 最早期调用。
 */
import fs from 'fs';
import path from 'path';

export const RESTORE_RESERVED_DIR = '.nexus-restore';
const MARKER_FILE = 'pending.json';
const RESULT_FILE = 'last-result.json';
const STAGING_DIR = 'staging';
const PRE_RESTORE_PREFIX = 'pre-restore-';
const KEEP_PRE_RESTORE_COPIES = 2;
const MARKER_VERSION = 1;

export interface PendingRestoreMarker {
  version: number;
  createdAt: string;
  sourceFile: string;
  fileCount?: number;
  safetyBackup?: string;
  /** 由 applyPendingRestore 写入替换进度 (用于崩溃后回滚) */
  phase?: 'staged' | RestorePhase;
  preRestoreDir?: string;
}

type RestorePhase = 'moving-old' | 'installing';

export interface RestoreApplyResult {
  status: 'applied' | 'rolled-back' | 'failed';
  sourceFile: string;
  at: string;
  message: string;
  preRestoreDir?: string;
  safetyBackup?: string;
}

export interface FsOps {
  renameSync: typeof fs.renameSync;
  cpSync: typeof fs.cpSync;
  rmSync: typeof fs.rmSync;
}

const defaultFsOps: FsOps = {
  renameSync: (...args) => fs.renameSync(...args),
  cpSync: (...args) => fs.cpSync(...args),
  rmSync: (...args) => fs.rmSync(...args),
};

type Logger = Pick<Console, 'log' | 'warn' | 'error'>;

export function getRestoreRoot(dataPath: string): string {
  return path.join(dataPath, RESTORE_RESERVED_DIR);
}

export function getRestoreStagingRoot(dataPath: string): string {
  return path.join(getRestoreRoot(dataPath), STAGING_DIR);
}

function markerPath(dataPath: string): string {
  return path.join(getRestoreRoot(dataPath), MARKER_FILE);
}

function resultPath(dataPath: string): string {
  return path.join(getRestoreRoot(dataPath), RESULT_FILE);
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, filePath);
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

/**
 * 移动一个文件/目录：先 rename (Windows 上对 EPERM/EBUSY 短暂重试，常见于杀毒扫描)，
 * 跨卷 (EXDEV) 或 rename 始终失败时退化为“递归复制 + 删除源”。
 */
export function moveEntry(source: string, destination: string, ops: FsOps = defaultFsOps): void {
  let lastError: NodeJS.ErrnoException | null = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      ops.renameSync(source, destination);
      return;
    } catch (error) {
      lastError = error as NodeJS.ErrnoException;
      if (lastError.code === 'EXDEV' || !RETRYABLE_CODES.has(lastError.code || '')) break;
      sleepSync(100 * (attempt + 1));
    }
  }
  if (lastError && lastError.code !== 'EXDEV' && !RETRYABLE_CODES.has(lastError.code || '')) {
    throw lastError;
  }
  // 复制回退：复制成功后才删除源；复制或删除失败都撤销复制，保持源完整
  try {
    ops.cpSync(source, destination, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
  } catch (copyError) {
    try { ops.rmSync(destination, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
    throw copyError;
  }
  try {
    ops.rmSync(source, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (rmError) {
    // 源可能已被删掉一部分：用完整的副本把源补齐，再撤销副本，保证源仍是完整的
    try {
      ops.cpSync(destination, source, { recursive: true, force: true, preserveTimestamps: true });
      ops.rmSync(destination, { recursive: true, force: true });
    } catch { /* 副本保留在 destination，回滚时会使用 */ }
    throw rmError;
  }
}

/** 恢复任务调用：标记已解压好的 staging 目录，下次启动时生效。 */
export function writePendingRestoreMarker(dataPath: string, marker: Omit<PendingRestoreMarker, 'version' | 'phase'>): void {
  const stagedData = path.join(getRestoreStagingRoot(dataPath), 'data');
  if (!fs.existsSync(stagedData)) throw new Error('恢复暂存目录不存在。');
  writeJsonAtomic(markerPath(dataPath), { ...marker, version: MARKER_VERSION, phase: 'staged' });
}

export function readPendingRestoreMarker(dataPath: string): PendingRestoreMarker | null {
  return readJson<PendingRestoreMarker>(markerPath(dataPath));
}

export function readLastRestoreResult(dataPath: string): RestoreApplyResult | null {
  return readJson<RestoreApplyResult>(resultPath(dataPath));
}

/** 丢弃未完成的暂存 (例如恢复任务在写标记前失败)。 */
export function discardRestoreStaging(dataPath: string): void {
  if (fs.existsSync(markerPath(dataPath))) return; // 已标记的暂存只能由启动流程处理
  fs.rmSync(getRestoreStagingRoot(dataPath), { recursive: true, force: true });
}

function listEntries(dir: string): string[] {
  return fs.readdirSync(dir).filter(name => name !== RESTORE_RESERVED_DIR).sort();
}

function prunePreRestoreCopies(restoreRoot: string, logger: Logger): void {
  const copies = fs.readdirSync(restoreRoot)
    .filter(name => name.startsWith(PRE_RESTORE_PREFIX))
    .sort()
    .reverse();
  for (const stale of copies.slice(KEEP_PRE_RESTORE_COPIES)) {
    try {
      fs.rmSync(path.join(restoreRoot, stale), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (error: any) {
      logger.warn(`[Restore] 清理旧的恢复前副本 ${stale} 失败: ${error?.message}`);
    }
  }
}

/**
 * 回滚到恢复前的数据。
 *  - phase 'moving-old'：data 里只剩尚未移走的旧条目；preDir 里是已移走的旧条目
 *    (若某条目复制回退时中断，源和副本会同时存在，合并回 data)。
 *  - phase 'installing'：旧条目已全部在 preDir；data 里只有已装入(或装入一半)的新条目，全部删除。
 */
function rollback(dataPath: string, preDir: string, phase: RestorePhase, ops: FsOps): void {
  if (phase === 'installing') {
    for (const name of listEntries(dataPath)) {
      ops.rmSync(path.join(dataPath, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
  const oldEntries = fs.existsSync(preDir) ? fs.readdirSync(preDir) : [];
  for (const name of oldEntries) {
    const target = path.join(dataPath, name);
    if (fs.existsSync(target)) {
      // 源和副本同时存在 (复制回退中断)：两者内容同源，把副本合并回源即可补齐任何一边的缺失
      ops.cpSync(path.join(preDir, name), target, { recursive: true, force: true, preserveTimestamps: true });
      ops.rmSync(path.join(preDir, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      continue;
    }
    moveEntry(path.join(preDir, name), target, ops);
  }
  fs.rmSync(preDir, { recursive: true, force: true });
}

function finish(dataPath: string, result: RestoreApplyResult, logger: Logger): RestoreApplyResult {
  try { writeJsonAtomic(resultPath(dataPath), result); } catch (error: any) {
    logger.error(`[Restore] 写入恢复结果失败: ${error?.message}`);
  }
  try { fs.rmSync(markerPath(dataPath), { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(getRestoreStagingRoot(dataPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (error: any) {
    logger.warn(`[Restore] 清理恢复暂存目录失败: ${error?.message}`);
  }
  return result;
}

/**
 * 启动时调用。若存在待生效的恢复则执行替换；返回本次的结果，无待恢复时返回 null。
 * 不抛异常：任何失败都会回滚并记录到 last-result.json，后端继续用旧数据启动。
 */
export function applyPendingRestore(
  dataPath: string,
  options: { logger?: Logger; fsOps?: FsOps; now?: () => Date } = {},
): RestoreApplyResult | null {
  const logger = options.logger ?? console;
  const ops = options.fsOps ?? defaultFsOps;
  const now = options.now ?? (() => new Date());
  const restoreRoot = getRestoreRoot(dataPath);
  if (!fs.existsSync(markerPath(dataPath))) {
    // 没有标记的暂存目录是未完成的恢复任务残留
    if (fs.existsSync(getRestoreStagingRoot(dataPath))) {
      try { fs.rmSync(getRestoreStagingRoot(dataPath), { recursive: true, force: true }); } catch { /* ignore */ }
    }
    return null;
  }

  const marker = readPendingRestoreMarker(dataPath);
  const at = now().toISOString();
  const stagedData = path.join(getRestoreStagingRoot(dataPath), 'data');
  if (!marker || marker.version !== MARKER_VERSION) {
    logger.error('[Restore] 待恢复标记无效，已忽略。');
    return finish(dataPath, { status: 'failed', sourceFile: marker?.sourceFile || '', at, message: '待恢复标记无效，未做任何更改。' }, logger);
  }
  const base = { sourceFile: marker.sourceFile, safetyBackup: marker.safetyBackup };

  if ((marker.phase === 'moving-old' || marker.phase === 'installing') && marker.preRestoreDir) {
    // 上次替换进行到一半进程就退出了：回滚到旧数据，避免新旧混杂
    logger.warn('[Restore] 检测到上次恢复中途中断，正在回滚到恢复前的数据...');
    try {
      rollback(dataPath, path.join(restoreRoot, marker.preRestoreDir), marker.phase, ops);
      return finish(dataPath, { ...base, status: 'rolled-back', at, message: '上次恢复在替换过程中被中断，已回滚到恢复前的数据。' }, logger);
    } catch (error: any) {
      logger.error('[Restore] 回滚中断的恢复失败:', error);
      return finish(dataPath, { ...base, status: 'failed', at, preRestoreDir: marker.preRestoreDir, message: `回滚失败: ${error?.message}。恢复前的数据保存在 ${path.join(restoreRoot, marker.preRestoreDir)}。` }, logger);
    }
  }

  if (!fs.existsSync(stagedData)) {
    logger.error('[Restore] 恢复暂存目录缺失，已放弃本次恢复。');
    return finish(dataPath, { ...base, status: 'failed', at, message: '恢复暂存目录缺失，未做任何更改。' }, logger);
  }

  const preRestoreName = `${PRE_RESTORE_PREFIX}${at.replace(/[:.]/g, '-')}`;
  const preDir = path.join(restoreRoot, preRestoreName);
  const stagedEntries = listEntries(stagedData);
  logger.log(`[Restore] 正在应用恢复 ${marker.sourceFile}（${stagedEntries.length} 个顶层条目）...`);

  let phase: RestorePhase = 'moving-old';
  try {
    fs.mkdirSync(preDir, { recursive: true });
    writeJsonAtomic(markerPath(dataPath), { ...marker, phase, preRestoreDir: preRestoreName });
    for (const name of listEntries(dataPath)) {
      moveEntry(path.join(dataPath, name), path.join(preDir, name), ops);
    }
    phase = 'installing';
    writeJsonAtomic(markerPath(dataPath), { ...marker, phase, preRestoreDir: preRestoreName });
    for (const name of stagedEntries) {
      moveEntry(path.join(stagedData, name), path.join(dataPath, name), ops);
    }
  } catch (error: any) {
    logger.error(`[Restore] 应用恢复失败 (${error?.code || ''} ${error?.message})，正在回滚...`);
    try {
      rollback(dataPath, preDir, phase, ops);
      logger.warn('[Restore] 已回滚到恢复前的数据。');
      return finish(dataPath, { ...base, status: 'rolled-back', at, message: `替换数据失败 (${error?.code || error?.message})，已回滚到恢复前的数据。` }, logger);
    } catch (rollbackError: any) {
      logger.error('[Restore] 回滚失败:', rollbackError);
      return finish(dataPath, { ...base, status: 'failed', at, preRestoreDir: preRestoreName, message: `替换数据失败且回滚失败: ${rollbackError?.message}。恢复前的数据保存在 ${preDir}。` }, logger);
    }
  }

  prunePreRestoreCopies(restoreRoot, logger);
  logger.log(`[Restore] 恢复已生效。恢复前的数据保留在 ${preDir}`);
  return finish(dataPath, { ...base, status: 'applied', at, preRestoreDir: preRestoreName, message: `已从 ${marker.sourceFile} 恢复数据。` }, logger);
}
