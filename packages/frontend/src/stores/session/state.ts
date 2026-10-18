// packages/frontend/src/stores/session/state.ts

import { ref, shallowRef } from 'vue';
import type { SessionState } from './types';
// 修正导入路径
import type { ConnectionInfo } from '../connections.store'; // 路径: packages/frontend/src/stores/connections.store.ts
import type { SuspendedSshSession } from '../../types/ssh-suspend.types'; // 路径: packages/frontend/src/types/ssh-suspend.types.ts

// 使用 shallowRef 避免深度响应性问题，保留管理器实例内部的响应性
export const sessions = shallowRef<Map<string, SessionState>>(new Map());
export const activeSessionId = ref<string | null>(null);

// --- 标签页顺序 (用户拖拽排序) ---
// 作为响应式状态保存，getter 依赖它；初始化自 localStorage，修改时通过 setSessionOrder 持久化
const SESSION_ORDER_STORAGE_KEY = 'sessionOrder';
const loadSessionOrder = (): string[] => {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(SESSION_ORDER_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch (e) {
    console.error('[SessionState] 解析本地存储的标签顺序失败:', e);
    return [];
  }
};
export const sessionOrder = ref<string[]>(loadSessionOrder());
export const setSessionOrder = (order: string[]) => {
  sessionOrder.value = [...order];
  try {
    localStorage.setItem(SESSION_ORDER_STORAGE_KEY, JSON.stringify(sessionOrder.value));
  } catch (e) {
    console.warn('[SessionState] 保存标签顺序失败:', e);
  }
};

// --- RDP Modal State ---
export const isRdpModalOpen = ref(false);
export const rdpConnectionInfo = ref<ConnectionInfo | null>(null);

// --- VNC Modal State ---
export const isVncModalOpen = ref(false);
export const vncConnectionInfo = ref<ConnectionInfo | null>(null);

// --- SSH Suspend Mode State ---
export const suspendedSshSessions = ref<SuspendedSshSession[]>([]);
export const isLoadingSuspendedSessions = ref<boolean>(false);