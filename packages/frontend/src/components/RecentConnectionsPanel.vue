<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { useConnectionsStore } from '../stores/connections.store';
import type { ConnectionInfo } from '../stores/connections.store';
import { useSessionStore } from '../stores/session.store';
import { formatRelativeFromSeconds, sortByRecentUse } from '../utils/relativeTime';

/**
 * 没有任何会话时，终端面板里给一份「最近连接」，点一下直接开会话。
 *
 * 尺寸跟着面板走：能放几行就显示几行（按容器高度算，不滚动、不越界）。
 * 面板很矮时切 compact —— 去掉图标和底部链接，只留标题 + 能放下的那几行。
 *
 * 排序：先按 last_connected_at 倒序，从没连过的按 created_at 倒序垫在后面，
 * 新库（一次都没连过）也不至于是一片空白。
 */
const props = defineProps<{
  isMobile?: boolean;
}>();

const { t, locale } = useI18n();
const connectionsStore = useConnectionsStore();
const sessionStore = useSessionStore();
const { connections, isLoading } = storeToRefs(connectionsStore);

const MAX_ITEMS = props.isMobile ? 8 : 6;

/** 上下内边距（py-3）、标题下外边距、底部链接上外边距、行间距（space-y-1.5） */
const PAD_Y = 12;
const HEADER_MB = 10;
const FOOTER_MT = 8;
const ROW_GAP = 6;

const containerRef = ref<HTMLElement | null>(null);
const headerRef = ref<HTMLElement | null>(null);
const footerRef = ref<HTMLElement | null>(null);

const containerHeight = ref(0);
const containerWidth = ref(0);
/** 行高不写死：字体 / 缩放 / 主题不同会差几像素，写死就会多塞一行被裁掉 */
const rowHeight = ref(52);
const visibleCount = ref(MAX_ITEMS);

const compact = computed(() => containerHeight.value > 0 && containerHeight.value < 260);
/** 太窄就不显示「上次连接」，留给名字和 host */
const narrow = computed(() => containerWidth.value > 0 && containerWidth.value < 380);

const recentConnections = computed<ConnectionInfo[]>(() => sortByRecentUse(connections.value).slice(0, MAX_ITEMS));
const visibleConnections = computed(() => recentConnections.value.slice(0, visibleCount.value));

const typeIcon = (type: ConnectionInfo['type']): string => {
  if (type === 'RDP') return 'fa-desktop';
  if (type === 'VNC') return 'fa-plug';
  return 'fa-server';
};

const lastUsedText = (conn: ConnectionInfo): string => formatRelativeFromSeconds(
  conn.last_connected_at,
  locale.value,
  t('workspace.recentConnections.neverConnected'),
);

const connect = (conn: ConnectionInfo) => {
  sessionStore.handleConnectRequest(conn);
};

const measureRowHeight = () => {
  const li = containerRef.value?.querySelector('li') as HTMLElement | null;
  const h = li?.getBoundingClientRect().height ?? 0;
  if (h > 20 && Math.abs(h - rowHeight.value) > 0.5) {
    rowHeight.value = h;
    recompute();
  }
};

const recompute = () => {
  const el = containerRef.value;
  if (!el) return;
  containerHeight.value = el.clientHeight;
  containerWidth.value = el.clientWidth;
  void nextTick(() => {
    const inner = containerRef.value;
    if (!inner) return;
    const chrome = (headerRef.value?.offsetHeight ?? 0)
      + (compact.value ? 0 : HEADER_MB)
      + (footerRef.value?.offsetHeight ?? 0)
      + (footerRef.value ? FOOTER_MT : 0);
    const avail = inner.clientHeight - PAD_Y * 2 - chrome;
    const per = rowHeight.value + ROW_GAP;
    const fit = Math.floor((avail + ROW_GAP) / per);
    const next = Math.min(MAX_ITEMS, Math.max(1, fit));
    if (next !== visibleCount.value) visibleCount.value = next;
    void nextTick(measureRowHeight);
  });
};

let observer: ResizeObserver | null = null;

onMounted(() => {
  // 每次回到空工作区都刷新一次：刚连过的那条 last_connected_at 已经变了
  void connectionsStore.fetchConnections();

  recompute();
  if (typeof ResizeObserver !== 'undefined' && containerRef.value) {
    observer = new ResizeObserver(() => recompute());
    observer.observe(containerRef.value);
  }
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});
</script>

<template>
  <div
    ref="containerRef"
    class="recent-connections flex h-full w-full overflow-hidden px-3 py-3"
    data-testid="recent-connections"
  >
    <div class="m-auto w-full max-w-[560px]">
      <div ref="headerRef" class="text-center" :class="compact ? 'mb-0' : 'mb-2.5'">
        <div
          v-if="!compact"
          class="rc-icon mb-2 inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary"
        >
          <i class="fas fa-bolt"></i>
        </div>
        <h2 class="text-sm font-semibold text-foreground">{{ t('workspace.recentConnections.title') }}</h2>
      </div>

      <div v-if="isLoading && recentConnections.length === 0" class="py-4 text-center text-xs text-text-secondary">
        <i class="fas fa-spinner fa-spin text-primary mr-1.5"></i>{{ t('common.loading') }}
      </div>

      <div
        v-else-if="recentConnections.length === 0"
        class="rc-row rounded-xl border border-border/60 px-4 py-6 text-center"
      >
        <p class="text-xs text-text-secondary">{{ t('workspace.recentConnections.empty') }}</p>
        <router-link to="/connections" class="mt-2 inline-block text-xs text-primary hover:underline">
          {{ t('workspace.recentConnections.emptyAction') }}
        </router-link>
      </div>

      <ul v-else class="m-0 list-none space-y-1.5 p-0">
        <li v-for="conn in visibleConnections" :key="conn.id">
          <button
            type="button"
            class="rc-row group flex w-full items-center gap-3 rounded-xl border border-border/60 px-3 py-2 text-left transition-colors hover:border-primary/40 cursor-pointer"
            :title="`${conn.name || conn.host} — ${conn.username ? conn.username + '@' : ''}${conn.host}:${conn.port}`"
            @click="connect(conn)"
          >
            <span class="rc-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <i :class="['fas', typeIcon(conn.type), 'text-xs']"></i>
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium text-foreground">
                {{ conn.name || conn.host || t('connections.unnamedFallback') }}
              </span>
              <span class="mt-0.5 block truncate font-mono text-[11px] text-text-secondary">
                {{ conn.username ? conn.username + '@' : '' }}{{ conn.host }}:{{ conn.port }}
              </span>
            </span>
            <span v-if="!narrow" class="shrink-0 text-[11px] text-text-secondary">{{ lastUsedText(conn) }}</span>
            <i v-if="!narrow" class="rc-chevron fas fa-chevron-right text-[10px] text-text-secondary opacity-0 transition-opacity group-hover:opacity-100"></i>
          </button>
        </li>
      </ul>

      <div v-if="!compact && recentConnections.length > 0" ref="footerRef" class="mt-2 text-center">
        <router-link to="/connections" class="text-[11px] text-text-secondary hover:text-primary">
          {{ t('workspace.recentConnections.viewAll') }}
        </router-link>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 全局 `i, .fas { color: var(--icon-color) }` 会盖掉继承来的 text-primary */
.rc-icon i {
  color: inherit;
}

/* 行底色：普通主题用应用背景色（放在 bg-header 占位层上会略有层次），毛玻璃下用极淡提亮层
 * 注意：scoped 样式里 `:global(X) .y` 会被编译成只剩 `X`（整条规则落到 html 上，给 html 铺了底色，
 * 导致 body 背景图不再提升到画布，所有 z-index:-1 的玻璃底都被背景图盖住），所以整条选择器都要写在 :global() 里。 */
.rc-row {
  background-color: var(--app-bg-color);
}
.rc-row:hover {
  background-color: color-mix(in srgb, var(--link-active-color) 8%, var(--app-bg-color));
}
:global(html[data-ui-effect="glass"] .rc-row) {
  background-color: var(--glass-inner);
}
:global(html[data-ui-effect="glass"] .rc-row:hover) {
  background-color: color-mix(in srgb, var(--link-active-color) 14%, transparent);
}
</style>
