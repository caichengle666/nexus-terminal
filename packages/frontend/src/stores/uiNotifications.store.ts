import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

// 定义通知对象的接口
export interface UINotification {
  id: number;
  type: 'success' | 'error' | 'info' | 'warning';
  message: string;
  timeout?: number; // 可选的自动关闭超时时间 (毫秒)
}

export type TaskNotificationStatus = 'running' | 'success' | 'error' | 'cancelled';

export interface TaskNotification {
  id: string;
  title: string;
  message: string;
  status: TaskNotificationStatus;
  kind?: 'transfer' | 'file-operation' | 'ai' | 'other';
  progress?: number;
  createdAt: number;
  updatedAt: number;
  read: boolean;
  retry?: () => void | Promise<void>;
}

type StoredTaskNotification = Omit<TaskNotification, 'retry'>;

const TASK_NOTIFICATIONS_STORAGE_KEY = 'nexus.taskNotifications';
const DISMISSED_TASK_NOTIFICATIONS_STORAGE_KEY = 'nexus.dismissedTaskNotifications';
let taskAudioContext: AudioContext | null = null;

const isTerminalTaskStatus = (status: TaskNotificationStatus) => status !== 'running';

const playTaskSound = (repeatCount: number) => {
  try {
    const AudioContextConstructor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) return;
    taskAudioContext ??= new AudioContextConstructor();
    const context = taskAudioContext;
    const playChime = () => {
      const startTime = context.currentTime;
      const masterGain = context.createGain();
      masterGain.gain.setValueAtTime(1, startTime);
      masterGain.connect(context.destination);
      [523.25, 659.25, 783.99].forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const toneStart = startTime + index * 0.13;
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequency, toneStart);
        gain.gain.setValueAtTime(0.0001, toneStart);
        gain.gain.exponentialRampToValueAtTime(0.22, toneStart + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, toneStart + 0.18);
        oscillator.connect(gain);
        gain.connect(masterGain);
        oscillator.start(toneStart);
        oscillator.stop(toneStart + 0.2);
      });
      const endTime = startTime + 0.62;
      masterGain.gain.setValueAtTime(1, endTime - 0.08);
      masterGain.gain.exponentialRampToValueAtTime(0.0001, endTime);
      window.setTimeout(() => masterGain.disconnect(), 800);
    };
    const count = Math.max(1, Math.min(3, Math.trunc(repeatCount)));
    if (context.state === 'suspended') {
      void context.resume().then(() => {
        for (let index = 0; index < count; index += 1) {
          window.setTimeout(playChime, index * 800);
        }
      }).catch(() => undefined);
    } else {
      for (let index = 0; index < count; index += 1) {
        window.setTimeout(playChime, index * 800);
      }
    }
  } catch {
    // Audio is optional and must never affect task state updates.
  }
};

const isStoredTaskNotification = (task: unknown): task is StoredTaskNotification => (
  !!task && typeof task === 'object'
  && typeof (task as TaskNotification).id === 'string'
  && typeof (task as TaskNotification).title === 'string'
  && typeof (task as TaskNotification).message === 'string'
  && typeof (task as TaskNotification).status === 'string'
  && typeof (task as TaskNotification).createdAt === 'number'
  && typeof (task as TaskNotification).updatedAt === 'number'
  && typeof (task as TaskNotification).read === 'boolean'
);

const loadTaskNotifications = (): TaskNotification[] => {
  try {
    const stored = JSON.parse(localStorage.getItem(TASK_NOTIFICATIONS_STORAGE_KEY) || '[]');
    if (!Array.isArray(stored)) return [];
    return stored.filter(isStoredTaskNotification).slice(0, 50);
  } catch {
    return [];
  }
};

const loadDismissedTaskNotifications = (): Record<string, StoredTaskNotification> => {
  try {
    const stored = JSON.parse(localStorage.getItem(DISMISSED_TASK_NOTIFICATIONS_STORAGE_KEY) || '{}');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    return Object.fromEntries(
      Object.entries(stored)
        .filter(([, task]) => isStoredTaskNotification(task))
        .slice(-50),
    ) as Record<string, StoredTaskNotification>;
  } catch {
    return {};
  }
};

export const useUiNotificationsStore = defineStore('uiNotifications', () => {
  const notifications = ref<UINotification[]>([]);
  const taskNotifications = ref<TaskNotification[]>(loadTaskNotifications());
  const dismissedTaskNotifications = loadDismissedTaskNotifications();
  let nextId = 0;

  const syncFloatingNotificationBell = (pulse = false) => {
    const unreadCount = taskNotifications.value.filter(task => !task.read).length;
    (window as typeof window & {
      electronAPI?: { updateFloatingNotificationBell?: (payload: { unreadCount: number; pulse: boolean }) => void };
    }).electronAPI?.updateFloatingNotificationBell?.({ unreadCount, pulse });
  };

  const persistTaskNotifications = () => {
    if (typeof localStorage === 'undefined') return;
    const serializableTasks = taskNotifications.value.map(({ retry: _retry, ...task }) => task);
    localStorage.setItem(TASK_NOTIFICATIONS_STORAGE_KEY, JSON.stringify(serializableTasks));
    syncFloatingNotificationBell();
  };

  const persistDismissedTaskNotifications = () => {
    if (typeof localStorage === 'undefined') return;
    const entries = Object.entries(dismissedTaskNotifications).slice(-50);
    localStorage.setItem(DISMISSED_TASK_NOTIFICATIONS_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  };

  /**
   * 添加一个新通知
   * @param notification - 通知对象 (至少包含 type 和 message)
   */
  const addNotification = (notification: Omit<UINotification, 'id'> & { timeout?: number }) => { // Ensure timeout is part of the input type for clarity
    const id = nextId++;
    // Force a 3-second timeout for all notifications
    const newNotification: UINotification = { ...notification, id, timeout: 3000 };
    notifications.value.push(newNotification);

    // Always set timeout to remove the notification after 3 seconds
    setTimeout(() => {
      removeNotification(id);
    }, 3000); // Use fixed 3000ms timeout
  };

  /**
   * 移除一个通知
   * @param id - 要移除的通知的 ID
   */
  const removeNotification = (id: number) => {
    notifications.value = notifications.value.filter(n => n.id !== id);
  };

  // 便捷方法
  const showError = (message: string) => { // Removed options
    addNotification({ type: 'error', message }); // Timeout is handled by addNotification
  };

  const showSuccess = (message: string) => { // Removed options
    addNotification({ type: 'success', message }); // Timeout is handled by addNotification
  };

  const showInfo = (message: string) => { // Removed options
    addNotification({ type: 'info', message }); // Timeout is handled by addNotification
  };

  const showWarning = (message: string) => { // Removed options
    addNotification({ type: 'warning', message }); // Timeout is handled by addNotification
  };

  const addTaskNotification = (task: Omit<TaskNotification, 'id' | 'createdAt' | 'updatedAt' | 'read'> & { id?: string }) => {
    const now = Date.now();
    const entry: TaskNotification = {
      ...task,
      id: task.id ?? `task-${now}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now,
      updatedAt: now,
      read: false,
    };
    delete dismissedTaskNotifications[entry.id];
    taskNotifications.value = [entry, ...taskNotifications.value].slice(0, 50);
    persistTaskNotifications();
    persistDismissedTaskNotifications();
    if (entry.status === 'running') playTaskSound(1);
    else playTaskSound(3);
    return entry.id;
  };

  const updateTaskNotification = (id: string, updates: Partial<Omit<TaskNotification, 'id' | 'createdAt'>>) => {
    const index = taskNotifications.value.findIndex(task => task.id === id);
    if (index === -1) {
      const dismissedTask = dismissedTaskNotifications[id];
      if (!dismissedTask) return;
      const restoredTask = { ...dismissedTask, ...updates, updatedAt: Date.now() };
      if (restoredTask.status === 'running') {
        if (dismissedTask.status === 'running') {
          dismissedTaskNotifications[id] = restoredTask;
          persistDismissedTaskNotifications();
          return;
        }
        delete dismissedTaskNotifications[id];
        addTaskNotification({
          id,
          title: restoredTask.title,
          message: restoredTask.message,
          status: restoredTask.status,
          kind: restoredTask.kind,
          progress: restoredTask.progress,
          retry: updates.retry,
        });
        persistDismissedTaskNotifications();
        return;
      }
      delete dismissedTaskNotifications[id];
      addTaskNotification({
        id,
        title: restoredTask.title,
        message: restoredTask.message,
        status: restoredTask.status,
        kind: restoredTask.kind,
        progress: restoredTask.progress,
        retry: updates.retry,
      });
      syncFloatingNotificationBell(true);
      persistDismissedTaskNotifications();
      return;
    }
    const previousStatus = taskNotifications.value[index].status;
    taskNotifications.value[index] = {
      ...taskNotifications.value[index],
      ...updates,
      updatedAt: Date.now(),
    };
    persistTaskNotifications();
    if (previousStatus === 'running' && updates.status && isTerminalTaskStatus(updates.status)) {
      playTaskSound(3);
      syncFloatingNotificationBell(true);
    }
  };

  const upsertTaskNotification = (task: Omit<TaskNotification, 'createdAt' | 'updatedAt' | 'read'>) => {
    const dismissedTask = dismissedTaskNotifications[task.id];
    if (dismissedTask) {
      if (task.status === 'running') {
        if (dismissedTask.status === 'running') {
          dismissedTaskNotifications[task.id] = { ...dismissedTask, ...task, updatedAt: Date.now() };
          persistDismissedTaskNotifications();
          return task.id;
        }
        delete dismissedTaskNotifications[task.id];
        persistDismissedTaskNotifications();
      } else if (dismissedTask.status !== 'running') {
        return task.id;
      } else {
        delete dismissedTaskNotifications[task.id];
        const restoredId = addTaskNotification(task);
        syncFloatingNotificationBell(true);
        persistDismissedTaskNotifications();
        return restoredId;
      }
    }
    const existing = taskNotifications.value.find(item => item.id === task.id);
    if (existing) {
      updateTaskNotification(task.id, task);
      return task.id;
    }
    return addTaskNotification(task);
  };

  const markTaskNotificationsRead = () => {
    taskNotifications.value = taskNotifications.value.map(task => ({ ...task, read: true }));
    persistTaskNotifications();
  };

  const clearTaskNotifications = () => {
    taskNotifications.value.forEach(({ retry: _retry, ...task }) => {
      dismissedTaskNotifications[task.id] = task;
    });
    taskNotifications.value = [];
    persistTaskNotifications();
    persistDismissedTaskNotifications();
  };

  const unreadTaskCount = computed(() => taskNotifications.value.filter(task => !task.read).length);

  syncFloatingNotificationBell();


  return {
    notifications,
    addNotification,
    removeNotification,
    showError,
    showSuccess,
    showInfo,
    showWarning,
    taskNotifications,
    unreadTaskCount,
    addTaskNotification,
    updateTaskNotification,
    upsertTaskNotification,
    markTaskNotificationsRead,
    clearTaskNotifications,
  };
});
