import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { UploadItem } from '../types/upload.types';

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

export const useTransferStore = defineStore('transfer', () => {
  const localTasks = ref<Record<string, LocalTransferTask>>({});

  const localTaskList = computed(() => Object.values(localTasks.value));

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
  };

  const removeLocalUpload = (uploadId: string) => {
    delete localTasks.value[uploadId];
  };

  return {
    localTaskList,
    upsertLocalUpload,
    removeLocalUpload,
  };
});
