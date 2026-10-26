/**
 * WebDAV 恢复任务：POST 立即返回 jobId，前端轮询阶段。
 *
 * 阶段：downloading 下载中 → verifying 解密校验 → snapshot 创建安全快照
 *      → preparing 准备替换 → restarting 重启中。
 * 完整备份在 verifying 阶段就会因密码错误而失败，此时不会产生安全快照。
 * 数据替换发生在下次启动时 (见 pending-restore.ts)，本进程以 RESTORE_RESTART_EXIT_CODE 退出，
 * 由 Electron 主进程 / Docker restart 策略 / 进程管理器拉起。
 */
import crypto from 'crypto';
import { closeDbInstance } from '../database/connection';
import { getBackendDataPath } from '../utils/paths';
import { isFullBackupBuffer, MIN_BACKUP_PASSPHRASE_LENGTH } from './backup-archive';
import { discardRestoreStaging, writePendingRestoreMarker } from './pending-restore';
import {
  applyLegacyBackup,
  createBackup,
  downloadBackup,
  parseLegacyBackup,
  stageFullBackup,
} from './webdav-backup.service';

/** EX_TEMPFAIL：非 0，确保 on-failure 类的重启策略也会拉起服务 */
export const RESTORE_RESTART_EXIT_CODE = 75;
const RESTART_DELAY_MS = 1500;

export type RestoreStage = 'downloading' | 'verifying' | 'snapshot' | 'preparing' | 'restarting' | 'failed';

export interface RestoreJob {
  id: string;
  fileName: string;
  stage: RestoreStage;
  /** 失败前所处的阶段 */
  failedStage?: RestoreStage;
  format?: 'full' | 'legacy';
  error?: string;
  message?: string;
  safetyBackup?: string;
  fileCount?: number;
  startedAt: string;
  updatedAt: string;
}

export interface RestoreJobDeps {
  downloadBackup: typeof downloadBackup;
  createBackup: typeof createBackup;
  stageFullBackup: typeof stageFullBackup;
  parseLegacyBackup: typeof parseLegacyBackup;
  applyLegacyBackup: typeof applyLegacyBackup;
  writePendingRestoreMarker: typeof writePendingRestoreMarker;
  discardRestoreStaging: typeof discardRestoreStaging;
  restartProcess: () => void;
}

const defaultDeps: RestoreJobDeps = {
  downloadBackup,
  createBackup,
  stageFullBackup,
  parseLegacyBackup,
  applyLegacyBackup,
  writePendingRestoreMarker,
  discardRestoreStaging,
  restartProcess: () => {
    setTimeout(() => {
      console.warn(`[WebDAV Restore] 进程退出 (code ${RESTORE_RESTART_EXIT_CODE}) 以加载恢复的数据，等待自动重启...`);
      closeDbInstance()
        .catch(() => undefined)
        .finally(() => process.exit(RESTORE_RESTART_EXIT_CODE));
    }, RESTART_DELAY_MS);
  },
};

let currentJob: RestoreJob | null = null;

function update(job: RestoreJob, patch: Partial<RestoreJob>): void {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
}

export function getRestoreJob(id?: string): RestoreJob | null {
  if (!currentJob) return null;
  if (id && currentJob.id !== id) return null;
  return { ...currentJob };
}

export function isRestoreRunning(): boolean {
  return !!currentJob && currentJob.stage !== 'failed';
}

/** 仅供测试使用 */
export function resetRestoreJobForTests(): void {
  currentJob = null;
}

async function runJob(job: RestoreJob, passphrase: string | undefined, proxyId: number | null | undefined, deps: RestoreJobDeps): Promise<void> {
  const dataPath = getBackendDataPath();
  try {
    update(job, { stage: 'downloading' });
    const buffer = await deps.downloadBackup(job.fileName, proxyId);

    update(job, { stage: 'verifying' });
    if (isFullBackupBuffer(buffer)) {
      update(job, { format: 'full' });
      const staged = deps.stageFullBackup(buffer, passphrase);
      update(job, { fileCount: staged.fileCount, stage: 'snapshot' });
      const safety = await deps.createBackup(passphrase as string, proxyId);
      update(job, { safetyBackup: safety.fileName, stage: 'preparing' });
      deps.writePendingRestoreMarker(dataPath, { createdAt: new Date().toISOString(), sourceFile: job.fileName, fileCount: staged.fileCount, safetyBackup: safety.fileName });
      update(job, {
        stage: 'restarting',
        message: `已准备好恢复 ${job.fileName}（${staged.fileCount} 个文件），恢复前的安全快照为 ${safety.fileName}。服务正在重启以替换数据。`,
      });
    } else {
      update(job, { format: 'legacy' });
      const parsed = deps.parseLegacyBackup(buffer);
      if (passphrase && passphrase.length >= MIN_BACKUP_PASSPHRASE_LENGTH) {
        update(job, { stage: 'snapshot' });
        const safety = await deps.createBackup(passphrase, proxyId);
        update(job, { safetyBackup: safety.fileName });
      }
      update(job, { stage: 'preparing' });
      await deps.applyLegacyBackup(parsed);
      update(job, {
        stage: 'restarting',
        message: `已从 ${job.fileName} 恢复 ${parsed.restoreTables.length} 个表的数据。旧版备份未包含完整 data 目录。服务正在重启。`,
      });
    }
    console.log(`[WebDAV Restore] ${job.message}`);
    deps.restartProcess();
  } catch (error: any) {
    console.error(`[WebDAV Restore] 恢复 ${job.fileName} 失败（阶段 ${job.stage}）:`, error);
    try { deps.discardRestoreStaging(dataPath); } catch { /* ignore */ }
    update(job, { failedStage: job.stage, stage: 'failed', error: error?.message || '恢复失败' });
  }
}

export function startRestoreJob(
  fileName: string,
  passphrase: string | undefined,
  proxyId: number | null | undefined,
  deps: RestoreJobDeps = defaultDeps,
): { job: RestoreJob; done: Promise<void> } {
  if (isRestoreRunning()) {
    throw Object.assign(new Error('已有恢复任务正在进行。'), { status: 409 });
  }
  const now = new Date().toISOString();
  const job: RestoreJob = { id: crypto.randomUUID(), fileName, stage: 'downloading', startedAt: now, updatedAt: now };
  currentJob = job;
  const done = runJob(job, passphrase, proxyId, deps);
  return { job: { ...job }, done };
}
