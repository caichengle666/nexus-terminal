<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { useConnectionsStore, type ConnectionInfo } from '../stores/connections.store';
import RemoteDesktopModal from './RemoteDesktopModal.vue';

const { t } = useI18n();
const connectionsStore = useConnectionsStore();
const { connections, isLoading } = storeToRefs(connectionsStore);
const selectedConnectionId = ref<number | null>(null);

const rdpConnections = computed(() => connections.value.filter(connection => connection.type === 'RDP'));
const selectedConnection = computed<ConnectionInfo | null>(() => {
  if (selectedConnectionId.value === null) return rdpConnections.value[0] ?? null;
  return rdpConnections.value.find(connection => connection.id === selectedConnectionId.value) ?? rdpConnections.value[0] ?? null;
});

watch(rdpConnections, (nextConnections) => {
  if (!nextConnections.some(connection => connection.id === selectedConnectionId.value)) {
    selectedConnectionId.value = nextConnections[0]?.id ?? null;
  }
}, { immediate: true });

onMounted(() => {
  if (connections.value.length === 0) {
    void connectionsStore.fetchConnections();
  }
});
</script>

<template>
  <section class="flex h-full min-h-0 flex-col bg-black">
    <header class="flex shrink-0 items-center gap-2 border-b border-border bg-header px-3 py-2">
      <i class="fas fa-desktop text-text-secondary" aria-hidden="true"></i>
      <label for="workspace-rdp-connection" class="sr-only">{{ t('layout.pane.remoteDesktop', '远程桌面') }}</label>
      <select
        id="workspace-rdp-connection"
        v-model="selectedConnectionId"
        class="min-w-0 flex-1 rounded border border-border bg-input px-2 py-1 text-sm text-foreground"
        :disabled="isLoading || rdpConnections.length === 0"
      >
        <option v-for="connection in rdpConnections" :key="connection.id" :value="connection.id">
          {{ connection.name }} ({{ connection.host }})
        </option>
      </select>
    </header>

    <RemoteDesktopModal
      v-if="selectedConnection"
      :key="selectedConnection.id"
      embedded
      :connection="selectedConnection"
      class="min-h-0 flex-1"
    />
    <div v-else class="flex flex-1 items-center justify-center p-4 text-center text-sm text-gray-300">
      {{ t('remoteDesktopPane.empty', '没有可用的 RDP 连接。请先在连接管理中添加一个 RDP 连接。') }}
    </div>
  </section>
</template>
