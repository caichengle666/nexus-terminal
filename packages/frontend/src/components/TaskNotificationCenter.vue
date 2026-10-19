<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { useUiNotificationsStore } from '../stores/uiNotifications.store';
import { useDeviceDetection } from '../composables/useDeviceDetection';

const { t } = useI18n();
const notificationsStore = useUiNotificationsStore();
const { taskNotifications } = storeToRefs(notificationsStore);
const isOpen = ref(false);
// 面板由各处铃铛按钮触发 open-task-notification-center 事件打开（Electron 托盘 / 桌面悬浮铃铛也走这个事件）。
const { isMobile } = useDeviceDetection();
const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') isOpen.value = false; };
onMounted(() => {
  window.addEventListener('open-task-notification-center', showCenter);
  window.addEventListener('keydown', closeOnEscape);
});
onUnmounted(() => {
  window.removeEventListener('open-task-notification-center', showCenter);
  window.removeEventListener('keydown', closeOnEscape);
});

const statusIcon = (status: string) => {
  if (status === 'running') return 'fas fa-spinner fa-spin';
  if (status === 'success') return 'fas fa-check-circle';
  if (status === 'error') return 'fas fa-exclamation-circle';
  return 'fas fa-ban';
};

const statusClass = (status: string) => ({
  'text-primary': status === 'running',
  'text-green-500': status === 'success',
  'text-red-500': status === 'error',
  'text-text-secondary': status === 'cancelled',
});

function showCenter() {
  isOpen.value = true;
  notificationsStore.markTaskNotificationsRead();
}
</script>

<template>
  <!-- 任务通知面板：由顶栏 / 标签栏 / 移动端顶栏里的铃铛按钮打开，不再在页面上悬浮（会盖住 Logo、新建标签等按钮） -->
  <div v-if="isOpen" class="fixed inset-0 z-[1089]" aria-hidden="true" @click="isOpen = false" />
  <div
    v-if="isOpen"
    class="task-notification-center fixed right-2 z-[1090]"
    :class="isMobile ? 'top-[calc(3.25rem+env(safe-area-inset-top))]' : 'top-12'"
  >
    <section class="relative w-[min(24rem,calc(100vw-1rem))] overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-2xl" role="dialog" :aria-label="t('taskNotifications.title')">
      <header class="flex items-center justify-between border-b border-border bg-header px-3 py-2">
        <h2 class="text-sm font-semibold">{{ t('taskNotifications.title') }}</h2>
        <button type="button" class="text-xs text-text-secondary hover:text-foreground" @click="notificationsStore.clearTaskNotifications">
          {{ t('taskNotifications.clear') }}
        </button>
      </header>
      <div v-if="taskNotifications.length === 0" class="p-4 text-center text-sm text-text-secondary">
        {{ t('taskNotifications.empty') }}
      </div>
      <ul v-else class="max-h-80 overflow-auto">
        <li v-for="task in taskNotifications" :key="task.id" class="border-b border-border/70 px-3 py-2 last:border-b-0">
          <div class="flex items-start gap-2">
            <i :class="[statusIcon(task.status), statusClass(task.status), 'mt-0.5']" aria-hidden="true"></i>
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium">{{ task.title }}</p>
              <p class="break-words text-xs text-text-secondary">{{ task.message }}</p>
              <div v-if="task.status === 'running' && task.progress !== undefined" class="mt-1 h-1.5 overflow-hidden rounded bg-border">
                <div class="h-full bg-primary transition-all" :style="{ width: `${Math.max(0, Math.min(100, task.progress))}%` }"></div>
              </div>
              <button v-if="task.status === 'running' && task.cancel" type="button" class="mt-1 text-xs text-primary hover:underline" @click="task.cancel?.()">
                {{ t('uxFiles.download.cancel') }}
              </button>
              <button v-if="task.status === 'error' && task.retry" type="button" class="mt-1 text-xs text-primary hover:underline" @click="task.retry?.()">
                {{ t('taskNotifications.retry') }}
              </button>
            </div>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.task-notification-center {
  -webkit-app-region: no-drag;
  user-select: none;
}
</style>
