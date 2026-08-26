
<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from 'vue'; // Added computed
import { useI18n } from 'vue-i18n';
import apiClient from '../utils/apiClient';
import { useConnectionsStore } from '../stores/connections.store'; // 请确认此路径是否正确
import { useRdpTransferStore } from '../stores/rdpTransfer.store';

interface Props {
  visible: boolean;
  embedded?: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits(['update:visible']);
const { t, locale } = useI18n(); // +++ 解构出 locale +++
const connectionsStore = useConnectionsStore();
const rdpTransferStore = useRdpTransferStore();

// Helper function to get connection name by ID
// 注意: 此函数假设 'connectionsStore.connections' 是一个包含连接对象的数组，
// 每个对象至少有 'id' 和 'name' 属性。请根据实际 store 结构调整。
const getConnectionName = (connectionId: number): string => {
  const connection = connectionsStore.connections?.find((c: any) => c.id === connectionId);
  if (connection && connection.name) {
    return connection.name;
  }
  return `连接ID: ${connectionId}`; // 未找到连接或名称时的回退显示
};

// Helper function to format the task title
const formatTaskTitle = (task: TransferTask): string => {
  const fileName = (task.subTasks && task.subTasks.length > 0)
    ? task.subTasks[0].sourceItemName
    : "[文件名未知]";
  
  const sourceServerName = task.sourceConnectionId
    ? getConnectionName(task.sourceConnectionId)
    : "[源服务器名]"; // 占位符，如果 sourceConnectionId 未提供
    
  const targetPath = task.remoteTargetPath || "[目标路径]"; // 占位符，如果 remoteTargetPath 未提供

  // 如果 sourceConnectionId, remoteTargetPath 都未提供，且没有子任务（无法获取文件名），则退回显示原始任务ID
  if (!task.sourceConnectionId && !task.remoteTargetPath && (!task.subTasks || task.subTasks.length === 0)) {
    return `任务ID: ${task.taskId}`;
  }
  
  return `${sourceServerName} (${fileName} -> ${targetPath})`;
};


// 数据结构参考
interface TransferSubTask {
  subTaskId: string;
  connectionId: number;
  sourceItemName: string;
  status: 'queued' | 'connecting' | 'transferring' | 'completed' | 'failed' | 'cancelling' | 'cancelled'; // +++ 新增状态 +++
  progress?: number; // 0-100
  message?: string;
  transferMethodUsed?: 'sftp-relay';
  transferredBytes?: number;
  totalBytes?: number;
  speedBytesPerSecond?: number;
  currentPath?: string;
  filesCompleted?: number;
  totalFiles?: number;
}

interface TransferTask {
  taskId: string;
  status: 'queued' | 'in-progress' | 'completed' | 'failed' | 'partially-completed' | 'cancelling' | 'cancelled'; // +++ 新增状态 +++
  createdAt: string | Date;
  updatedAt: string | Date;
  subTasks: TransferSubTask[];
  overallProgress?: number;
  sourceConnectionId?: number; 
  remoteTargetPath?: string; 
  isLocal?: boolean;
}

const transferTasks = ref<TransferTask[]>([]);
const isLoading = ref(false);
const errorLoading = ref<string | null>(null);
const pollingIntervalId = ref<number | null>(null);
const statusFilter = ref<'all' | 'active' | 'completed' | 'failed'>('all');
const retryingTaskId = ref<string | null>(null);

const localTransferTasks = computed<TransferTask[]>(() => rdpTransferStore.records.map(record => ({
  taskId: record.id,
  status: record.status === 'transferring' ? 'in-progress' : record.status,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  overallProgress: record.progress,
  remoteTargetPath: record.direction === 'upload' ? 'RDP 上传' : 'RDP 下载',
  isLocal: true,
  subTasks: [{
    subTaskId: record.id,
    connectionId: 0,
    sourceItemName: `${record.direction === 'upload' ? '↑' : '↓'} ${record.filename}`,
    status: record.status === 'transferring' ? 'transferring' : record.status,
    progress: record.progress,
    message: record.message,
    transferredBytes: record.transferredBytes,
    totalBytes: record.totalBytes,
    speedBytesPerSecond: record.speedBytesPerSecond,
  }],
})));

const allTasks = computed(() => [...transferTasks.value, ...localTransferTasks.value]);

const filteredTasks = computed(() => allTasks.value.filter(task => {
  if (statusFilter.value === 'active') return ['queued', 'in-progress', 'cancelling'].includes(task.status);
  if (statusFilter.value === 'completed') return ['completed', 'partially-completed'].includes(task.status);
  if (statusFilter.value === 'failed') return ['failed', 'cancelled'].includes(task.status);
  return true;
}));

const displayedTasks = computed(() => {
  return [...filteredTasks.value]
    .sort((a, b) => {
      const dateA = new Date(a.createdAt);
      const dateB = new Date(b.createdAt);
      return dateB.getTime() - dateA.getTime();
    })
    .slice(0, 50);
});

const fetchTransferTasks = async () => {
  isLoading.value = true;
  errorLoading.value = null;
  try {
    // 假设后端API路径为 /api/v1/transfers/status，且返回数据结构为 { data: TransferTask[] }
    // 请根据实际API调整这里的类型和数据访问
    const response = await apiClient.get<{ data: TransferTask[] }>('/transfers/status');
    const rawTasks = Array.isArray(response.data.data) ? response.data.data : (Array.isArray(response.data) ? response.data : []);
    transferTasks.value = rawTasks.map(task => {
      // 优先信任后端已经是 'cancelled' 或其他最终状态
      if (['completed', 'failed', 'cancelled', 'partially-completed'].includes(task.status)) {
        return task;
      }
      // 对于仍在进行中或正在取消中的任务
      if (['in-progress', 'cancelling', 'queued', 'connecting', 'transferring'].includes(task.status)) {
        // 如果它有子任务，并且所有子任务都已是 'cancelled'
        if (task.subTasks && task.subTasks.length > 0 && task.subTasks.every((st: TransferSubTask) => st.status === 'cancelled')) {
          // 则认为主任务也应该被标记为 'cancelled'
          // 这有助于处理后端主任务状态更新延迟或遗漏的情况
          return { ...task, status: 'cancelled' as TransferTask['status'] };
        }
        // 如果任务状态是 'cancelling' 但它没有子任务 (或子任务列表为空)
        // 这种情况也应视为已取消
        else if (task.status === 'cancelling' && (!task.subTasks || task.subTasks.length === 0)) {
            return { ...task, status: 'cancelled' as TransferTask['status'] };
        }
      }
      return task;
    });
  } catch (error: any) {
    console.error("Failed to fetch transfer tasks:", error);
    errorLoading.value = error.response?.data?.message || error.message || t('transferProgressModal.error.unknown', '未知错误');
  } finally {
    isLoading.value = false;
  }
};

const getDisplayStatus = (status: string): string => {
  const statusKeyMap: Record<string, string> = {
    'queued': 'transferProgressModal.status.queued',
    'in-progress': 'transferProgressModal.status.inProgress',
    'completed': 'transferProgressModal.status.completed',
    'failed': 'transferProgressModal.status.failed',
    'partially-completed': 'transferProgressModal.status.partiallyCompleted',
    'connecting': 'transferProgressModal.status.connecting',
    'transferring': 'transferProgressModal.status.transferring',
    'cancelling': 'transferProgressModal.status.cancelling',
    'cancelled': 'transferProgressModal.status.cancelled', 
  };
  // 提供一个默认的回退文本，以防i18n key缺失
  const defaultText = status.charAt(0).toUpperCase() + status.slice(1).replace('-', ' ');
  return t(statusKeyMap[status] || `status.${status}`, defaultText);
};

const formatDate = (dateInput: string | Date): string => {
  if (!dateInput) return '';
  try {
    // +++ 使用 i18n 的 locale 进行日期格式化 +++
    return new Date(dateInput).toLocaleString(locale.value, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  } catch (e) {
    return String(dateInput); 
  }
};

const formatBytes = (bytes = 0): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, unitIndex);
  return `${value >= 100 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
};

const formatEta = (subTask: TransferSubTask): string => {
  const speed = subTask.speedBytesPerSecond ?? 0;
  const remainingBytes = Math.max(0, (subTask.totalBytes ?? 0) - (subTask.transferredBytes ?? 0));
  if (speed <= 0 || remainingBytes <= 0) return '';
  const seconds = Math.ceil(remainingBytes / speed);
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟`;
  return `${(seconds / 3600).toFixed(1)} 小时`;
};

onMounted(() => {
  if (connectionsStore.connections.length === 0) {
    void connectionsStore.fetchConnections();
  }
  if (props.visible) {
    fetchTransferTasks();
    if (pollingIntervalId.value === null) {
       pollingIntervalId.value = window.setInterval(fetchTransferTasks, 1500);
    }
  }
});

onUnmounted(() => {
  if (pollingIntervalId.value !== null) {
    clearInterval(pollingIntervalId.value);
    pollingIntervalId.value = null;
  }
});

watch(() => props.visible, (newVisible) => {
  // internalVisible.value = newVisible; // 由下面的watch处理
  if (newVisible) {
    fetchTransferTasks(); // 模态框可见时立即获取一次数据
    if (pollingIntervalId.value === null) { // 只有在没有定时器时才启动
      pollingIntervalId.value = window.setInterval(fetchTransferTasks, 1500);
    }
  } else {
    if (pollingIntervalId.value !== null) {
      clearInterval(pollingIntervalId.value);
      pollingIntervalId.value = null;
    }
  }
}, { immediate: false }); // immediate: false 避免在组件初始化时立即执行，onMounted已处理首次加载

// --- 模态框可见性控制 ---
const internalVisible = ref(props.visible);

// 监听 props.visible 的变化来更新 internalVisible
watch(() => props.visible, (newVisibleValue) => {
  internalVisible.value = newVisibleValue;
}, { immediate: true }); // 确保初始状态同步

// 监听 internalVisible 的变化来 emit update:visible
watch(internalVisible, (newVal) => {
  if (newVal !== props.visible) {
    emit('update:visible', newVal);
  }
});

const handleClose = () => {
  internalVisible.value = false;
};

const isTaskCancellable = (taskStatus: TransferTask['status'], isLocal = false): boolean => {
  return !isLocal && ['queued', 'in-progress', 'connecting', 'transferring', 'cancelling'].includes(taskStatus);
};

const isTaskCancelling = (taskStatus: TransferTask['status']): boolean => {
  return taskStatus === 'cancelling';
};

const isTaskRetryable = (taskStatus: TransferTask['status'], isLocal = false): boolean => {
  return !isLocal && ['failed', 'partially-completed', 'cancelled'].includes(taskStatus);
};

const handleCancelTask = async (taskId: string) => {
  // 可以在这里添加一个确认对话框
  // const confirmed = window.confirm(t('transferProgressModal.confirmCancel', '您确定要终止此传输任务吗？'));
  // if (!confirmed) return;

  const cancelTask = transferTasks.value.find(t => t.taskId === taskId);
  if (cancelTask?.isLocal) return;

  try {
    await apiClient.post(`/transfers/cancel/${taskId}`);
    const taskBeingCancelled = transferTasks.value.find(t => t.taskId === taskId);
    if (taskBeingCancelled && ['queued', 'in-progress', 'connecting', 'transferring'].includes(taskBeingCancelled.status)) {
      taskBeingCancelled.status = 'cancelling';
    }
    
    // 立即刷新一次列表，或者等待下一次轮询
    fetchTransferTasks();
  } catch (error: any) {
    console.error(`Failed to cancel task ${taskId}:`, error);
  }
};

const handleRetryTask = async (taskId: string) => {
  const retryTask = transferTasks.value.find(t => t.taskId === taskId);
  if (retryTask?.isLocal) return;
  retryingTaskId.value = taskId;
  try {
    await apiClient.post(`/transfers/retry/${taskId}`);
    await fetchTransferTasks();
  } catch (error: any) {
    console.error(`Failed to retry task ${taskId}:`, error);
    errorLoading.value = error.response?.data?.message || error.message || t('transferProgressModal.error.retryFailed', '重试任务失败。');
  } finally {
    retryingTaskId.value = null;
  }
};

</script>

<template>
  <div
    v-if="internalVisible"
    :class="props.embedded ? 'flex h-full min-h-0 w-full' : 'fixed inset-0 bg-overlay flex justify-center items-center z-50 p-4'"
    @click.self="props.embedded ? undefined : handleClose()"
  >
    <div :class="[
      'bg-background text-foreground w-full flex flex-col',
      props.embedded ? 'h-full min-h-0 p-3 border-0' : 'p-6 rounded-lg shadow-xl border max-w-3xl max-h-[85vh]'
    ]" :style="{ borderColor: 'var(--border-color)' }">
      <!-- Header -->
      <h3 class="text-xl font-semibold text-center mb-6 flex-shrink-0">
        {{ t('transferProgressModal.title', '文件传输进度') }}
      </h3>

      <div v-if="transferTasks.length > 0" class="flex flex-wrap gap-2 mb-4 flex-shrink-0">
        <button
          type="button"
          v-for="filter in ['all', 'active', 'completed', 'failed'] as const"
          :key="filter"
          @click="statusFilter = filter"
          :class="[
            'px-3 py-1.5 text-xs rounded-md border transition-colors',
            statusFilter === filter ? 'bg-primary text-white border-primary' : 'text-text-secondary hover:text-foreground hover:bg-background-alt'
          ]"
        >
          {{ t(`transferProgressModal.filters.${filter}`) }}
        </button>
      </div>

      <!-- Content Area -->
      <div class="flex-grow overflow-y-auto mb-6 pr-2 space-y-4 custom-scrollbar">
        <div v-if="isLoading && allTasks.length === 0" class="text-center text-text-secondary py-10">
          <svg class="animate-spin h-8 w-8 text-primary mx-auto mb-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          {{ t('transferProgressModal.loading', '正在加载传输任务...') }}
        </div>
        <div v-else-if="errorLoading && localTransferTasks.length === 0" class="text-center text-red-500 bg-red-50 p-4 rounded-md">
          <p class="font-semibold">{{ t('transferProgressModal.errorLoadingTitle', '加载错误') }}</p>
          <p>{{ t('transferProgressModal.errorLoading', { error: errorLoading }) }}</p>
        </div>
        <div v-else-if="!isLoading && displayedTasks.length === 0" class="text-center text-text-secondary py-10">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-12 w-12 text-gray-400 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          {{ t('transferProgressModal.noTasks', '当前没有活动的传输任务。') }}
        </div>
        <div v-else class="space-y-3">
          <div v-for="task in displayedTasks" :key="task.taskId" class="bg-background-alt p-3 rounded-lg border shadow-sm hover:shadow-md transition-shadow" :style="{ borderColor: 'var(--border-color)' }">
            <div class="flex justify-between items-start mb-2">
              <div>
                <span class="font-semibold text-md block">{{ t('transferProgressModal.task.idLabel', '任务') }}: {{ formatTaskTitle(task) }}</span>
                <span class="text-xs text-text-muted">{{ t('transferProgressModal.task.createdAt', '创建于') }}: {{ formatDate(task.createdAt) }}</span>
              </div>
              <div class="flex items-center space-x-2">
                <span :class="['px-2.5 py-1 text-xs font-semibold rounded-full',
                  { 'bg-green-100 text-green-700': task.status === 'completed' },
                  { 'bg-red-100 text-red-700': task.status === 'failed' },
                  { 'bg-yellow-100 text-yellow-700': task.status === 'partially-completed' || task.status === 'queued' || task.status === 'cancelling' }, // cancelling 也用黄色
                  { 'bg-blue-100 text-blue-700': task.status === 'in-progress' },
                  { 'bg-gray-100 text-gray-700': task.status === 'cancelled' } // cancelled 用灰色
                ]">
                  {{ getDisplayStatus(task.status) }}
                </span>
                <div class="flex items-center gap-1">
                  <button
                    v-if="isTaskRetryable(task.status, task.isLocal)"
                    type="button"
                    @click="handleRetryTask(task.taskId)"
                    :disabled="retryingTaskId === task.taskId"
                    class="px-2 py-0.5 text-xs bg-primary hover:bg-primary/80 text-white rounded-md focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    :title="t('transferProgressModal.retryTaskTooltip', '重试任务')"
                  >
                    <i :class="['fas', retryingTaskId === task.taskId ? 'fa-spinner fa-spin' : 'fa-rotate-right', 'mr-1']"></i>
                    {{ retryingTaskId === task.taskId ? t('transferProgressModal.retryingButton', '重试中') : t('transferProgressModal.retryButton', '重试') }}
                  </button>
                  <button
                    v-if="isTaskCancellable(task.status, task.isLocal)"
                    type="button"
                    @click="handleCancelTask(task.taskId)"
                    :disabled="isTaskCancelling(task.status)"
                    class="px-2 py-0.5 text-xs bg-red-500 hover:bg-red-600 text-white rounded-md focus:outline-none focus:ring-2 focus:ring-red-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    :title="isTaskCancelling(task.status) ? t('transferProgressModal.cancellingTooltip', '终止中...') : t('transferProgressModal.cancelTaskTooltip', '终止任务')"
                  >
                    <i v-if="isTaskCancelling(task.status)" class="fas fa-spinner fa-spin mr-1"></i>
                    {{ isTaskCancelling(task.status) ? t('transferProgressModal.cancellingButton', '终止中') : t('transferProgressModal.cancelButton', '终止') }}
                  </button>
                </div>
              </div>
            </div>

            <div v-if="task.overallProgress !== undefined" class="mb-2">
              <div class="flex justify-between text-xs text-text-secondary mb-0.5">
                <span>{{ t('transferProgressModal.task.overallProgress', '整体进度') }}</span>
                <span>{{ task.overallProgress }}%</span>
              </div>
              <div class="w-full bg-border rounded-full h-1.5">
                <div class="bg-primary h-1.5 rounded-full" :style="{ width: task.overallProgress + '%' }"></div>
              </div>
            </div>

            <details v-if="task.subTasks && task.subTasks.length > 0" class="mt-2 group">
              <summary class="text-xs font-medium text-primary hover:underline cursor-pointer list-none">
                {{ t('transferProgressModal.subTasks.titleToggle', { count: task.subTasks.length }) }}
                <span class="group-open:hidden">+</span><span class="hidden group-open:inline">-</span>
              </summary>
              <ul class="mt-2 space-y-1.5 pl-3 border-l ml-1" :style="{ borderLeftColor: 'var(--border-color)' }">
                <li v-for="subTask in task.subTasks" :key="subTask.subTaskId" class="text-xs p-1.5 rounded bg-background border" :style="{ borderColor: 'var(--border-color)' }">
                  <p><strong>{{ t('transferProgressModal.subTask.source', '源文件') }}:</strong> {{ subTask.sourceItemName }}</p>
                  <p><strong>{{ t('transferProgressModal.subTask.connectionId', '目标连接') }}:</strong> {{ getConnectionName(subTask.connectionId) }}</p>
                  <div class="flex items-center">
                    <strong class="mr-1">{{ t('transferProgressModal.subTask.status', '状态') }}:</strong>
                    <span :class="['px-2 py-0.5 text-xs font-semibold rounded-full',
                      { 'bg-green-100 text-green-700': subTask.status === 'completed' },
                      { 'bg-red-100 text-red-700': subTask.status === 'failed' },
                      { 'bg-yellow-100 text-yellow-700': subTask.status === 'queued' || subTask.status === 'cancelling' },
                      { 'bg-blue-100 text-blue-700': subTask.status === 'transferring' || subTask.status === 'connecting' }, // 'connecting' and 'transferring' use blue
                      { 'bg-gray-100 text-gray-700': subTask.status === 'cancelled' }
                    ]">
                      {{ getDisplayStatus(subTask.status) }}
                    </span>
                    <span v-if="subTask.progress !== undefined" class="ml-1 text-xs text-text-secondary"> ({{ subTask.progress }}%)</span>
                  </div>
                  <p v-if="subTask.transferMethodUsed"><strong>{{ t('transferProgressModal.subTask.method', '方法') }}:</strong> Nexus SFTP</p>
                  <div v-if="subTask.totalBytes !== undefined" class="mt-1 space-y-1">
                    <div class="w-full bg-border rounded-full h-1.5 overflow-hidden">
                      <div class="bg-primary h-1.5 rounded-full" :style="{ width: (subTask.progress ?? 0) + '%' }"></div>
                    </div>
                    <div class="flex flex-wrap gap-x-3 gap-y-0.5 text-text-secondary">
                      <span>{{ formatBytes(subTask.transferredBytes) }} / {{ formatBytes(subTask.totalBytes) }}</span>
                      <span v-if="subTask.totalFiles">{{ subTask.filesCompleted ?? 0 }} / {{ subTask.totalFiles }} 个文件</span>
                      <span v-if="subTask.speedBytesPerSecond">{{ formatBytes(subTask.speedBytesPerSecond) }}/s</span>
                      <span v-if="formatEta(subTask)">预计 {{ formatEta(subTask) }}</span>
                    </div>
                    <p v-if="subTask.currentPath" class="truncate text-text-muted" :title="subTask.currentPath">{{ subTask.currentPath }}</p>
                  </div>
                  <p v-if="subTask.status === 'failed' && subTask.message" class="text-red-600">
                    <strong>{{ t('transferProgressModal.subTask.error', '错误') }}:</strong> {{ subTask.message }}
                  </p>
                </li>
              </ul>
            </details>
            <div v-else-if="task.subTasks && task.subTasks.length === 0" class="mt-2 text-xs text-text-muted">
               {{ t('transferProgressModal.subTasks.noSubTasks', '没有子任务。') }}
            </div>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div v-if="!props.embedded" class="flex justify-end items-center pt-4 mt-auto flex-shrink-0 border-t" :style="{ borderTopColor: 'var(--border-color)' }">
        <button
          @click="handleClose"
          class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out"
        >
          {{ t('common.close', '关闭') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bg-overlay {
  background-color: rgba(0, 0, 0, 0.6); /* Slightly darker overlay */
}

.custom-scrollbar::-webkit-scrollbar {
  width: 6px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background-color: rgba(128, 128, 128, 0.3);
  border-radius: 10px;
  border: 2px solid transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background-color: rgba(128, 128, 128, 0.5);
}

/* For Firefox */
.custom-scrollbar {
  scrollbar-width: thin;
  scrollbar-color: rgba(128, 128, 128, 0.3) transparent;
}
</style>
