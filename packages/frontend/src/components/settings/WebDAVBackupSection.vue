<template>
  <div class="bg-background border border-border rounded-lg shadow-sm overflow-hidden">
    <h2 class="text-lg font-semibold text-foreground px-6 py-4 border-b border-border bg-header/50">
      {{ $t('settings.webdavBackup.title', 'WebDAV 备份') }}
    </h2>
    <div class="p-6 space-y-6">
      <!-- Configuration Form -->
      <div class="settings-section-content">
        <h3 class="text-base font-semibold text-foreground mb-3">
          {{ configured ? $t('settings.webdavBackup.configTitle', '备份服务器配置') : $t('settings.webdavBackup.setupTitle', '配置备份服务器') }}
        </h3>
        <p v-if="configured" class="text-sm text-text-secondary mb-2">
          {{ $t('settings.webdavBackup.configuredHint', '已连接到:') }} {{ configUrl }}
        </p>
        <form @submit.prevent="handleSaveConfig" class="space-y-4">
          <div class="grid grid-cols-1 gap-4">
            <div>
              <label class="block text-sm font-medium text-foreground mb-1">{{ $t('settings.webdavBackup.url', '服务器地址') }}</label>
              <input v-model="form.url" type="url" placeholder="https://example.com/dav/"
                     class="w-full px-3 py-2 border border-border rounded-md bg-input text-foreground focus:outline-none focus:ring-2 focus:ring-primary text-sm"
                     :disabled="saving" />
            </div>
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label class="block text-sm font-medium text-foreground mb-1">{{ $t('settings.webdavBackup.username', '用户名') }}</label>
                <input v-model="form.username" type="text" autocomplete="off"
                       class="w-full px-3 py-2 border border-border rounded-md bg-input text-foreground focus:outline-none focus:ring-2 focus:ring-primary text-sm"
                       :disabled="saving" />
              </div>
              <div>
                <label class="block text-sm font-medium text-foreground mb-1">{{ $t('settings.webdavBackup.password', '密码') }}</label>
                <input v-model="form.password" type="password" autocomplete="new-password"
                       class="w-full px-3 py-2 border border-border rounded-md bg-input text-foreground focus:outline-none focus:ring-2 focus:ring-primary text-sm"
                       :disabled="saving" />
              </div>
            </div>
          </div>
          <div class="flex items-center space-x-3">
            <button type="submit" :disabled="saving || !form.url || !form.username || !form.password"
                    class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed transition duration-150 ease-in-out text-sm font-medium inline-flex items-center">
              <svg v-if="saving" class="animate-spin -ml-1 mr-2 h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              {{ saving ? $t('common.saving', '保存中...') : (configured ? $t('settings.webdavBackup.saveAndTest', '保存并测试连接') : $t('settings.webdavBackup.saveAndTest', '保存并测试连接')) }}
            </button>
            <button v-if="configured" type="button" @click="handleDeleteConfig" :disabled="saving"
                    class="px-4 py-2 bg-error/10 text-error rounded-md hover:bg-error/20 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-error disabled:opacity-50 transition text-sm font-medium">
              {{ $t('settings.webdavBackup.disconnect', '断开连接') }}
            </button>
            <button v-if="configured" type="button" @click="handleTestConnection" :disabled="testing"
                    class="px-4 py-2 bg-muted text-foreground rounded-md hover:bg-muted/80 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50 transition text-sm font-medium">
              {{ testing ? $t('common.testing', '测试中...') : $t('settings.webdavBackup.testConnection', '测试连接') }}
            </button>
          </div>
          <p v-if="configMessage" :class="['text-sm', configSuccess ? 'text-success' : 'text-error']">{{ configMessage }}</p>
        </form>
      </div>

      <!-- Backup Operations -->
      <template v-if="configured">
        <hr class="border-border/50" />
        <div class="settings-section-content">
          <h3 class="text-base font-semibold text-foreground mb-3">{{ $t('settings.webdavBackup.backupTitle', '备份操作') }}</h3>
          <div class="flex items-center space-x-3 mb-4">
            <button @click="handleCreateBackup" :disabled="backingUp"
                    class="px-4 py-2 bg-primary text-white rounded-md shadow-sm hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed transition duration-150 ease-in-out text-sm font-medium inline-flex items-center">
              <svg v-if="backingUp" class="animate-spin -ml-1 mr-2 h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              {{ backingUp ? $t('common.backingUp', '备份中...') : $t('settings.webdavBackup.createBackup', '创建备份') }}
            </button>
            <button @click="handleRefreshList" :disabled="loadingList"
                    class="px-4 py-2 bg-muted text-foreground rounded-md hover:bg-muted/80 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50 transition text-sm font-medium">
              {{ $t('common.refresh', '刷新列表') }}
            </button>
          </div>
          <p v-if="backupMessage" :class="['text-sm mb-3', backupSuccess ? 'text-success' : 'text-error']">{{ backupMessage }}</p>

          <!-- Backup List -->
          <div v-if="backupList.length > 0" class="border border-border rounded-md divide-y divide-border">
            <div v-for="file in backupList" :key="file.name" class="flex items-center justify-between px-4 py-3 text-sm">
              <div class="flex-1 min-w-0">
                <p class="text-foreground truncate">{{ file.name }}</p>
                <p class="text-text-secondary text-xs mt-0.5">
                  {{ formatSize(file.size) }} &middot; {{ file.lastModified }}
                </p>
              </div>
              <div class="flex items-center space-x-2 ml-4 flex-shrink-0">
                <button @click="handleRestoreBackup(file.name)" :disabled="restoring"
                        class="px-3 py-1.5 bg-primary/10 text-primary rounded hover:bg-primary/20 focus:outline-none transition text-xs font-medium disabled:opacity-50">
                  {{ $t('settings.webdavBackup.restore', '恢复') }}
                </button>
                <button @click="handleDeleteBackup(file.name)" :disabled="deletingFile === file.name"
                        class="px-3 py-1.5 bg-error/10 text-error rounded hover:bg-error/20 focus:outline-none transition text-xs font-medium disabled:opacity-50">
                  {{ $t('common.delete', '删除') }}
                </button>
              </div>
            </div>
          </div>
          <div v-else-if="!loadingList" class="text-sm text-text-secondary py-4 text-center">
            {{ $t('settings.webdavBackup.noBackups', '暂无备份文件') }}
          </div>
          <div v-else class="text-sm text-text-secondary py-4 text-center">
            {{ $t('common.loading', '加载中...') }}
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import axios from 'axios';

const { t } = useI18n();

const configured = ref(false);
const configUrl = ref('');
const saving = ref(false);
const testing = ref(false);
const configMessage = ref('');
const configSuccess = ref(false);

const backingUp = ref(false);
const loadingList = ref(false);
const backupMessage = ref('');
const backupSuccess = ref(false);
const backupList = ref<Array<{ name: string; size: number; lastModified: string }>>([]);
const restoring = ref(false);
const deletingFile = ref('');

const form = ref({
  url: '',
  username: '',
  password: '',
});

async function fetchConfig() {
  try {
    const res = await axios.get('/api/v1/webdav-backup/config');
    configured.value = res.data.configured;
    if (res.data.configured) {
      configUrl.value = res.data.url;
      form.value.url = res.data.url;
      form.value.username = res.data.username;
      form.value.password = '';
      await fetchBackupList();
    }
  } catch (err: any) {
    console.error('获取 WebDAV 配置失败:', err);
  }
}

async function handleSaveConfig() {
  saving.value = true;
  configMessage.value = '';
  configSuccess.value = false;
  try {
    await axios.post('/api/v1/webdav-backup/config', {
      url: form.value.url,
      username: form.value.username,
      password: form.value.password,
    });
    configMessage.value = t('settings.webdavBackup.configSaved', '配置已保存，连接正常');
    configSuccess.value = true;
    configured.value = true;
    configUrl.value = form.value.url;
    await fetchBackupList();
  } catch (err: any) {
    configMessage.value = err.response?.data?.message || t('common.error', '操作失败');
    configSuccess.value = false;
  } finally {
    saving.value = false;
  }
}

async function handleDeleteConfig() {
  saving.value = true;
  try {
    await axios.delete('/api/v1/webdav-backup/config');
    configured.value = false;
    configUrl.value = '';
    backupList.value = [];
    form.value.password = '';
    configMessage.value = t('settings.webdavBackup.configDeleted', '配置已删除');
    configSuccess.value = true;
  } catch (err: any) {
    configMessage.value = err.response?.data?.message || t('common.error', '操作失败');
    configSuccess.value = false;
  } finally {
    saving.value = false;
  }
}

async function handleTestConnection() {
  testing.value = true;
  configMessage.value = '';
  try {
    await axios.post('/api/v1/webdav-backup/test');
    configMessage.value = t('settings.webdavBackup.connectionOk', '连接正常');
    configSuccess.value = true;
  } catch (err: any) {
    configMessage.value = err.response?.data?.message || t('common.error', '连接测试失败');
    configSuccess.value = false;
  } finally {
    testing.value = false;
  }
}

async function handleCreateBackup() {
  backingUp.value = true;
  backupMessage.value = '';
  try {
    const res = await axios.post('/api/v1/webdav-backup/run');
    backupMessage.value = t('settings.webdavBackup.backupCreated', '备份成功: {{name}} ({{size}})', {
      name: res.data.fileName,
      size: formatSize(res.data.size),
    });
    backupSuccess.value = true;
    await fetchBackupList();
  } catch (err: any) {
    backupMessage.value = err.response?.data?.message || t('common.error', '备份失败');
    backupSuccess.value = false;
  } finally {
    backingUp.value = false;
  }
}

async function fetchBackupList() {
  loadingList.value = true;
  try {
    const res = await axios.get('/api/v1/webdav-backup/list');
    backupList.value = res.data.files || [];
  } catch (err: any) {
    console.error('获取备份列表失败:', err);
  } finally {
    loadingList.value = false;
  }
}

async function handleRefreshList() {
  backupMessage.value = '';
  await fetchBackupList();
}

async function handleRestoreBackup(fileName: string) {
  if (!confirm(t('settings.webdavBackup.confirmRestore', '确定要从 {{name}} 恢复数据吗？此操作将覆盖现有数据。', { name: fileName }))) {
    return;
  }
  restoring.value = true;
  backupMessage.value = '';
  try {
    const res = await axios.post('/api/v1/webdav-backup/restore', { fileName });
    backupMessage.value = t('settings.webdavBackup.restoreSuccess', '恢复成功: {{message}}', { message: res.data.message });
    backupSuccess.value = true;
  } catch (err: any) {
    backupMessage.value = err.response?.data?.message || t('common.error', '恢复失败');
    backupSuccess.value = false;
  } finally {
    restoring.value = false;
  }
}

async function handleDeleteBackup(fileName: string) {
  if (!confirm(t('settings.webdavBackup.confirmDelete', '确定要删除备份 {{name}} 吗？', { name: fileName }))) {
    return;
  }
  deletingFile.value = fileName;
  try {
    await axios.delete(`/api/v1/webdav-backup/${encodeURIComponent(fileName)}`);
    backupList.value = backupList.value.filter(f => f.name !== fileName);
    backupMessage.value = t('settings.webdavBackup.deleteSuccess', '备份已删除');
    backupSuccess.value = true;
  } catch (err: any) {
    backupMessage.value = err.response?.data?.message || t('common.error', '删除失败');
    backupSuccess.value = false;
  } finally {
    deletingFile.value = '';
  }
}

function formatSize(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(1)} ${units[i]}`;
}

onMounted(() => {
  fetchConfig();
});
</script>
