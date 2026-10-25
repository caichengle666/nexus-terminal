import { ref, computed, onUnmounted } from 'vue';
import axios from 'axios';
import pkg from '../../../package.json'; // 调整路径以正确导入 package.json
import { useI18n } from 'vue-i18n';
import {
  getChecksumAsset,
  getPlatformDownloadAsset,
  getWindowsPortableAsset,
  isArm64Architecture,
  isVersionNewer,
} from './updateAssets';

export type RuntimeKind = 'electron' | 'docker' | 'pwa' | 'web';
export type UpdateDownloadStatus = 'idle' | 'fetching-checksum' | 'probing' | 'downloading' | 'parallel-failed' | 'trying-fallback' | 'source-failed' | 'verifying' | 'ready' | 'extracting' | 'restarting' | 'install-failed' | 'failed' | 'cancelled';

const UPDATE_MIRRORS_STORAGE_KEY = 'nexus.update-mirror-urls';
const loadUpdateMirrorUrls = (): string[] => {
  try {
    const stored = JSON.parse(localStorage.getItem(UPDATE_MIRRORS_STORAGE_KEY) || '[]');
    return Array.isArray(stored) ? stored.filter(value => typeof value === 'string') : [];
  } catch {
    return [];
  }
};

const appVersion = ref(pkg.version);
const latestVersion = ref<string | null>(null);
const latestReleaseUrl = ref<string | null>(null);
const updateDownloadUrl = ref<string | null>(null);
const updatePortableUrl = ref<string | null>(null);
const updateChecksumUrl = ref<string | null>(null);
const isCheckingVersion = ref(false);
const versionCheckError = ref<string | null>(null);
const updateDownloadStatus = ref<UpdateDownloadStatus>('idle');
const updateDownloadProgress = ref<number | null>(null);
const updateDownloadError = ref<string | null>(null);
const updateDownloadStageMessage = ref<string | null>(null);
const updateChecksumVerified = ref(false);
const updateSignatureStatus = ref<'valid' | 'invalid' | 'unavailable' | null>(null);
const isInstallingUpdate = ref(false);
const updateMirrorUrls = ref<string[]>(loadUpdateMirrorUrls());
let versionCheckPromise: Promise<void> | null = null;
let updateRequestSequence = 0;
let activeUpdateRequestId: string | null = null;
let nativePlatform: string | null = null;
let nativeArchitecture: string | null = null;
let installationKind: 'system' | 'portable' = 'system';

export function useVersionCheck() {
  const { t } = useI18n();
  const runtimeKind = computed<RuntimeKind>(() => {
    if ((window as any).electronAPI) return 'electron';
    if (import.meta.env.VITE_DEPLOYMENT_MODE === 'docker') return 'docker';
    if (window.matchMedia('(display-mode: standalone)').matches) return 'pwa';
    return 'web';
  });
  const dockerUpgradeCommand = 'docker compose pull && docker compose up -d';
  const electronApi = (window as any).electronAPI;

  const saveUpdateMirrorUrls = (value: string) => {
    const urls = [...new Set(value.split(/\r?\n/).map(item => item.trim()).filter(Boolean))];
    updateMirrorUrls.value = urls;
    localStorage.setItem(UPDATE_MIRRORS_STORAGE_KEY, JSON.stringify(urls));
  };

  const isUpdateAvailable = computed(() => {
    // 简单的字符串比较，假设 tag 格式为 vX.Y.Z
    return !!latestVersion.value && isVersionNewer(latestVersion.value, appVersion.value);
  });

  const loadActualAppVersion = async () => {
    try {
      const version = await (window as any).electronAPI?.getAppVersion?.();
      if (typeof version === 'string' && version.trim()) appVersion.value = version.trim();
      const platform = await (window as any).electronAPI?.getPlatform?.();
      if (typeof platform === 'string' && platform.trim()) nativePlatform = platform.trim().toLowerCase();
      const architecture = await (window as any).electronAPI?.getArchitecture?.();
      if (typeof architecture === 'string' && architecture.trim()) nativeArchitecture = architecture.trim().toLowerCase();
      const kind = await (window as any).electronAPI?.getInstallationKind?.();
      if (kind === 'portable' || kind === 'system') installationKind = kind;
    } catch (error) {
      console.warn('[VersionCheck] Unable to read Electron app version, using frontend fallback.', error);
    }
  };

  const checkLatestVersion = async () => {
    if (versionCheckPromise) return versionCheckPromise;
    if (updateDownloadStatus.value === 'downloading'
      || updateDownloadStatus.value === 'verifying'
      || updateDownloadStatus.value === 'ready'
      || updateDownloadStatus.value === 'extracting'
      || updateDownloadStatus.value === 'restarting'
      || isInstallingUpdate.value) return;

    isCheckingVersion.value = true;
    versionCheckError.value = null;
    latestVersion.value = null;
    latestReleaseUrl.value = null;
    updateDownloadUrl.value = null;
    updatePortableUrl.value = null;
    updateChecksumUrl.value = null;
    updateDownloadStatus.value = 'idle';
    updateDownloadProgress.value = null;
    updateDownloadError.value = null;
    updateDownloadStageMessage.value = null;
    updateChecksumVerified.value = false;
    updateSignatureStatus.value = null;
    versionCheckPromise = (async () => {
      try {
        await loadActualAppVersion();
        const response = await axios.get('https://api.github.com/repos/caichengle666/nexus-terminal/releases/latest', {
          timeout: 15000,
          headers: { Accept: 'application/vnd.github+json' },
        });
        if (response.data && response.data.tag_name) {
          latestVersion.value = response.data.tag_name;
          latestReleaseUrl.value = response.data.html_url || null;
          const assets = response.data.assets || [];
          const isArm64 = isArm64Architecture(nativeArchitecture);
          const downloadAsset = installationKind === 'portable' && nativePlatform === 'win32'
            ? getWindowsPortableAsset(assets, isArm64)
            : getPlatformDownloadAsset(assets, nativePlatform || undefined, nativeArchitecture || undefined);
          const portableAsset = nativePlatform === 'win32' ? getWindowsPortableAsset(assets, isArm64) : null;
          const checksumAsset = getChecksumAsset(response.data.assets || []);
          updateDownloadUrl.value = downloadAsset?.browser_download_url || null;
          updatePortableUrl.value = portableAsset?.browser_download_url || null;
          updateChecksumUrl.value = checksumAsset?.browser_download_url || null;
        } else {
          throw new Error('Invalid API response format');
        }
      } catch (error: any) {
        console.error('检查最新版本失败:', error);
        if (axios.isAxiosError(error) && error.response?.status === 404) {
          versionCheckError.value = t('settings.about.error.noReleases');
        } else if (axios.isAxiosError(error) && error.response?.status === 403) {
          versionCheckError.value = t('settings.about.error.rateLimit');
        } else {
          versionCheckError.value = t('settings.about.error.checkFailed');
        }
      } finally {
        isCheckingVersion.value = false;
        versionCheckPromise = null;
      }
    })();

    return versionCheckPromise;
  };

  const downloadUpdate = async (proxy?: { type?: string; host?: string; port?: number; username?: string }) => {
    if (updateDownloadStatus.value === 'downloading'
      || updateDownloadStatus.value === 'verifying'
      || updateDownloadStatus.value === 'ready'
      || updateDownloadStatus.value === 'extracting'
      || updateDownloadStatus.value === 'restarting'
      || isInstallingUpdate.value) return;
    if (runtimeKind.value !== 'electron' || !electronApi?.downloadUpdate) {
      updateDownloadStatus.value = 'failed';
      updateDownloadError.value = '当前运行环境不支持自动更新。';
      return;
    }
    if (!updateDownloadUrl.value) {
      updateDownloadStatus.value = 'failed';
      updateDownloadError.value = '没有找到适用于当前平台的更新文件。';
      return;
    }
    const requestId = String(++updateRequestSequence);
    activeUpdateRequestId = requestId;
    updateDownloadStatus.value = 'downloading';
    updateDownloadProgress.value = 0;
    updateDownloadError.value = null;
    updateDownloadStageMessage.value = '正在准备更新…';
    updateChecksumVerified.value = false;
    updateSignatureStatus.value = null;
    try {
      const safeProxy = proxy
        ? {
          type: proxy.type,
          host: proxy.host,
          port: proxy.port,
          username: proxy.username,
        }
        : undefined;
      const result = await electronApi.downloadUpdate({
        url: updateDownloadUrl.value,
        checksumUrl: updateChecksumUrl.value,
        fallbackUrl: updatePortableUrl.value,
        version: latestVersion.value,
        requestId,
        proxy: safeProxy,
        mirrorUrls: [...updateMirrorUrls.value],
      });
      if (requestId !== activeUpdateRequestId) return;
      if (!result?.ok) {
        activeUpdateRequestId = null;
        updateDownloadStatus.value = 'failed';
        updateDownloadError.value = result?.message || '更新下载失败。';
        return;
      }
      activeUpdateRequestId = null;
      updateDownloadStatus.value = 'ready';
      updateDownloadProgress.value = 100;
      updateChecksumVerified.value = result.checksumVerified ?? updateChecksumVerified.value;
      updateSignatureStatus.value = result.signature ?? updateSignatureStatus.value;
    } catch (error) {
      if (requestId !== activeUpdateRequestId) return;
      activeUpdateRequestId = null;
      updateDownloadStatus.value = 'failed';
      updateDownloadError.value = error instanceof Error ? error.message : '更新下载失败。';
    }
  };

  const cancelUpdate = async () => {
    try {
      const result = await electronApi?.cancelUpdate?.();
      if (result?.ok) {
        activeUpdateRequestId = null;
        updateDownloadStatus.value = 'cancelled';
        updateDownloadProgress.value = null;
        updateDownloadError.value = null;
      } else if (updateDownloadStatus.value === 'downloading' || updateDownloadStatus.value === 'verifying') {
        activeUpdateRequestId = null;
        updateDownloadStatus.value = 'failed';
        updateDownloadError.value = result?.message || '更新下载已结束，请重新检查更新。';
      }
    } catch (error) {
      updateDownloadStatus.value = 'failed';
      updateDownloadError.value = error instanceof Error ? error.message : '取消更新失败。';
    }
  };

  const installUpdate = async () => {
    if ((updateDownloadStatus.value !== 'ready' && updateDownloadStatus.value !== 'install-failed') || isInstallingUpdate.value) return;
    if (!electronApi?.installUpdate) {
      updateDownloadStatus.value = 'failed';
      updateDownloadError.value = t('settings.about.installUnsupported');
      return;
    }
    isInstallingUpdate.value = true;
    updateDownloadError.value = null;
    try {
      const result = await electronApi?.installUpdate?.();
      if (result?.cancelled) {
        // Dialog cancelled (or "show download location"): the file is still ready.
        updateDownloadStatus.value = 'ready';
        updateDownloadStageMessage.value = null;
      } else if (result && !result.ok) {
        // A failed install keeps the verified file, so retrying needs no new download.
        updateDownloadStatus.value = result.retryable ? 'install-failed' : 'failed';
        updateDownloadError.value = result.message || t('settings.about.installFailed');
        updateDownloadStageMessage.value = null;
      }
    } catch (error) {
      updateDownloadStatus.value = 'install-failed';
      updateDownloadError.value = error instanceof Error ? error.message : t('settings.about.installFailed');
      updateDownloadStageMessage.value = null;
    } finally {
      isInstallingUpdate.value = false;
    }
  };

  const showUpdateFile = async () => {
    try {
      const result = await electronApi?.showUpdateFile?.();
      if (result && !result.ok && result.message) updateDownloadError.value = result.message;
    } catch (error) {
      updateDownloadError.value = error instanceof Error ? error.message : String(error);
    }
  };

  const removeUpdateProgressListener = electronApi?.onUpdateProgress?.((payload: {
    status: UpdateDownloadStatus;
    requestId?: string;
    progress?: number | null;
    message?: string;
    checksumVerified?: boolean;
    signature?: 'valid' | 'invalid' | 'unavailable';
    source?: string;
    rangeSupported?: boolean;
  }) => {
    if (payload.requestId && payload.requestId !== activeUpdateRequestId) return;
    if (payload.status === 'ready' || payload.status === 'failed' || payload.status === 'cancelled') {
      activeUpdateRequestId = null;
    }
    updateDownloadStatus.value = payload.status;
    updateDownloadProgress.value = payload.progress ?? updateDownloadProgress.value;
    updateChecksumVerified.value = payload.checksumVerified ?? updateChecksumVerified.value;
    updateSignatureStatus.value = payload.signature ?? updateSignatureStatus.value;
    if (payload.message && payload.status !== 'extracting' && payload.status !== 'restarting') updateDownloadError.value = payload.message;
    if (payload.status === 'fetching-checksum') updateDownloadStageMessage.value = '正在获取校验文件…';
    else if (payload.status === 'probing') updateDownloadStageMessage.value = '正在检查下载源…';
    else if (payload.status === 'downloading') updateDownloadStageMessage.value = payload.rangeSupported === false ? '正在下载更新文件…' : '正在下载更新文件（支持并行分片）…';
    else if (payload.status === 'parallel-failed') updateDownloadStageMessage.value = '并行下载不稳定，正在切换为普通下载…';
    else if (payload.status === 'trying-fallback') updateDownloadStageMessage.value = payload.message || '正在尝试备用便携版…';
    else if (payload.status === 'source-failed') updateDownloadStageMessage.value = '当前下载源失败，正在尝试下一个来源…';
    else if (payload.status === 'verifying') updateDownloadStageMessage.value = payload.message || '正在校验安装包…';
    else if (payload.status === 'ready') updateDownloadStageMessage.value = '更新文件已准备好。';
    else if (payload.status === 'extracting') updateDownloadStageMessage.value = t('settings.about.extractingUpdate');
    else if (payload.status === 'restarting') updateDownloadStageMessage.value = t('settings.about.restartingForUpdate');
    else if (payload.status === 'failed' || payload.status === 'cancelled') updateDownloadStageMessage.value = null;
  });

  onUnmounted(() => removeUpdateProgressListener?.());

  return {
    appVersion,
    latestVersion,
    latestReleaseUrl,
    updateDownloadUrl,
    updatePortableUrl,
    updateChecksumUrl,
    updateMirrorUrls,
    updateDownloadStatus,
    updateDownloadProgress,
    updateDownloadError,
    updateDownloadStageMessage,
    isInstallingUpdate,
    updateChecksumVerified,
    updateSignatureStatus,
    isCheckingVersion,
    versionCheckError,
    isUpdateAvailable,
    runtimeKind,
    dockerUpgradeCommand,
    checkLatestVersion,
    downloadUpdate,
    cancelUpdate,
    installUpdate,
    showUpdateFile,
    saveUpdateMirrorUrls,
  };
}
