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
  progress?: number;
  createdAt: number;
  updatedAt: number;
  read: boolean;
  retry?: () => void | Promise<void>;
}

const TASK_NOTIFICATIONS_STORAGE_KEY = 'nexus.taskNotifications';

const loadTaskNotifications = (): TaskNotification[] => {
  try {
    const stored = JSON.parse(localStorage.getItem(TASK_NOTIFICATIONS_STORAGE_KEY) || '[]');
    if (!Array.isArray(stored)) return [];
    return stored.filter((task): task is TaskNotification => (
      task && typeof task.id === 'string' && typeof task.title === 'string'
      && typeof task.message === 'string' && typeof task.status === 'string'
      && typeof task.createdAt === 'number' && typeof task.updatedAt === 'number'
      && typeof task.read === 'boolean'
    )).slice(0, 50);
  } catch {
    return [];
  }
};

export const useUiNotificationsStore = defineStore('uiNotifications', () => {
  const notifications = ref<UINotification[]>([]);
  const taskNotifications = ref<TaskNotification[]>(loadTaskNotifications());
  let nextId = 0;

  const persistTaskNotifications = () => {
    const serializableTasks = taskNotifications.value.map(({ retry: _retry, ...task }) => task);
    localStorage.setItem(TASK_NOTIFICATIONS_STORAGE_KEY, JSON.stringify(serializableTasks));
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
    taskNotifications.value = [entry, ...taskNotifications.value].slice(0, 50);
    persistTaskNotifications();
    return entry.id;
  };

  const updateTaskNotification = (id: string, updates: Partial<Omit<TaskNotification, 'id' | 'createdAt'>>) => {
    const index = taskNotifications.value.findIndex(task => task.id === id);
    if (index === -1) return;
    taskNotifications.value[index] = {
      ...taskNotifications.value[index],
      ...updates,
      updatedAt: Date.now(),
    };
    persistTaskNotifications();
  };

  const markTaskNotificationsRead = () => {
    taskNotifications.value = taskNotifications.value.map(task => ({ ...task, read: true }));
    persistTaskNotifications();
  };

  const clearTaskNotifications = () => {
    taskNotifications.value = [];
    persistTaskNotifications();
  };

  const unreadTaskCount = computed(() => taskNotifications.value.filter(task => !task.read).length);


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
    markTaskNotificationsRead,
    clearTaskNotifications,
  };
});
