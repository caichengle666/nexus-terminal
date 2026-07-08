<template>
  <div v-if="settings" class="bg-background border border-border rounded-lg shadow-sm overflow-hidden">
    <h2 class="text-lg font-semibold text-foreground px-6 py-4 border-b border-border bg-header/50">
      {{ t('settings.category.dataManagement', '数据管理') }}
    </h2>
    <div class="p-6 space-y-6">
      <!-- Export Connections Section -->
      <div class="settings-section-content">
         <h3 class="text-base font-semibold text-foreground mb-3">{{ t('settings.exportConnections.title', '导出连接数据') }}</h3>
         <p class="text-sm text-text-secondary mb-4">
           <span class="font-semibold text-warning">{{ t('settings.exportConnections.decryptKeyInfo', '解压密码为您的 data/.env 文件中的 ENCRYPTION_KEY。请妥善保管此文件。') }}</span>
         </p>
         <form @submit.prevent="handleExportConnections" class="space-y-4">
           <div class="flex items-center justify-between">
              <button type="submit" :disabled="exportConnectionsLoading"
                      class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed transition duration-150 ease-in-out text-sm font-medium inline-flex items-center">
                <svg v-if="exportConnectionsLoading" class="animate-spin -ml-1 mr-2 h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                {{ exportConnectionsLoading ? t('common.loading') : t('settings.exportConnections.buttonText', '开始导出') }}
              </button>
              <p v-if="exportConnectionsMessage" :class="['text-sm', exportConnectionsSuccess ? 'text-success' : 'text-error']">{{ exportConnectionsMessage }}</p>
           </div>
         </form>
      </div>

      <!-- Import Connections Section -->
      <div class="settings-section-content border-t border-border/40 pt-6">
         <h3 class="text-base font-semibold text-foreground mb-3">{{ t('settings.importConnections.title', '导入连接数据') }}</h3>
         <p class="text-sm text-text-secondary mb-4">
           {{ t('settings.importConnections.description', '选择之前导出的 JSON 文件来导入连接。支持同一格式的文件导入。') }}
         </p>
         <form @submit.prevent="handleImportConnections" class="space-y-4">
           <div class="flex items-center gap-3">
             <input
               id="importFileInput"
               type="file"
               accept=".json"
               @change="handleFileSelect"
               class="flex-grow min-w-0 text-sm text-text-secondary file:mr-3 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-button-text file:bg-button hover:file:bg-button-hover file:cursor-pointer file:transition file:duration-150"
             />
             <button type="submit" :disabled="importConnectionsLoading || !selectedFile"
                     class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed transition duration-150 ease-in-out text-sm font-medium inline-flex items-center whitespace-nowrap">
               <svg v-if="importConnectionsLoading" class="animate-spin -ml-1 mr-2 h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                 <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                 <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
               </svg>
               {{ importConnectionsLoading ? t('common.loading') : t('settings.importConnections.buttonText', '开始导入') }}
             </button>
           </div>
           <p v-if="importConnectionsMessage" :class="['text-sm', importConnectionsSuccess ? 'text-success' : 'text-error']">{{ importConnectionsMessage }}</p>
         </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useSettingsStore } from '../../stores/settings.store';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { useExportConnections } from '../../composables/settings/useExportConnections';
import { useImportConnections } from '../../composables/settings/useImportConnections';

const settingsStore = useSettingsStore();
const { settings } = storeToRefs(settingsStore);
const { t } = useI18n();

const {
  exportConnectionsLoading,
  exportConnectionsMessage,
  exportConnectionsSuccess,
  handleExportConnections,
} = useExportConnections();

const {
  importConnectionsLoading,
  importConnectionsMessage,
  importConnectionsSuccess,
  selectedFile,
  handleFileSelect,
  handleImportConnections,
} = useImportConnections();
</script>
