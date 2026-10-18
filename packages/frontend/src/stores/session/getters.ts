// packages/frontend/src/stores/session/getters.ts

import { computed } from 'vue';
import { sessions, activeSessionId, sessionOrder } from './state';
import type { SessionState, SessionTabInfoWithStatus } from './types';

export const sessionTabs = computed(() => {
  return Array.from(sessions.value.values()).map(session => ({
    sessionId: session.sessionId,
    connectionName: session.connectionName,
  }));
});

// 包含状态的标签页信息（按用户拖拽顺序；未在顺序中的按创建时间排在后面）
export const sessionTabsWithStatus = computed((): SessionTabInfoWithStatus[] => {
  const order = sessionOrder.value;
  return Array.from(sessions.value.values())
    .sort((a, b) => {
      const indexA = order.indexOf(a.sessionId);
      const indexB = order.indexOf(b.sessionId);
      if (indexA === -1 && indexB === -1) return a.createdAt - b.createdAt;
      if (indexA === -1) return 1;
      if (indexB === -1) return -1;
      return indexA - indexB;
    })
    .map(session => ({
      sessionId: session.sessionId,
      connectionName: session.connectionName,
      status: session.wsManager.connectionStatus.value, // 从 wsManager 获取状态
      isMarkedForSuspend: session.isMarkedForSuspend,
    }));
});

export const activeSession = computed((): SessionState | null => {
  if (!activeSessionId.value) return null;
  return sessions.value.get(activeSessionId.value) || null;
});