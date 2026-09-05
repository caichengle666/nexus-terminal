import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import apiClient from '../utils/apiClient';
import type { UploadItem } from '../types/upload.types';
import { useUiNotificationsStore, type TaskNotificationStatus } from './uiNotifications.store';

export interface LocalTransferTask {
  id: string;
  kind: 'local-upload';
  filename: string;
  remotePath: string;
  status: 'pending' | 'uploading' | 'paused' | 'success' | 'error' | 'cancelled';
  progress: number;
  totalBytes: number;
  transferredBytes: number;
  error?: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  cancel?: () => void;
}

export interface TransferSubTask {
  subTaskId: string;
  connectionId: number;
  sourceItemName: string;
  status: 'queued' | 'connecting' | 'transferring' | 'completed' | 'failed' | 'cancelling' | 'cancelled';
  progress?: number;
  message?: string;
  transferMethodUsed?: 'sftp-relay';
  transferredBytes?: number;
  totalBytes?: number;
  speedBytesPerSecond?: number;
  currentPath?: string;
  filesCompleted?: number;
  totalFiles?: number;
}

export interface ServerTransferTask {
  kind?: 'server-transfer';
  taskId: string;
  status: 'queued' | 'in-progress' | 'completed' | 'failed' | 'partially-completed' | 'cancelling' | 'cancelled';
  createdAt: string | Date;
  updatedAt: string | Date;
  subTasks: TransferSubTask[];
  overallProgress?: number;
  sourceConnectionId?: number;
  remoteTargetPath?: string;
}

const isServerTransferTask = (value: unknown): value is ServerTransferTask => {
  if (!value || typeof value !== 'object') return false;
  const task = value as Partial<ServerTransferTask>;
  return typeof task.taskId === 'string' && typeof task.status === 'string';
};

export const useTransferStore = defineStore('transfer', () => {
  const localTasks = ref<Record<string, LocalTransferTask>>({});
  const serverTasks = ref<ServerTransferTask[]>([]);
  const serverTaskLoading = ref(false);
  const serverTaskError = ref<string | null>(null);
  let serverPollingTimer: number | null = null;
  let serverFetchInFlight = false;
  const uiNotificationsStore = useUiNotificationsStore();

  const localTaskList = computed(() => Object.values(localTasks.value));
  const serverTaskList = computed(() => serverTasks.value);

  const upsertLocalUpload = (upload: UploadItem, sessionId: string, cancel?: () => void) => {
    const now = new Date().toISOString();
    const existing = localTasks.value[upload.id];
    localTasks.value[upload.id] = {
      id: upload.id,
      kind: 'local-upload',
      filename: upload.filename,
      remotePath: upload.remotePath,
      status: upload.status,
      progress: upload.progress,
      totalBytes: upload.file.size,
      transferredBytes: upload.acknowledgedBytes ?? 0,
      error: upload.error,
      sessionId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      cancel: cancel ?? existing?.cancel,
    };
    const status = upload.status === 'success'
      ? 'success'
      : upload.status === 'error'
        ? 'error'
        : upload.status === 'cancelled'
          ? 'cancelled'
          : 'running';
    uiNotificationsStore.upsertTaskNotification({
      id: `local-upload:${upload.id}`,
      kind: 'transfer',
      title: '文件上传',
      message: `${upload.filename} · ${upload.progress}%`,
      status,
      progress: upload.progress,
    });
  };

  const removeLocalUpload = (uploadId: string) => {
    delete localTasks.value[uploadId];
  };

  const getServerTaskNotification = (task: ServerTransferTask) => {
    const status: TaskNotificationStatus = task.status === 'completed'
      ? 'success'
      : task.status === 'cancelled'
        ? 'cancelled'
        : task.status === 'failed' || task.status === 'partially-completed'
          ? 'error'
          : 'running';
    const firstSubTask = task.subTasks[0];
    const detail = firstSubTask?.sourceItemName || task.remoteTargetPath || task.taskId;
    return {
      id: `server-transfer:${task.taskId}`,
      kind: 'transfer' as const,
      title: '服务器间文件传输',
      message: `${detail} · ${task.overallProgress ?? 0}%`,
      status,
      progress: task.overallProgress,
      retry: status === 'error' ? () => retryServerTask(task.taskId) : undefined,
    };
  };

  const syncServerTaskNotification = (task: ServerTransferTask) => {
    uiNotificationsStore.upsertTaskNotification(getServerTaskNotification(task));
  };

  const fetchServerTasks = async () => {
    if (serverFetchInFlight) return;
    serverFetchInFlight = true;
    try {
      const response = await apiClient.get<unknown>('/transfers/status');
      const payload = response.data as { data?: unknown } | unknown;
      const rawTasks = Array.isArray(payload)
        ? payload
        : (payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
          ? (payload as { data: unknown[] }).data
          : []);
      serverTasks.value = rawTasks.filter(isServerTransferTask).map(task => {
        const subTasks = Array.isArray(task.subTasks) ? task.subTasks : [];
        const allCancelled = subTasks.length > 0 && subTasks.every(subTask => subTask.status === 'cancelled');
        const status = task.status === 'cancelling' && (subTasks.length === 0 || allCancelled)
          ? 'cancelled'
          : task.status;
        return { ...task, status, subTasks };
      });
      serverTasks.value.forEach(syncServerTaskNotification);
      serverTaskError.value = null;
    } catch (error: any) {
      serverTaskError.value = error.response?.data?.message || error.message || '加载服务器传输任务失败。';
    } finally {
      serverFetchInFlight = false;
      serverTaskLoading.value = false;
    }
  };

  const startServerPolling = () => {
    if (serverPollingTimer !== null) return;
    serverTaskLoading.value = true;
    void fetchServerTasks();
    serverPollingTimer = window.setInterval(() => {
      void fetchServerTasks();
    }, 1500);
  };

  const stopServerPolling = () => {
    if (serverPollingTimer === null) return;
    window.clearInterval(serverPollingTimer);
    serverPollingTimer = null;
  };

  const cancelServerTask = async (taskId: string) => {
    await apiClient.post(`/transfers/cancel/${taskId}`);
    await fetchServerTasks();
  };

  const retryServerTask = async (taskId: string) => {
    await apiClient.post(`/transfers/retry/${taskId}`);
    await fetchServerTasks();
  };

  return {
    localTaskList,
    serverTaskList,
    serverTaskLoading,
    serverTaskError,
    upsertLocalUpload,
    removeLocalUpload,
    fetchServerTasks,
    startServerPolling,
    stopServerPolling,
    cancelServerTask,
    retryServerTask,
  };
});
