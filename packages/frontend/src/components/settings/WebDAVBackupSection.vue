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
            <div class="flex items-center gap-3">
              <label class="inline-flex items-center gap-2 text-sm text-foreground cursor-pointer">
                <input v-model="useProxy" type="checkbox" class="rounded border-border text-primary focus:ring-primary" :disabled="saving" />
                {{ $t('settings.webdavBackup.useProjectProxy', '使用项目代理传输 WebDAV 数据') }}
              </label>
              <select v-if="useProxy" v-model="form.proxyId" :disabled="saving || loadingProxies"
                      class="min-w-0 flex-1 px-3 py-2 border border-border rounded-md bg-input text-foreground focus:outline-none focus:ring-2 focus:ring-primary text-sm">
                <option :value="null">{{ loadingProxies ? $t('common.loading', '加载中...') : $t('settings.webdavBackup.selectProxy', '选择项目代理') }}</option>
                <option v-for="proxy in proxies" :key="proxy.id" :value="proxy.id">
                  {{ proxy.name }} ({{ proxy.type }} · {{ proxy.host }}:{{ proxy.port }})
                </option>
              </select>
            </div>
          </div>
          <div class="flex items-center space-x-3">
            <button type="submit" :disabled="saving || !form.url || !form.username || !form.password || (useProxy && !form.proxyId)"
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
            <button v-if="configured" type="button" @click="handleTestConnection" :disabled="testing || (useProxy && !form.proxyId)"
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
          <div class="max-w-md">
            <label class="block text-sm font-medium text-foreground mb-1">{{ $t('settings.webdavBackup.backupPassphrase', '备份密码') }}</label>
            <input v-model="backupPassphrase" type="password" minlength="8" autocomplete="new-password"
                   :placeholder="$t('settings.webdavBackup.backupPassphrasePlaceholder', '至少 8 个字符')"
                   class="w-full px-3 py-2 border border-border rounded-md bg-input text-foreground focus:outline-none focus:ring-2 focus:ring-primary text-sm"
                   :disabled="backingUp || restoring" />
            <p class="mt-1 text-xs text-text-secondary">{{ $t('settings.webdavBackup.backupPassphraseHint', '完整备份包含 data 目录和加密密钥，请妥善保存此密码。') }}</p>
          </div>
          <div class="flex items-center space-x-3 mb-4">
            <button @click="handleCreateBackup" :disabled="backingUp || restoring || backupPassphrase.length < 8"
                    class="px-4 py-2 bg-primary text-white rounded-md shadow-sm hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed transition duration-150 ease-in-out text-sm font-medium inline-flex items-center">
              <svg v-if="backingUp" class="animate-spin -ml-1 mr-2 h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              {{ backingUp ? $t('common.backingUp', '备份中...') : $t('settings.webdavBackup.createBackup', '创建备份') }}
            </button>
            <button @click="handleRefreshList" :disabled="loadingList || restoring"
                    class="px-4 py-2 bg-muted text-foreground rounded-md hover:bg-muted/80 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50 transition text-sm font-medium">
              {{ $t('common.refresh', '刷新列表') }}
            </button>
          </div>
          <div v-if="restoringFile" role="status" aria-live="polite"
               class="mb-3 flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-foreground">
            <svg class="animate-spin mt-0.5 h-4 w-4 flex-shrink-0 text-primary" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <div class="min-w-0">
              <p class="break-all">{{ $t('settings.webdavBackup.restoreInProgress', { name: restoringFile, stage: restoreStageLabel }) }}</p>
              <p class="text-xs text-text-secondary mt-0.5">{{ $t('settings.webdavBackup.restoreKeepOpen') }}</p>
            </div>
          </div>
          <p v-if="backupMessage" role="alert" :class="['text-sm mb-3 whitespace-pre-wrap break-words', backupSuccess ? 'text-success' : 'text-error']">{{ backupMessage }}</p>

          <!-- Backup List -->
          <div v-if="backupList.length > 0" class="border border-border rounded-md divide-y divide-border">
            <div v-for="file in backupList" :key="file.name" class="flex items-center justify-between px-4 py-3 text-sm">
              <div class="flex-1 min-w-0">
                <p class="text-foreground truncate">{{ file.name }}</p>
                <p class="text-text-secondary text-xs mt-0.5">
                  {{ file.format === 'full' ? $t('settings.webdavBackup.fullEncrypted', '完整加密备份') : $t('settings.webdavBackup.legacyBackup', '旧版数据库备份') }}
                  &middot; {{ formatSize(file.size) }} &middot; {{ file.lastModified }}
                </p>
              </div>
              <div class="flex items-center space-x-2 ml-4 flex-shrink-0">
                <button @click="handleRestoreBackup(file)" :disabled="restoring || (file.encrypted && backupPassphrase.length < 8)"
                        :aria-busy="restoringFile === file.name"
                        :class="['px-3 py-1.5 bg-primary/10 text-primary rounded hover:bg-primary/20 focus:outline-none transition text-xs font-medium inline-flex items-center whitespace-nowrap', restoringFile === file.name ? 'disabled:opacity-100 cursor-wait' : 'disabled:opacity-50']">
                  <svg v-if="restoringFile === file.name" class="animate-spin -ml-0.5 mr-1.5 h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  {{ restoringFile === file.name ? restoreStageLabel : $t('settings.webdavBackup.restore', '恢复') }}
                </button>
                <button @click="handleDeleteBackup(file.name)" :disabled="restoring || deletingFile === file.name"
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
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import axios from 'axios';
import { useConfirmDialog } from '../../composables/useConfirmDialog';
import {
  RESTORE_STAGE_I18N,
  saveRestoreNotice,
  takeRestoreNotice,
  waitForBackendRestart,
  type RestoreJobStatus,
  type RestoreStage,
  type RestoreUiStage,
} from '../../utils/webdavRestore';

const { t } = useI18n();
const { showConfirmDialog } = useConfirmDialog();

const configured = ref(false);
const configUrl = ref('');
const configUsername = ref('');
const saving = ref(false);
const testing = ref(false);
const configMessage = ref('');
const configSuccess = ref(false);

const backingUp = ref(false);
const loadingList = ref(false);
const backupMessage = ref('');
const backupSuccess = ref(false);
const backupPassphrase = ref('');
const backupList = ref<Array<{ name: string; size: number; lastModified: string; format: 'full' | 'legacy'; encrypted: boolean }>>([]);
const restoring = ref(false);
const restoringFile = ref('');
const restoreStage = ref<RestoreUiStage | null>(null);
const restoreAbort = { aborted: false };
const stageText = (stage: RestoreUiStage | RestoreStage | undefined | null) => {
  if (!stage) return '';
  const [key, fallback] = RESTORE_STAGE_I18N[stage];
  return t(key, fallback);
};
const restoreStageLabel = computed(() => stageText(restoreStage.value));
const deletingFile = ref('');
const useProxy = ref(false);
const loadingProxies = ref(false);
const proxies = ref<Array<{ id: number; name: string; type: 'HTTP' | 'SOCKS5'; host: string; port: number }>>([]);

const form = ref({
  url: '',
  username: '',
  password: '',
  proxyId: null as number | null,
});

function currentProxyId(): number | null {
  return useProxy.value ? form.value.proxyId : null;
}

async function fetchConfig() {
  try {
    const res = await axios.get('/api/v1/webdav-backup/config');
    configured.value = res.data.configured;
    if (res.data.configured) {
      configUrl.value = res.data.url;
      configUsername.value = res.data.username;
      form.value.url = res.data.url;
      form.value.username = res.data.username;
      form.value.password = '';
      form.value.proxyId = res.data.proxyId ?? null;
      useProxy.value = form.value.proxyId !== null;
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
      proxyId: currentProxyId(),
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
  if (!confirm(t('settings.webdavBackup.confirmDisconnect', '确定要断开 WebDAV 备份连接吗？这只会删除本地保存的 WebDAV 配置，不会删除远端备份文件。'))) {
    return;
  }

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
  if (!form.value.password && (form.value.url !== configUrl.value || form.value.username !== configUsername.value)) {
    configMessage.value = t('settings.webdavBackup.enterPasswordToTestChanges', '修改服务器地址或用户名后，请输入密码再测试连接。');
    configSuccess.value = false;
    return;
  }

  testing.value = true;
  configMessage.value = '';
  try {
    const payload = form.value.password
      ? {
          url: form.value.url,
          username: form.value.username,
          password: form.value.password,
          proxyId: currentProxyId(),
        }
      : { proxyId: currentProxyId() };
    await axios.post('/api/v1/webdav-backup/test', payload);
    configMessage.value = t('settings.webdavBackup.connectionOk', '连接正常');
    configSuccess.value = true;
  } catch (err: any) {
    configMessage.value = err.response?.data?.message || t('common.error', '连接测试失败');
    configSuccess.value = false;
  } finally {
    testing.value = false;
  }
}

async function fetchProxies() {
  loadingProxies.value = true;
  try {
    const res = await axios.get('/api/v1/proxies');
    proxies.value = res.data || [];
  } catch (err: any) {
    console.error('获取代理列表失败:', err);
  } finally {
    loadingProxies.value = false;
  }
}

async function handleCreateBackup() {
  if (backupPassphrase.value.length < 8) {
    backupMessage.value = t('settings.webdavBackup.passphraseTooShort', '备份密码至少需要 8 个字符。');
    backupSuccess.value = false;
    return;
  }
  backingUp.value = true;
  backupMessage.value = '';
  try {
    const res = await axios.post('/api/v1/webdav-backup/run', {
      passphrase: backupPassphrase.value,
      proxyId: currentProxyId(),
    });
    backupMessage.value = t('settings.webdavBackup.backupCreated', {
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
    const res = await axios.get('/api/v1/webdav-backup/list', { params: { proxyId: currentProxyId() ?? '' } });
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

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** 当前后端进程的 bootId；后端不可用时返回 null */
async function getBackendBootId(): Promise<string | null> {
  try {
    const res = await axios.get('/api/v1/status', { timeout: 3000, params: { _: Date.now() } });
    return typeof res.data?.bootId === 'string' ? res.data.bootId : null;
  } catch {
    return null;
  }
}

function failRestore(message: string) {
  backupMessage.value = message;
  backupSuccess.value = false;
  restoring.value = false;
  restoringFile.value = '';
  restoreStage.value = null;
}

/** 轮询恢复任务直到进入“重启中”(返回任务状态)、失败('failed') 或后端失联('lost') */
async function pollRestoreJob(jobId: string): Promise<RestoreJobStatus | 'failed' | 'lost'> {
  let lastStage: RestoreStage | null = null;
  let networkFailures = 0;
  while (!restoreAbort.aborted) {
    await sleep(800);
    let status: RestoreJobStatus;
    try {
      status = (await axios.get('/api/v1/webdav-backup/restore/status', { params: { jobId }, timeout: 5000 })).data;
      networkFailures = 0;
    } catch (err: any) {
      // 后端在任务途中消失 (崩溃或被重启)：交给等待重启流程判断
      if (err.response?.status === 404 || ++networkFailures >= 4) return 'lost';
      continue;
    }
    lastStage = status.stage;
    restoreStage.value = status.stage;
    if (status.stage === 'failed') {
      failRestore(t('settings.webdavBackup.restoreFailedAt', {
        stage: stageText(status.failedStage).replace(/\.+$/, ''),
        error: status.error || t('common.error', '操作失败'),
      }));
      return 'failed';
    }
    if (status.stage === 'restarting') return status;
  }
  return lastStage === 'restarting' ? 'lost' : 'failed';
}

async function handleRestoreBackup(file: { name: string; encrypted: boolean; format: 'full' | 'legacy' }) {
  if (file.encrypted && backupPassphrase.value.length < 8) {
    backupMessage.value = t('settings.webdavBackup.passphraseRequired', '恢复完整备份前请输入备份密码。');
    backupSuccess.value = false;
    return;
  }
  const confirmed = await showConfirmDialog({
    title: t('settings.webdavBackup.confirmRestoreTitle', '恢复备份'),
    message: file.format === 'full'
      ? t('settings.webdavBackup.confirmRestoreFull', { name: file.name })
      : t('settings.webdavBackup.confirmRestoreLegacy', { name: file.name }),
    confirmText: t('settings.webdavBackup.restore', '恢复'),
  });
  if (!confirmed) return;

  restoring.value = true;
  restoringFile.value = file.name;
  restoreStage.value = 'starting';
  backupMessage.value = '';
  const startedAt = new Date().toISOString();
  const previousBootId = await getBackendBootId();

  let jobId: string;
  try {
    const res = await axios.post('/api/v1/webdav-backup/restore', {
      fileName: file.name,
      passphrase: backupPassphrase.value.length >= 8 ? backupPassphrase.value : undefined,
      proxyId: currentProxyId(),
    });
    jobId = res.data.jobId;
    restoreStage.value = res.data.stage || 'downloading';
  } catch (err: any) {
    failRestore(err.response?.data?.message || t('common.error', '恢复失败'));
    return;
  }

  const outcome = await pollRestoreJob(jobId);
  if (outcome === 'failed') return;
  const finished = outcome !== 'lost';

  restoreStage.value = 'waitingBackend';
  let back = await waitForBackendRestart({ getBootId: getBackendBootId, previousBootId, timeoutMs: 60_000, signal: restoreAbort });
  if (!back && !restoreAbort.aborted) {
    backupMessage.value = t('settings.webdavBackup.restoreManualRestart');
    backupSuccess.value = false;
    back = await waitForBackendRestart({ getBootId: getBackendBootId, previousBootId, timeoutMs: 15 * 60_000, intervalMs: 3000, signal: restoreAbort });
  }
  if (!back) return;
  // 任务状态没等到“重启中”就失联：完整备份是否已生效由重新加载后读取的启动恢复结果判定
  if (!finished && file.format !== 'full') {
    failRestore(t('settings.webdavBackup.restoreInterrupted'));
    return;
  }

  saveRestoreNotice(sessionStorage, {
    fileName: file.name,
    format: finished ? (outcome.format || file.format) : file.format,
    startedAt,
    message: finished ? outcome.message : undefined,
  });
  restoreStage.value = 'reloading';
  window.location.reload();
}

/** 恢复后页面重新加载：展示恢复是否真正生效 (数据替换发生在后端启动时) */
async function showRestoreResultAfterReload() {
  const notice = takeRestoreNotice(sessionStorage);
  if (!notice) return;
  if (notice.format === 'legacy') {
    backupMessage.value = notice.message || t('common.success', '成功');
    backupSuccess.value = true;
    return;
  }
  try {
    const res = await axios.get('/api/v1/webdav-backup/restore/last-result');
    const result = res.data?.result;
    if (!result || result.sourceFile !== notice.fileName || result.at < notice.startedAt) {
      backupMessage.value = t('settings.webdavBackup.restoreApplyFailed', { message: t('settings.webdavBackup.restoreInterrupted') });
      backupSuccess.value = false;
    } else if (result.status === 'applied') {
      backupMessage.value = t('settings.webdavBackup.restoreApplied', { name: result.sourceFile, safety: result.safetyBackup || '-' });
      backupSuccess.value = true;
    } else {
      backupMessage.value = t('settings.webdavBackup.restoreApplyFailed', { message: result.message });
      backupSuccess.value = false;
    }
  } catch (err) {
    console.error('获取恢复结果失败:', err);
  }
}

async function handleDeleteBackup(fileName: string) {
  if (!confirm(t('settings.webdavBackup.confirmDelete', { name: fileName }))) {
    return;
  }
  deletingFile.value = fileName;
  try {
    await axios.delete(`/api/v1/webdav-backup/${encodeURIComponent(fileName)}`, { data: { proxyId: currentProxyId() } });
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
  fetchProxies();
  showRestoreResultAfterReload();
});

onBeforeUnmount(() => {
  restoreAbort.aborted = true;
});
</script>
