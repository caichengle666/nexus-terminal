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
const profileSearch = ref('');
const profileGroup = ref('all');

const rdpConnections = computed(() => connections.value.filter(connection => connection.type === 'RDP'));
const profileGroups = computed(() => {
  const groups = new Set<string>();
  rdpConnections.value.forEach(connection => {
    if (connection.tag_ids?.length) {
      connection.tag_ids.forEach(tagId => groups.add(String(tagId)));
    } else {
      groups.add('untagged');
    }
  });
  return [...groups].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
});
const filteredRdpConnections = computed(() => {
  const search = profileSearch.value.trim().toLowerCase();
    return rdpConnections.value.filter(connection => {
    const matchesSearch = !search || [connection.name, connection.host, connection.username]
      .some(value => String(value ?? '').toLowerCase().includes(search));
    const matchesGroup = profileGroup.value === 'all'
      || (profileGroup.value === 'untagged'
        ? !connection.tag_ids?.length
        : connection.tag_ids?.includes(Number(profileGroup.value)));
    return matchesSearch && matchesGroup;
  });
});
const selectedConnection = computed<ConnectionInfo | null>(() => {
  if (selectedConnectionId.value === null) return filteredRdpConnections.value[0] ?? null;
  return filteredRdpConnections.value.find(connection => connection.id === selectedConnectionId.value) ?? filteredRdpConnections.value[0] ?? null;
});

watch(filteredRdpConnections, (nextConnections) => {
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
    <header class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-header px-3 py-2">
      <i class="fas fa-desktop text-text-secondary" aria-hidden="true"></i>
      <label for="workspace-rdp-search" class="sr-only">{{ t('remoteDesktopPane.searchPlaceholder') }}</label>
      <input
        id="workspace-rdp-search"
        v-model="profileSearch"
        type="search"
        class="min-w-0 flex-1 rounded border border-border bg-input px-2 py-1 text-sm text-foreground"
        :placeholder="t('remoteDesktopPane.searchPlaceholder')"
      />
      <label for="workspace-rdp-group" class="sr-only">{{ t('remoteDesktopPane.groupLabel') }}</label>
      <select
        id="workspace-rdp-group"
        v-model="profileGroup"
        class="rounded border border-border bg-input px-2 py-1 text-sm text-foreground"
        :disabled="isLoading || rdpConnections.length === 0"
      >
        <option value="all">{{ t('remoteDesktopPane.allGroups') }}</option>
        <option v-for="group in profileGroups" :key="group" :value="group">
          {{ group === 'untagged' ? t('workspaceConnectionList.untagged') : t('remoteDesktopPane.tagGroup', { id: group }) }}
        </option>
      </select>
      <select
        id="workspace-rdp-connection"
        v-model="selectedConnectionId"
        class="min-w-0 flex-1 rounded border border-border bg-input px-2 py-1 text-sm text-foreground md:max-w-sm"
        :disabled="isLoading || filteredRdpConnections.length === 0"
      >
        <option v-for="connection in filteredRdpConnections" :key="connection.id" :value="connection.id">
          {{ connection.name }} ({{ connection.host }})
        </option>
      </select>
    </header>

    <RemoteDesktopModal
      v-if="selectedConnection"
      :key="selectedConnection.id"
      embedded
      :auto-connect="false"
      :connection="selectedConnection"
      class="min-h-0 flex-1"
    />
    <div v-else class="flex flex-1 items-center justify-center p-4 text-center text-sm text-gray-300">
      {{ t('remoteDesktopPane.empty', '没有可用的 RDP 连接。请先在连接管理中添加一个 RDP 连接。') }}
    </div>
  </section>
</template>
