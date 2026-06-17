<template>
  <div class="p-4 bg-background text-foreground"> <!-- Outer container with padding -->
    <div class="max-w-7xl mx-auto"> <!-- Inner container for max-width (slightly wider for table) and centering -->
      <h1 class="text-xl font-semibold text-foreground mb-4 pb-2 border-b border-border"> <!-- Title styling -->
        {{ $t('auditLog.title') }}
      </h1>

      <!-- Filtering Controls -->
      <div class="flex flex-wrap items-center gap-4 mb-4 p-4 border border-border rounded-lg bg-header/50">
        <div class="flex-grow min-w-[200px]">
          <label for="search-term" class="block text-sm font-medium text-text-secondary mb-1">{{ $t('common.search') }}</label>
          <input type="text" id="search-term" v-model="searchTerm" :placeholder="$t('auditLog.searchPlaceholder')"
                 class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary text-sm">
        </div>
        <div class="flex-grow min-w-[200px]">
          <label for="action-type" class="block text-sm font-medium text-text-secondary mb-1">{{ $t('auditLog.table.actionType') }}</label>
          <select id="action-type" v-model="selectedActionType"
                  class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary appearance-none bg-no-repeat bg-right pr-8 text-sm"
                  style="background-image: url('data:image/svg+xml,%3csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\'%3e%3cpath fill=\'none\' stroke=\'%236c757d\' stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'2\' d=\'M2 5l6 6 6-6\'/%3e%3c/svg%3e'); background-position: right 0.75rem center; background-size: 16px 12px;">
            <option value="">{{ $t('common.all') }}</option>
            <option v-for="type in allActionTypes" :key="type" :value="type">{{ translateActionType(type) }}</option>
          </select>
        </div>
        <div class="self-end">
           <button @click="applyFilters" class="px-4 py-2 bg-button text-button-text rounded hover:bg-button-hover text-sm font-medium">
             {{ $t('common.filter') }}
           </button>
        </div>
      </div>
      <!-- End Filtering Controls -->

      <!-- Error state -->
      <div v-if="store.error" class="p-4 mb-4 border-l-4 border-error bg-error/10 text-error rounded">
        {{ store.error }}
      </div>

      <!-- Loading state (Only show if loading AND logs empty) -->
      <div v-else-if="store.isLoading && logs.length === 0" class="p-4 text-center text-text-secondary italic">
        {{ $t('common.loading') }}
      </div>

      <!-- No logs state (Show only if not loading, no error, and logs empty) -->
      <div v-else-if="!store.isLoading && !store.error && logs.length === 0" class="p-4 mb-4 border-l-4 border-blue-400 bg-blue-100 text-blue-700 rounded">
        {{ $t('auditLog.noLogs') }}
      </div>

      <!-- Table and Pagination (Show if not loading, no error, and logs exist) -->
      <div v-else-if="!store.isLoading && !store.error && logs.length > 0">
          <!-- Pagination Controls -->
          <nav aria-label="Audit Log Pagination" v-if="totalPages > 1" class="mb-4 flex justify-center"> <!-- Removed mt-6, added mb-4 -->
            <ul class="inline-flex items-center -space-x-px">
              <li>
                <a href="#" @click.prevent="changePage(currentPage - 1)"
                   :class="['px-3 py-2 ml-0 leading-tight text-text-secondary bg-background border border-border rounded-l-lg hover:bg-header hover:text-foreground', { 'opacity-50 cursor-not-allowed pointer-events-none': currentPage === 1 }]">
                  &laquo;
                </a>
              </li>
              <li v-for="page in paginationRange" :key="page">
                <a v-if="page !== '...'" href="#" @click.prevent="changePage(page as number)"
                   :class="['px-3 py-2 leading-tight border border-border', page === currentPage ? 'text-button-text bg-button border-button hover:bg-button-hover' : 'text-text-secondary bg-background hover:bg-header hover:text-foreground']">
                  {{ page }}
                </a>
                <span v-else class="px-3 py-2 leading-tight text-text-secondary bg-background border border-border">...</span>
              </li>
              <li>
                <a href="#" @click.prevent="changePage(currentPage + 1)"
                   :class="['px-3 py-2 leading-tight text-text-secondary bg-background border border-border rounded-r-lg hover:bg-header hover:text-foreground', { 'opacity-50 cursor-not-allowed pointer-events-none': currentPage === totalPages }]">
                  &raquo;
                </a>
              </li>
            </ul>
          </nav>
           <div class="text-right text-text-secondary text-sm mb-4"> <!-- Changed text-center to text-right, removed mt-3, added mb-4 -->
              {{ $t('auditLog.paginationInfo', { currentPage, totalPages, totalLogs }) }}
          </div>
          <div class="border border-border rounded-lg overflow-hidden shadow-sm bg-background"> <!-- Removed mt-4 -->
            <div class="overflow-x-auto"> <!-- Allow horizontal scroll -->
              <table class="min-w-full divide-y divide-border text-sm"> <!-- Table styling -->
                <thead class="bg-header">
                  <tr>
                    <th scope="col" class="px-6 py-3 text-left font-medium text-text-secondary tracking-wider whitespace-nowrap">{{ $t('auditLog.table.timestamp') }}</th>
                    <th scope="col" class="px-6 py-3 text-left font-medium text-text-secondary tracking-wider whitespace-nowrap">{{ $t('auditLog.table.actionType') }}</th>
                    <th scope="col" class="px-6 py-3 text-left font-medium text-text-secondary tracking-wider">{{ $t('auditLog.table.details') }}</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-border">
                  <tr v-for="log in logs" :key="log.id" class="hover:bg-header/50"> <!-- Table rows with hover -->
                    <td class="px-6 py-4 whitespace-nowrap">{{ formatTimestamp(log.timestamp) }}</td>
                    <td class="px-6 py-4 whitespace-nowrap">{{ translateActionType(log.action_type) }}</td>
                    <td class="px-6 py-4">
                      <pre v-if="log.details" class="whitespace-pre-wrap break-all bg-header/50 p-2 border border-border/50 rounded text-xs font-mono max-h-40 overflow-y-auto">{{ formatDetails(log.details) }}</pre> <!-- Details pre styling -->
                      <span v-else class="text-text-secondary">-</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
</div>
      </div>
    </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'; // Removed watch
import { useAuditLogStore } from '../stores/audit.store';
import { AuditLogEntry, AuditLogActionType } from '../types/server.types';
import { useI18n } from 'vue-i18n';
// Removed lodash-es import

const store = useAuditLogStore();
const { t } = useI18n();

// --- Filtering State ---
const searchTerm = ref('');
const selectedActionType = ref<AuditLogActionType | ''>(''); // Allow empty string for 'All'

// Define all possible action types for the dropdown
const allActionTypes: AuditLogActionType[] = [
    'LOGIN_SUCCESS', 'LOGIN_FAILURE', 'LOGOUT', 'PASSWORD_CHANGED',
    '2FA_ENABLED', '2FA_DISABLED',
    'CONNECTION_CREATED', 'CONNECTION_UPDATED', 'CONNECTION_DELETED',
    'PROXY_CREATED', 'PROXY_UPDATED', 'PROXY_DELETED',
    'TAG_CREATED', 'TAG_UPDATED', 'TAG_DELETED',
    'SETTINGS_UPDATED', 'IP_WHITELIST_UPDATED',
    'NOTIFICATION_SETTING_CREATED', 'NOTIFICATION_SETTING_UPDATED', 'NOTIFICATION_SETTING_DELETED',
    // SSH Actions
    'SSH_CONNECT_SUCCESS', 'SSH_CONNECT_FAILURE', 'SSH_SHELL_FAILURE',
    // System/Error
    'DATABASE_MIGRATION', 'ADMIN_SETUP_COMPLETE'
];

const logs = computed(() => store.logs);
const totalLogs = computed(() => store.totalLogs);
const currentPage = computed(() => store.currentPage);
const logsPerPage = computed(() => store.logsPerPage);

const totalPages = computed(() => Math.ceil(totalLogs.value / logsPerPage.value));

// Function to apply filters and fetch logs
const applyFilters = () => {
    // Pass undefined if filter is empty, otherwise pass the value
    store.fetchLogs({
        page: 1, // Reset to page 1 when applying filters
        searchTerm: searchTerm.value || undefined,
        actionType: selectedActionType.value || undefined
    });
};

// Removed watch for filters

onMounted(() => {
  // Fetch initial logs without filters
  store.fetchLogs();
});

const formatTimestamp = (timestamp: number): string => {
  // Convert seconds to milliseconds for Date constructor
  return new Date(timestamp * 1000).toLocaleString();
};

const translateActionType = (actionType: AuditLogActionType): string => {
    // Attempt to translate using a convention like auditLog.actions.ACTION_TYPE
    const key = `auditLog.actions.${actionType}`;
    const translated = t(key);
    // If translation is missing, return the original type
    return translated === key ? actionType : translated;
};

const formatDetails = (details: AuditLogEntry['details']): string => {
  if (!details) return '';
  if (typeof details === 'object' && details !== null) {
    if ('raw' in details && details.parseError) {
        return `[Parse Error] Raw: ${details.raw}`;
    }
    return JSON.stringify(details, null, 2); // Pretty print JSON
  }
  return String(details); // Should ideally not happen if backend sends JSON string
};

const changePage = (page: number) => {
  if (page >= 1 && page <= totalPages.value && page !== currentPage.value) {
    // Retain current filters when changing page
    store.fetchLogs({
        page: page,
        searchTerm: searchTerm.value || undefined,
        actionType: selectedActionType.value || undefined
    });
  }
};

// Simple pagination range logic (can be improved for many pages)
const paginationRange = computed(() => {
    const range: (number | string)[] = [];
    const delta = 2; // Number of pages around current page
    const left = currentPage.value - delta;
    const right = currentPage.value + delta + 1;
    let l: number | null = null; // Keep track of the last number added

    for (let i = 1; i <= totalPages.value; i++) {
        if (i === 1 || i === totalPages.value || (i >= left && i < right)) {
            range.push(i);
        }
    }

    const result: (number | string)[] = [];
    for (const pageNum of range) {
         // Ensure pageNum is treated as number for comparison/arithmetic
        const currentNum = pageNum as number;
        if (l !== null) {
            // Calculate difference explicitly as numbers
            if (currentNum - l === 2) {
                result.push(l + 1);
            } else if (currentNum - l > 1) { // Check if difference is greater than 1
                result.push('...');
            }
        }
        result.push(currentNum);
        l = currentNum; // Store the current number
    }
    return result;
});

</script>

<style scoped>
/* Remove all scoped styles as they are now handled by Tailwind utility classes */
</style>
