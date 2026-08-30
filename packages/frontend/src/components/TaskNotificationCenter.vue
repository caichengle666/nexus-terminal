<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { useUiNotificationsStore } from '../stores/uiNotifications.store';

const { t } = useI18n();
const notificationsStore = useUiNotificationsStore();
const { taskNotifications, unreadTaskCount } = storeToRefs(notificationsStore);
const isOpen = ref(false);
const buttonPosition = ref({ x: 16, y: 16 });
const isDragging = ref(false);
const dragOffset = ref({ x: 0, y: 0 });

const clampPosition = (x: number, y: number) => ({
  x: Math.max(0, Math.min(window.innerWidth - 40, x)),
  y: Math.max(0, Math.min(window.innerHeight - 40, y)),
});

onMounted(() => {
  const savedPosition = localStorage.getItem('task-notification-center-position');
  if (!savedPosition) return;
  try {
    const position = JSON.parse(savedPosition);
    if (typeof position.x === 'number' && typeof position.y === 'number') buttonPosition.value = clampPosition(position.x, position.y);
  } catch { localStorage.removeItem('task-notification-center-position'); }
});

const startDrag = (event: PointerEvent) => {
  isDragging.value = true;
  dragOffset.value = { x: event.clientX - buttonPosition.value.x, y: event.clientY - buttonPosition.value.y };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
};
const moveDrag = (event: PointerEvent) => {
  if (isDragging.value) buttonPosition.value = clampPosition(event.clientX - dragOffset.value.x, event.clientY - dragOffset.value.y);
};
const endDrag = () => {
  if (!isDragging.value) return;
  isDragging.value = false;
  localStorage.setItem('task-notification-center-position', JSON.stringify(buttonPosition.value));
};

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

const openCenter = () => {
  if (isDragging.value) return;
  isOpen.value = !isOpen.value;
  if (isOpen.value) notificationsStore.markTaskNotificationsRead();
};
</script>

<template>
  <div class="fixed z-[1090]" :style="{ left: buttonPosition.x + 'px', top: buttonPosition.y + 'px' }">
    <button
      type="button"
      class="relative flex h-10 w-10 items-center justify-center rounded-full border border-border bg-header text-foreground shadow-lg hover:bg-hover"
      :title="t('taskNotifications.title')"
      :aria-label="t('taskNotifications.title')"
      :aria-expanded="isOpen"
      :class="{ 'cursor-grabbing': isDragging, 'cursor-grab': !isDragging }"
      @pointerdown="startDrag"
      @pointermove="moveDrag"
      @pointerup="endDrag"
      @pointercancel="endDrag"
      @click="openCenter"
    >
      <i class="fas fa-bell" aria-hidden="true"></i>
      <span v-if="unreadTaskCount > 0" class="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] text-white">
        {{ unreadTaskCount > 99 ? '99+' : unreadTaskCount }}
      </span>
    </button>

    <section v-if="isOpen" class="absolute left-0 top-12 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-2xl" role="dialog" :aria-label="t('taskNotifications.title')">
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
