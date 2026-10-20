import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import apiClient from '../../utils/apiClient';
import { isAxiosError } from 'axios';
import { useConnectionsStore } from '../../stores/connections.store';
import { useTagsStore } from '../../stores/tags.store';

interface ImportErrorItem {
  connectionName?: string;
  message: string;
}

const MAX_LISTED_ERRORS = 5;

export function useImportConnections() {
  const { t } = useI18n();
  const connectionsStore = useConnectionsStore();
  const tagsStore = useTagsStore();

  // 将后端返回的 errors[] 格式化为前几条 "名称: 原因"
  const formatImportErrors = (errors: unknown): string => {
    if (!Array.isArray(errors) || errors.length === 0) return '';
    const items = (errors as ImportErrorItem[]).filter(e => e && typeof e.message === 'string');
    const lines = items.slice(0, MAX_LISTED_ERRORS).map(e => (e.connectionName ? `${e.connectionName}: ${e.message}` : e.message));
    if (items.length > MAX_LISTED_ERRORS) {
      lines.push(t('uxConn.importMoreErrors', { count: items.length - MAX_LISTED_ERRORS }));
    }
    return lines.join('\n');
  };

  // 导入后标签可能新建、连接已变化：清除缓存并重新获取
  const refreshStoresAfterImport = async () => {
    localStorage.removeItem('connectionsCache');
    localStorage.removeItem('tagsCache');
    await Promise.allSettled([connectionsStore.fetchConnections(), tagsStore.fetchTags()]);
  };

  const importConnectionsLoading = ref(false);
  const importConnectionsMessage = ref('');
  const importConnectionsSuccess = ref(false);
  const selectedFile = ref<File | null>(null);
  // 加密 ZIP 导出文件的密码 (导入明文 JSON 时可留空)
  const importPassphrase = ref('');

  const handleFileSelect = (event: Event) => {
    const target = event.target as HTMLInputElement;
    if (target.files && target.files.length > 0) {
      selectedFile.value = target.files[0];
      importConnectionsMessage.value = '';
    }
  };

  const handleImportConnections = async () => {
    if (!selectedFile.value) {
      importConnectionsMessage.value = t('settings.importConnections.noFile');
      importConnectionsSuccess.value = false;
      return;
    }

    importConnectionsLoading.value = true;
    importConnectionsMessage.value = '';
    importConnectionsSuccess.value = false;

    try {
      const formData = new FormData();
      formData.append('connectionsFile', selectedFile.value);
      if (importPassphrase.value) formData.append('passphrase', importPassphrase.value);

      const response = await apiClient.post('/connections/import', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      const data = response.data;
      const errorDetails = formatImportErrors(data.errors);
      if (data.failureCount && data.failureCount > 0) {
        importConnectionsMessage.value = t('settings.importConnections.partialSuccess', { success: data.successCount, failure: data.failureCount });
        importConnectionsSuccess.value = false;
      } else {
        importConnectionsMessage.value = t('settings.importConnections.success', { count: data.successCount });
        importConnectionsSuccess.value = true;
      }
      if (errorDetails) {
        importConnectionsMessage.value += `\n${errorDetails}`;
      }
      if (data.successCount > 0) {
        await refreshStoresAfterImport();
      }

      selectedFile.value = null;
      importPassphrase.value = '';
      const fileInput = document.getElementById('importFileInput') as HTMLInputElement;
      if (fileInput) fileInput.value = '';
    } catch (error: any) {
      console.error('导入连接失败:', error);
      let message = t('settings.importConnections.error');
      if (isAxiosError(error) && error.response && error.response.data) {
        const data = error.response.data;
        if (typeof data === 'string') {
          message = data;
        } else if (typeof data.failureCount === 'number' && data.failureCount > 0) {
          // 部分失败时后端返回 400，同时包含 successCount / errors
          const successCount = typeof data.successCount === 'number' ? data.successCount : 0;
          message = t('settings.importConnections.partialSuccess', { success: successCount, failure: data.failureCount });
          const errorDetails = formatImportErrors(data.errors);
          if (errorDetails) message += `\n${errorDetails}`;
          if (successCount > 0) {
            selectedFile.value = null;
            const fileInput = document.getElementById('importFileInput') as HTMLInputElement;
            if (fileInput) fileInput.value = '';
            await refreshStoresAfterImport();
          }
        } else if (data.code === 'IMPORT_PASSPHRASE_INVALID') {
          message = t('settings.importConnections.passphraseInvalid');
        } else if (typeof data.message === 'string') {
          message = data.message;
        }
      } else if (error.message) {
        message = error.message;
      }
      importConnectionsMessage.value = message;
      importConnectionsSuccess.value = false;
    } finally {
      importConnectionsLoading.value = false;
    }
  };

  return {
    importConnectionsLoading,
    importConnectionsMessage,
    importConnectionsSuccess,
    selectedFile,
    importPassphrase,
    handleFileSelect,
    handleImportConnections,
  };
}
