import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import apiClient from '../../utils/apiClient';
import { isAxiosError } from 'axios';

export function useExportConnections() {
  const { t } = useI18n();

  const exportConnectionsLoading = ref(false);
  const exportConnectionsMessage = ref('');
  const exportConnectionsSuccess = ref(false);
  // 导出需要当前密码 (step-up)，ZIP 用用户自定义的密码加密
  const exportCurrentPassword = ref('');
  const exportPassphrase = ref('');
  const exportPassphraseConfirm = ref('');
  const MIN_EXPORT_PASSPHRASE_LENGTH = 8;

  const handleExportConnections = async () => {
    exportConnectionsMessage.value = '';
    exportConnectionsSuccess.value = false;
    if (exportPassphrase.value.length < MIN_EXPORT_PASSPHRASE_LENGTH) {
      exportConnectionsMessage.value = t('settings.exportConnections.passphraseTooShort', { min: MIN_EXPORT_PASSPHRASE_LENGTH });
      return;
    }
    if (exportPassphrase.value !== exportPassphraseConfirm.value) {
      exportConnectionsMessage.value = t('settings.exportConnections.passphraseMismatch');
      return;
    }
    exportConnectionsLoading.value = true;
    try {
      const response = await apiClient.post('/connections/export', {
        currentPassword: exportCurrentPassword.value,
        passphrase: exportPassphrase.value,
      }, {
        responseType: 'blob',
      });
      exportCurrentPassword.value = '';
      exportPassphrase.value = '';
      exportPassphraseConfirm.value = '';

      let filename = 'nexus_connections_export.zip';
      const dispositionHeader = response.headers['content-disposition'];
      const disposition = typeof dispositionHeader === 'string' ? dispositionHeader : '';
      if (disposition && disposition.includes('attachment')) {
        const filenameRegex = /filename[^;=\n]*=(?:(['"])(.*?)\1|([^;\n]*))/;
        const matches = filenameRegex.exec(disposition);
        if (matches != null && (matches[2] || matches[3])) {
          filename = matches[2] || matches[3];
        }
      }

      const contentTypeHeader = response.headers['content-type'];
      const contentType = typeof contentTypeHeader === 'string' ? contentTypeHeader : 'application/zip';
      const blob = new Blob([response.data], { type: contentType });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);

      exportConnectionsMessage.value = t('settings.exportConnections.success', '导出成功。文件已开始下载。');
      exportConnectionsSuccess.value = true;
    } catch (error: any) {
      console.error('导出连接失败:', error);
      let message = t('settings.exportConnections.error', '导出连接时发生错误。');
      if (isAxiosError(error) && error.response && error.response.data) {
          if (error.response.data instanceof Blob && error.response.data.type === 'application/json') {
              try {
                  const errorJson = JSON.parse(await error.response.data.text());
                  message = errorJson.message || message;
              } catch (e) { /* Blob not valid JSON */ }
          } else if (typeof error.response.data === 'string') {
              message = error.response.data;
          } else if (error.response.data && typeof error.response.data.message === 'string') {
              message = error.response.data.message;
          }
      } else if (error.message) {
          message = error.message;
      }
      exportConnectionsMessage.value = message;
      exportConnectionsSuccess.value = false;
    } finally {
      exportConnectionsLoading.value = false;
    }
  };

  return {
    exportConnectionsLoading,
    exportConnectionsMessage,
    exportConnectionsSuccess,
    exportCurrentPassword,
    exportPassphrase,
    exportPassphraseConfirm,
    handleExportConnections,
  };
}
