/**
 * 登出 / 会话失效 (401) 时需要从浏览器存储中清除的敏感数据。
 *
 * 只清除包含服务器数据或用户内容的键 (连接列表、命令历史、AI 会话记忆及工具输出、审计日志等)；
 * 纯界面偏好 (语言、主题、布局、铃铛位置、排序方式等) 保留，避免每次登出后界面被重置。
 */
// AI 配置 (CONFIG_KEY：接口地址 / 模型) 属于偏好，不包含密钥，保留。
import { LEGACY_MESSAGES_KEY, LEGACY_TOOL_RUNS_KEY, MEMORIES_KEY } from '../stores/ai/ai.constants';

export const SENSITIVE_LOCAL_STORAGE_KEYS: readonly string[] = [
  // AI 助手：会话记忆 (包含终端输出 / 工具运行结果)
  MEMORIES_KEY,
  LEGACY_MESSAGES_KEY,
  LEGACY_TOOL_RUNS_KEY,
  // 服务器数据缓存
  'connectionsCache',
  'commandHistoryCache',
  'dashboardAuditLogsCache',
  'quickCommandsListCache',
  'quickCommandTagsCache',
  'tagsCache',
  // 使用记录
  'nexus.recentConnections',
  'nexus.favoriteConnectionIds',
  'nexus_terminal_rdp_transfer_history',
  'nexus.taskNotifications',
  'nexus.dismissedTaskNotifications',
  'sessionOrder',
];

/** 从 localStorage 中移除敏感键。存储不可用时静默忽略。 */
export function clearSensitiveLocalStorage(storage: Pick<Storage, 'removeItem'> | undefined = globalThis.localStorage): void {
  if (!storage) return;
  for (const key of SENSITIVE_LOCAL_STORAGE_KEYS) {
    try {
      storage.removeItem(key);
    } catch {
      // ignore (private mode / quota / disabled storage)
    }
  }
}

type LogoutCleanup = () => void;
const logoutCleanups = new Set<LogoutCleanup>();

/**
 * 注册登出时的内存清理回调 (例如 AI 会话记忆、连接列表)。
 * 通过注册表而非在 auth.store 中直接导入其他 store，避免 apiClient ↔ store 的循环依赖，
 * 也不会为了清理而实例化尚未使用过的 store。
 */
export function registerLogoutCleanup(fn: LogoutCleanup): () => void {
  logoutCleanups.add(fn);
  return () => logoutCleanups.delete(fn);
}

/** 登出 / 会话失效时调用：先清理内存中的敏感状态 (避免被重新写回存储)，再清除存储。 */
export function clearSensitiveClientData(): void {
  for (const fn of logoutCleanups) {
    try {
      fn();
    } catch (error) {
      console.warn('[Auth] 登出清理回调失败:', error);
    }
  }
  clearSensitiveLocalStorage();
}
