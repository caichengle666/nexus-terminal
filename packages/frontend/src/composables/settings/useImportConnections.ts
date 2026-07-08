import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import apiClient from '../../utils/apiClient';
import { isAxiosError } from 'axios';

export function useImportConnections() {
  const { t } = useI18n();

  const importConnectionsLoading = ref(false);
  const importConnectionsMessage = ref('');
  const importConnectionsSuccess = ref(false);
  const selectedFile = ref<File | null>(null);

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

      const response = await apiClient.post('/connections/import', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      const data = response.data;
      if (data.failureCount && data.failureCount > 0) {
        importConnectionsMessage.value = t('settings.importConnections.partialSuccess', { success: data.successCount, failure: data.failureCount });
        importConnectionsSuccess.value = false;
      } else {
        importConnectionsMessage.value = t('settings.importConnections.success', { count: data.successCount });
        importConnectionsSuccess.value = true;
      }

      selectedFile.value = null;
      const fileInput = document.getElementById('importFileInput') as HTMLInputElement;
      if (fileInput) fileInput.value = '';
    } catch (error: any) {
      console.error('导入连接失败:', error);
      let message = t('settings.importConnections.error');
      if (isAxiosError(error) && error.response && error.response.data) {
        if (typeof error.response.data === 'string') {
          message = error.response.data;
        } else if (error.response.data && typeof error.response.data.message === 'string') {
          message = error.response.data.message;
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
    handleFileSelect,
    handleImportConnections,
  };
}
