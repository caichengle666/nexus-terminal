<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useLayoutStore } from '../stores/layout.store';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { useUiNotificationsStore } from '../stores/uiNotifications.store';
import { useDeviceDetection } from '../composables/useDeviceDetection';

const { t } = useI18n();
const notificationsStore = useUiNotificationsStore();
const { taskNotifications, unreadTaskCount } = storeToRefs(notificationsStore);
const isOpen = ref(false);
// 桌面端：可拖动的悬浮铃铛（位置记在 localStorage）。
// 没拖过时默认停在工作区标签栏右侧的空白处（跟着顶栏显示/收起和窗口大小走），不压 Logo、新建标签和 AI 输入区；
// 不在工作区时停在右下角。拖过一次之后就固定在用户放的位置。
// 移动端：不显示悬浮铃铛，由 MobileAppHeader 的铃铛按钮触发 open-task-notification-center 事件打开面板。
const { isMobile } = useDeviceDetection();
const BUTTON_SIZE = 40;
const POSITION_KEY = 'task-notification-center-position';
const route = useRoute();
const { isHeaderVisible } = storeToRefs(useLayoutStore());
const hasSavedPosition = ref(false);
const defaultPosition = () => {
  const tabBar = document.querySelector('.terminal-tab-bar');
  const actions = tabBar?.lastElementChild;
  if (tabBar && actions) {
    const bar = tabBar.getBoundingClientRect();
    const actionRect = actions.getBoundingClientRect();
    if (bar.height > 0) return { x: actionRect.left - BUTTON_SIZE - 12, y: bar.top + (bar.height - BUTTON_SIZE) / 2 };
  }
  return { x: window.innerWidth - BUTTON_SIZE - 20, y: window.innerHeight - BUTTON_SIZE - 20 };
};
const buttonPosition = ref({ x: window.innerWidth - BUTTON_SIZE - 20, y: window.innerHeight - BUTTON_SIZE - 20 });
const placeAtDefault = async () => {
  if (hasSavedPosition.value || isMobile.value) return;
  await nextTick();
  // 等布局（顶栏/标签栏）渲染完再量
  requestAnimationFrame(() => {
    if (!hasSavedPosition.value) buttonPosition.value = clampPosition(defaultPosition().x, defaultPosition().y);
  });
};
watch(() => [route.path, isHeaderVisible.value], placeAtDefault);
const isDragging = ref(false);
let dragStart = { x: 0, y: 0 };
let dragMoved = false;
const dragOffset = { x: 0, y: 0 };

const clampPosition = (x: number, y: number) => ({
  x: Math.max(0, Math.min(window.innerWidth - BUTTON_SIZE, x)),
  y: Math.max(0, Math.min(window.innerHeight - BUTTON_SIZE, y)),
});

// 面板朝有空间的方向展开：铃铛在右半边就向左对齐，在下半边就向上弹出
const panelPlacement = computed(() => ({
  'right-0': buttonPosition.value.x > window.innerWidth / 2,
  'left-0': buttonPosition.value.x <= window.innerWidth / 2,
  'bottom-12': buttonPosition.value.y > window.innerHeight / 2,
  'top-12': buttonPosition.value.y <= window.innerHeight / 2,
}));

const keepInViewport = () => {
  if (!hasSavedPosition.value) { placeAtDefault(); return; }
  buttonPosition.value = clampPosition(buttonPosition.value.x, buttonPosition.value.y);
};
const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') isOpen.value = false; };

onMounted(() => {
  const savedPosition = localStorage.getItem(POSITION_KEY);
  if (savedPosition) {
    try {
      const position = JSON.parse(savedPosition);
      if (typeof position.x === 'number' && typeof position.y === 'number') {
        buttonPosition.value = clampPosition(position.x, position.y);
        hasSavedPosition.value = true;
      }
    } catch { localStorage.removeItem(POSITION_KEY); }
  }
  placeAtDefault();
  // 工作区异步加载，标签栏可能晚一点才出现
  setTimeout(placeAtDefault, 800);
  window.addEventListener('open-task-notification-center', showCenter);
  window.addEventListener('keydown', closeOnEscape);
  window.addEventListener('resize', keepInViewport);
});

onUnmounted(() => {
  window.removeEventListener('open-task-notification-center', showCenter);
  window.removeEventListener('keydown', closeOnEscape);
  window.removeEventListener('resize', keepInViewport);
});

const startDrag = (event: PointerEvent) => {
  isDragging.value = true;
  dragMoved = false;
  dragStart = { x: event.clientX, y: event.clientY };
  dragOffset.x = event.clientX - buttonPosition.value.x;
  dragOffset.y = event.clientY - buttonPosition.value.y;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
};
const moveDrag = (event: PointerEvent) => {
  if (!isDragging.value) return;
  if (Math.abs(event.clientX - dragStart.x) + Math.abs(event.clientY - dragStart.y) > 4) dragMoved = true;
  buttonPosition.value = clampPosition(event.clientX - dragOffset.x, event.clientY - dragOffset.y);
};
const endDrag = () => {
  if (!isDragging.value) return;
  isDragging.value = false;
  if (dragMoved) {
    localStorage.setItem(POSITION_KEY, JSON.stringify(buttonPosition.value));
    hasSavedPosition.value = true;
  }
};

const openCenter = () => {
  // 拖动结束后的那次 click 不算打开
  if (dragMoved) { dragMoved = false; return; }
  isOpen.value = !isOpen.value;
  if (isOpen.value) notificationsStore.markTaskNotificationsRead();
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

function showCenter() {
  isOpen.value = true;
  notificationsStore.markTaskNotificationsRead();
}
</script>

<template>
  <!-- 层级：收起时铃铛 z-45，高于页面内容 / 标签栏 / 面板内下拉 (≤ z-40)，低于所有弹窗遮罩 (≥ z-50)，弹窗打开时铃铛被遮罩盖住；
       展开面板时整体提到 z-1089/1090，面板和点击外部关闭的透明层盖住其它界面 (含侧边抽屉) -->
  <div v-if="isOpen" class="fixed inset-0 z-[1089]" aria-hidden="true" @click="isOpen = false" />
  <div
    v-if="!isMobile || isOpen"
    class="task-notification-center fixed"
    :class="[isOpen ? 'z-[1090]' : 'z-[45]', isMobile ? 'right-2 top-[calc(3.25rem+env(safe-area-inset-top))]' : '']"
    :style="isMobile ? undefined : { left: buttonPosition.x + 'px', top: buttonPosition.y + 'px' }"
  >
    <button
      v-if="!isMobile"
      type="button"
      class="task-bell-floating relative flex h-10 w-10 items-center justify-center rounded-full border border-border bg-header text-foreground shadow-lg hover:bg-hover touch-none"
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

    <section v-if="isOpen" :class="isMobile ? 'relative' : ['absolute', panelPlacement]" class="w-[min(24rem,calc(100vw-1rem))] overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-2xl" role="dialog" :aria-label="t('taskNotifications.title')">
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

<style scoped>
/* 铃铛可能停在标签栏（Electron 收起顶栏时是窗口拖动区）上，必须排除出拖动区，否则点不到也拖不动 */
.task-notification-center,
.task-notification-center * {
  -webkit-app-region: no-drag;
}
</style>
