// WebDAV 恢复流程中与界面无关的部分：阶段文案键、等待后端重启、恢复后提示的持久化。

export type RestoreStage = 'downloading' | 'verifying' | 'snapshot' | 'preparing' | 'restarting' | 'failed';
/** 前端额外的阶段：后端已退出，等待其重新上线 */
export type RestoreUiStage = RestoreStage | 'starting' | 'waitingBackend' | 'reloading';

export interface RestoreJobStatus {
  id: string;
  fileName: string;
  stage: RestoreStage;
  failedStage?: RestoreStage;
  format?: 'full' | 'legacy';
  error?: string;
  message?: string;
  safetyBackup?: string;
}

export const RESTORE_STAGE_I18N: Record<RestoreUiStage, [key: string, fallback: string]> = {
  starting: ['settings.webdavBackup.restoreStage.starting', '正在开始...'],
  downloading: ['settings.webdavBackup.restoreStage.downloading', '下载中...'],
  verifying: ['settings.webdavBackup.restoreStage.verifying', '解密校验中...'],
  snapshot: ['settings.webdavBackup.restoreStage.snapshot', '创建安全快照...'],
  preparing: ['settings.webdavBackup.restoreStage.preparing', '准备替换...'],
  restarting: ['settings.webdavBackup.restoreStage.restarting', '重启中...'],
  waitingBackend: ['settings.webdavBackup.restoreStage.restarting', '重启中...'],
  reloading: ['settings.webdavBackup.restoreStage.reloading', '正在重新加载...'],
  failed: ['settings.webdavBackup.restoreStage.failed', '失败'],
};

export interface WaitForBackendOptions {
  /** 返回当前后端的 bootId；后端不可用时抛出或返回 null */
  getBootId: () => Promise<string | null>;
  /** 恢复前的 bootId；为空时只要求“先下线再上线” */
  previousBootId: string | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
  timeoutMs?: number;
  signal?: { aborted: boolean };
}

/**
 * 轮询直到后端以新的进程重新上线 (bootId 改变)。超时返回 false。
 * 不依赖于“恰好观察到下线”，因此快速重启也不会被漏掉。
 */
export async function waitForBackendRestart(options: WaitForBackendOptions): Promise<boolean> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const interval = options.intervalMs ?? 1000;
  const deadline = now() + (options.timeoutMs ?? 60_000);
  let sawDown = false;
  while (now() < deadline) {
    if (options.signal?.aborted) return false;
    let bootId: string | null = null;
    try {
      bootId = await options.getBootId();
    } catch {
      bootId = null;
    }
    if (bootId === null) {
      sawDown = true;
    } else if (options.previousBootId ? bootId !== options.previousBootId : sawDown) {
      return true;
    }
    await sleep(interval);
  }
  return false;
}

export const RESTORE_NOTICE_KEY = 'nexus.webdavRestore.pending';

export interface RestoreNotice {
  fileName: string;
  format: 'full' | 'legacy';
  startedAt: string;
  message?: string;
}

export function saveRestoreNotice(storage: Pick<Storage, 'setItem'>, notice: RestoreNotice): void {
  try { storage.setItem(RESTORE_NOTICE_KEY, JSON.stringify(notice)); } catch { /* storage 不可用时忽略 */ }
}

export function takeRestoreNotice(storage: Pick<Storage, 'getItem' | 'removeItem'>): RestoreNotice | null {
  try {
    const raw = storage.getItem(RESTORE_NOTICE_KEY);
    if (!raw) return null;
    storage.removeItem(RESTORE_NOTICE_KEY);
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.fileName === 'string' ? parsed as RestoreNotice : null;
  } catch {
    return null;
  }
}
