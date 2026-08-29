<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';

type LocalSystemStatus = {
  platform: string;
  hostname: string;
  cpuModel: string;
  cpuPercent: number;
  memoryTotal: number;
  memoryUsed: number;
  uptimeSeconds: number;
};

type LocalProcess = {
  pid: number;
  name: string;
  cpu: number;
  memory: number;
};

const { t } = useI18n();
const status = ref<LocalSystemStatus | null>(null);
const processes = ref<LocalProcess[]>([]);
const error = ref<string | null>(null);
const loading = ref(false);
let refreshTimer: number | null = null;

const electronApi = () => (window as any).electronAPI;
const isDesktop = computed(() => Boolean(electronApi()?.getLocalSystemStatus && electronApi()?.getLocalProcesses));
const memoryPercent = computed(() => {
  if (!status.value?.memoryTotal) return 0;
  return Math.round(status.value.memoryUsed / status.value.memoryTotal * 100);
});
const displayedProcesses = computed(() => [...processes.value]
  .sort((left, right) => right.cpu - left.cpu || right.memory - left.memory)
  .slice(0, 50));

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, index);
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
};

const formatUptime = (seconds: number) => {
  const totalMinutes = Math.floor(seconds / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor(totalMinutes % 1440 / 60);
  const minutes = totalMinutes % 60;
  return days > 0 ? `${days}d ${hours}h` : `${hours}h ${minutes}m`;
};

const refresh = async () => {
  if (!isDesktop.value || loading.value) return;
  loading.value = true;
  error.value = null;
  try {
    const [nextStatus, nextProcesses] = await Promise.all([
      electronApi().getLocalSystemStatus(),
      electronApi().getLocalProcesses(),
    ]);
    status.value = nextStatus;
    processes.value = Array.isArray(nextProcesses) ? nextProcesses : [];
  } catch (reason: any) {
    error.value = reason?.message || String(reason);
  } finally {
    loading.value = false;
  }
};

onMounted(() => {
  void refresh();
  refreshTimer = window.setInterval(refresh, 3000);
});

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<template>
  <section class="flex h-full min-h-0 flex-col bg-background text-foreground">
    <header class="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-header px-3 py-2">
      <div class="min-w-0">
        <h3 class="truncate text-sm font-semibold">{{ t('layout.pane.localSystem', '本机监控') }}</h3>
        <p v-if="status" class="truncate text-xs text-text-secondary">{{ status.hostname }} · {{ status.platform }}</p>
      </div>
      <button
        type="button"
        class="p-1 text-text-secondary hover:text-foreground disabled:opacity-50"
        :disabled="loading || !isDesktop"
        :title="t('common.refresh', '刷新')"
        @click="refresh"
      >
        <i :class="['fas fa-sync-alt', { 'fa-spin': loading }]"></i>
      </button>
    </header>

    <div v-if="!isDesktop" class="flex flex-1 items-center justify-center p-4 text-center text-sm text-text-secondary">
      {{ t('localSystem.desktopOnly', '本机监控仅在 Nexus 桌面端可用。') }}
    </div>
    <div v-else-if="error" class="flex flex-1 items-center justify-center p-4 text-center text-sm text-red-500">
      {{ error }}
    </div>
    <div v-else class="min-h-0 flex-1 overflow-y-auto p-3">
      <div v-if="status" class="grid grid-cols-2 gap-3 text-sm">
        <div class="border border-border bg-background-alt p-2">
          <div class="mb-1 flex justify-between text-xs text-text-secondary"><span>CPU</span><span>{{ status.cpuPercent }}%</span></div>
          <div class="h-1.5 bg-border"><div class="h-full bg-blue-500" :style="{ width: `${status.cpuPercent}%` }"></div></div>
        </div>
        <div class="border border-border bg-background-alt p-2">
          <div class="mb-1 flex justify-between text-xs text-text-secondary"><span>{{ t('statusMonitor.memoryLabel', '内存') }}</span><span>{{ memoryPercent }}%</span></div>
          <div class="h-1.5 bg-border"><div class="h-full bg-green-500" :style="{ width: `${memoryPercent}%` }"></div></div>
          <p class="mt-1 text-xs text-text-secondary">{{ formatBytes(status.memoryUsed) }} / {{ formatBytes(status.memoryTotal) }}</p>
        </div>
        <div class="col-span-2 border border-border bg-background-alt p-2 text-xs text-text-secondary">
          <p class="truncate" :title="status.cpuModel">{{ status.cpuModel }}</p>
          <p class="mt-1">{{ t('localSystem.uptime', '运行时间') }}: {{ formatUptime(status.uptimeSeconds) }}</p>
        </div>
      </div>

      <div class="mt-4 min-h-0">
        <h4 class="mb-2 text-sm font-semibold">{{ t('localSystem.processes', '进程') }}</h4>
        <div class="overflow-x-auto border border-border text-xs">
          <table class="w-full min-w-[420px] border-collapse">
            <thead class="bg-header text-left text-text-secondary">
              <tr><th class="px-2 py-1.5">PID</th><th class="px-2 py-1.5">{{ t('localSystem.processName', '名称') }}</th><th class="px-2 py-1.5 text-right">CPU</th><th class="px-2 py-1.5 text-right">{{ t('statusMonitor.memoryLabel', '内存') }}</th></tr>
            </thead>
            <tbody>
              <tr v-for="process in displayedProcesses" :key="process.pid" class="border-t border-border">
                <td class="px-2 py-1.5 font-mono text-text-secondary">{{ process.pid }}</td>
                <td class="max-w-0 truncate px-2 py-1.5" :title="process.name">{{ process.name }}</td>
                <td class="px-2 py-1.5 text-right font-mono">{{ process.cpu.toFixed(1) }}%</td>
                <td class="px-2 py-1.5 text-right font-mono">{{ formatBytes(process.memory) }}</td>
              </tr>
              <tr v-if="!loading && displayedProcesses.length === 0"><td colspan="4" class="px-2 py-4 text-center text-text-secondary">{{ t('localSystem.noProcesses', '没有可显示的进程。') }}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </section>
</template>
