import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

export type RdpTransferDirection = 'upload' | 'download';
export type RdpTransferStatus = 'transferring' | 'completed' | 'failed' | 'cancelled';

export interface RdpTransferRecord {
  id: string;
  direction: RdpTransferDirection;
  filename: string;
  connectionName: string;
  status: RdpTransferStatus;
  progress?: number;
  transferredBytes: number;
  totalBytes?: number;
  speedBytesPerSecond?: number;
  message?: string;
  createdAt: string;
  updatedAt: string;
}

const STORAGE_KEY = 'nexus_terminal_rdp_transfer_history';
const MAX_HISTORY = 50;

const loadHistory = (): RdpTransferRecord[] => {
  if (typeof localStorage === 'undefined') return [];
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(value) ? value.slice(0, MAX_HISTORY) : [];
  } catch {
    return [];
  }
};

export const useRdpTransferStore = defineStore('rdpTransfer', () => {
  const records = ref<RdpTransferRecord[]>(loadHistory());
  const activeRecords = computed(() => records.value.filter(record => record.status === 'transferring'));

  const persist = () => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records.value.slice(0, MAX_HISTORY)));
  };

  const updateRecord = (id: string, changes: Partial<RdpTransferRecord>) => {
    const record = records.value.find(item => item.id === id);
    if (!record) return;
    Object.assign(record, changes, { updatedAt: new Date().toISOString() });
    persist();
  };

  const begin = (input: Omit<RdpTransferRecord, 'status' | 'transferredBytes' | 'createdAt' | 'updatedAt'>) => {
    const now = new Date().toISOString();
    const record: RdpTransferRecord = {
      ...input,
      status: 'transferring',
      transferredBytes: 0,
      createdAt: now,
      updatedAt: now,
    };
    records.value.unshift(record);
    records.value = records.value.slice(0, MAX_HISTORY);
    persist();
    return record.id;
  };

  const complete = (id: string) => updateRecord(id, { status: 'completed', progress: 100 });
  const fail = (id: string, message: string) => updateRecord(id, { status: 'failed', message });
  const cancel = (id: string) => updateRecord(id, { status: 'cancelled', message: '传输已取消' });

  return { records, activeRecords, begin, updateRecord, complete, fail, cancel };
});
