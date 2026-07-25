<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import logoUrl from '../assets/logo.png';

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

const props = withDefaults(defineProps<{
  pageTitle: string;
  sessionName?: string;
  connectionStatus?: ConnectionStatus;
  isAuthenticated?: boolean;
}>(), {
  sessionName: '',
  connectionStatus: 'disconnected',
  isAuthenticated: false,
});

const emit = defineEmits<{
  (event: 'customize-style'): void;
  (event: 'logout'): void;
}>();

const { t } = useI18n();
const route = useRoute();
const menuOpen = ref(false);

const navigationItems = computed(() => [
  { to: '/', label: t('nav.dashboard'), icon: 'fas fa-th-large' },
  { to: '/workspace', label: t('nav.terminal'), icon: 'fas fa-terminal' },
  { to: '/connections', label: t('nav.connections'), icon: 'fas fa-server' },
  { to: '/proxies', label: t('nav.proxies'), icon: 'fas fa-random' },
  { to: '/notifications', label: t('nav.notifications'), icon: 'fas fa-bell' },
  { to: '/audit-logs', label: t('nav.auditLogs'), icon: 'fas fa-clipboard-list' },
  { to: '/settings', label: t('nav.settings'), icon: 'fas fa-cog' },
]);

const statusLabel = computed(() => {
  if (props.connectionStatus === 'connected') return '已连接';
  if (props.connectionStatus === 'connecting') return '连接中';
  if (props.connectionStatus === 'error') return '连接异常';
  return '已断开';
});

const statusClass = computed(() => {
  if (props.connectionStatus === 'connected') return 'bg-success';
  if (props.connectionStatus === 'connecting') return 'animate-pulse bg-warning';
  if (props.connectionStatus === 'error') return 'bg-error';
  return 'bg-text-secondary';
});

const closeMenu = () => {
  menuOpen.value = false;
};

const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') closeMenu();
};

watch(() => route.fullPath, closeMenu);
onMounted(() => window.addEventListener('keydown', handleKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', handleKeydown));
</script>

<template>
  <header class="mobile-app-header sticky top-0 z-30 border-b border-border bg-header text-foreground shadow-sm">
    <div class="mobile-app-header__row flex h-12 min-w-0 items-center gap-2 px-2">
      <RouterLink to="/" class="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded hover:bg-hover" :aria-label="t('nav.dashboard')">
        <img :src="logoUrl" alt="" class="h-8 w-8 object-contain" />
      </RouterLink>

      <div class="min-w-0 flex-1 leading-tight">
        <div class="truncate text-sm font-semibold">{{ pageTitle }}</div>
        <div v-if="sessionName" class="mt-0.5 truncate text-[11px] text-text-secondary" :title="sessionName">{{ sessionName }}</div>
      </div>

      <div v-if="sessionName" class="flex h-11 flex-shrink-0 items-center gap-1.5 px-1.5 text-[11px] text-text-secondary" :title="statusLabel">
        <span class="h-2 w-2 rounded-full" :class="statusClass" aria-hidden="true" />
        <span class="sr-only">{{ statusLabel }}</span>
      </div>

      <button
        type="button"
        class="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded text-text-secondary hover:bg-hover hover:text-foreground"
        title="更多"
        aria-label="更多"
        aria-haspopup="menu"
        :aria-expanded="menuOpen"
        @click="menuOpen = !menuOpen"
      >
        <i class="fas fa-ellipsis-v" aria-hidden="true" />
      </button>
    </div>

    <div v-if="menuOpen" class="fixed inset-0 z-40 bg-black/30" aria-hidden="true" @click="closeMenu" />
    <div v-if="menuOpen" class="absolute right-2 top-full z-50 mt-1 w-64 overflow-hidden rounded border border-border bg-background py-1 shadow-2xl" role="menu">
      <RouterLink
        v-for="item in navigationItems"
        :key="item.to"
        :to="item.to"
        role="menuitem"
        class="flex min-h-11 items-center gap-3 px-3 py-2 text-sm text-foreground hover:bg-hover"
        active-class="bg-primary/15 text-primary"
        @click="closeMenu"
      >
        <i :class="[item.icon, 'w-5 text-center text-text-secondary']" aria-hidden="true" />
        <span>{{ item.label }}</span>
      </RouterLink>

      <div class="my-1 border-t border-border" />
      <button type="button" role="menuitem" class="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-hover" @click="emit('customize-style'); closeMenu()">
        <i class="fas fa-paint-brush w-5 text-center text-text-secondary" aria-hidden="true" />
        <span>{{ t('nav.customizeStyle') }}</span>
      </button>
      <button
        v-if="isAuthenticated"
        type="button"
        role="menuitem"
        class="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left text-sm text-error hover:bg-error/10"
        @click="emit('logout'); closeMenu()"
      >
        <i class="fas fa-sign-out-alt w-5 text-center" aria-hidden="true" />
        <span>{{ t('nav.logout') }}</span>
      </button>
      <RouterLink v-else to="/login" role="menuitem" class="flex min-h-11 items-center gap-3 px-3 py-2 text-sm text-foreground hover:bg-hover" @click="closeMenu">
        <i class="fas fa-sign-in-alt w-5 text-center text-text-secondary" aria-hidden="true" />
        <span>{{ t('nav.login') }}</span>
      </RouterLink>
    </div>
  </header>
</template>

<style scoped>
.mobile-app-header {
  padding-top: env(safe-area-inset-top);
  -webkit-app-region: drag;
  user-select: none;
}

.mobile-app-header a,
.mobile-app-header button {
  -webkit-app-region: no-drag;
}
</style>
