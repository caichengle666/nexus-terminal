import { ref, computed, onUnmounted } from 'vue';
import axios from 'axios';
import pkg from '../../../package.json'; // 调整路径以正确导入 package.json
import { useI18n } from 'vue-i18n';

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
};

export type RuntimeKind = 'electron' | 'docker' | 'pwa' | 'web';
export type UpdateDownloadStatus = 'idle' | 'downloading' | 'verifying' | 'ready' | 'failed' | 'cancelled';

const normalizeVersion = (version: string) => version.replace(/^v/i, '').split('.').map(part => Number.parseInt(part, 10) || 0);
const isVersionNewer = (latest: string, current: string) => {
  const latestParts = normalizeVersion(latest);
  const currentParts = normalizeVersion(current);
  for (let index = 0; index < Math.max(latestParts.length, currentParts.length); index += 1) {
    const difference = (latestParts[index] || 0) - (currentParts[index] || 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
};

const getPlatformDownloadAsset = (assets: ReleaseAsset[]): ReleaseAsset | null => {
  const userAgentData = (navigator as Navigator & {
    userAgentData?: { platform?: string; architecture?: string };
  }).userAgentData;
  const platform = `${navigator.userAgent} ${userAgentData?.platform || ''}`.toLowerCase();
  const architecture = `${userAgentData?.architecture || ''} ${navigator.userAgent}`.toLowerCase();
  const isArm64 = /arm64|aarch64|apple silicon/.test(architecture);
  const findAsset = (pattern: RegExp) => assets.find(asset => pattern.test(asset.name)) || null;

  if (/windows/.test(platform)) {
    return findAsset(isArm64
      ? /(?:portable|windows|win).*?(?:arm64|aarch64).*\.exe$/i
      : /portable.*\.exe$/i)
      || findAsset(/\.exe$/i);
  }

  if (/macintosh|mac os x|macos/.test(platform)) {
    return findAsset(isArm64
      ? /(?:macos|darwin).*?(?:arm64|apple silicon).*\.dmg$/i
      : /(?:macos|darwin).*?(?:x64|intel|amd64).*\.dmg$/i)
      || findAsset(/\.dmg$/i);
  }

  if (/linux/.test(platform)) {
    return findAsset(isArm64
      ? /(?:appimage|linux).*?(?:arm64|aarch64).*\.appimage$/i
      : /(?:appimage|linux).*?(?:x64|amd64).*\.appimage$/i)
      || findAsset(/\.appimage$/i);
  }

  return null;
};

const getChecksumAsset = (assets: ReleaseAsset[]): ReleaseAsset | null => {
  return assets.find(asset => /(?:sha256|sha-256|checksums?|checksum)[^/]*$/i.test(asset.name)) || null;
};

const appVersion = ref(pkg.version);
const latestVersion = ref<string | null>(null);
const latestReleaseUrl = ref<string | null>(null);
const updateDownloadUrl = ref<string | null>(null);
const updateChecksumUrl = ref<string | null>(null);
const isCheckingVersion = ref(false);
const versionCheckError = ref<string | null>(null);
const updateDownloadStatus = ref<UpdateDownloadStatus>('idle');
const updateDownloadProgress = ref<number | null>(null);
const updateDownloadError = ref<string | null>(null);
const updateChecksumVerified = ref(false);
const updateSignatureStatus = ref<'valid' | 'invalid' | 'unavailable' | null>(null);
let versionCheckPromise: Promise<void> | null = null;

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

  const isUpdateAvailable = computed(() => {
    // 简单的字符串比较，假设 tag 格式为 vX.Y.Z
    return !!latestVersion.value && isVersionNewer(latestVersion.value, appVersion.value);
  });

  const loadActualAppVersion = async () => {
    try {
      const version = await (window as any).electronAPI?.getAppVersion?.();
      if (typeof version === 'string' && version.trim()) appVersion.value = version.trim();
    } catch (error) {
      console.warn('[VersionCheck] Unable to read Electron app version, using frontend fallback.', error);
    }
  };

  const checkLatestVersion = async () => {
    if (versionCheckPromise) return versionCheckPromise;

    isCheckingVersion.value = true;
    versionCheckError.value = null;
    latestVersion.value = null;
    latestReleaseUrl.value = null;
    updateDownloadUrl.value = null;
    updateChecksumUrl.value = null;
    versionCheckPromise = (async () => {
      try {
        await loadActualAppVersion();
        const response = await axios.get('https://api.github.com/repos/caichengle666/nexus-terminal/releases/latest');
        if (response.data && response.data.tag_name) {
          latestVersion.value = response.data.tag_name;
          latestReleaseUrl.value = response.data.html_url || null;
          const downloadAsset = getPlatformDownloadAsset(response.data.assets || []);
          const checksumAsset = getChecksumAsset(response.data.assets || []);
          updateDownloadUrl.value = downloadAsset?.browser_download_url || null;
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
    if (runtimeKind.value !== 'electron' || !electronApi?.downloadUpdate || !updateDownloadUrl.value) return;
    updateDownloadStatus.value = 'downloading';
    updateDownloadProgress.value = 0;
    updateDownloadError.value = null;
    updateChecksumVerified.value = false;
    updateSignatureStatus.value = null;
    const result = await electronApi.downloadUpdate({
      url: updateDownloadUrl.value,
      checksumUrl: updateChecksumUrl.value,
      version: latestVersion.value,
      proxy,
    });
    if (!result?.ok && result?.message) {
      updateDownloadStatus.value = 'failed';
      updateDownloadError.value = result?.message || '更新下载失败。';
    }
  };

  const cancelUpdate = async () => {
    await electronApi?.cancelUpdate?.();
  };

  const installUpdate = async () => {
    if (updateDownloadStatus.value !== 'ready') return;
    const result = await electronApi?.installUpdate?.();
    if (result && !result.ok && !result.cancelled) {
      updateDownloadStatus.value = 'failed';
      updateDownloadError.value = result.message || '打开安装程序失败。';
    }
  };

  const removeUpdateProgressListener = electronApi?.onUpdateProgress?.((payload: {
    status: UpdateDownloadStatus;
    progress?: number | null;
    message?: string;
    checksumVerified?: boolean;
    signature?: 'valid' | 'invalid' | 'unavailable';
  }) => {
    updateDownloadStatus.value = payload.status;
    updateDownloadProgress.value = payload.progress ?? updateDownloadProgress.value;
    updateChecksumVerified.value = payload.checksumVerified ?? updateChecksumVerified.value;
    updateSignatureStatus.value = payload.signature ?? updateSignatureStatus.value;
    if (payload.message) updateDownloadError.value = payload.message;
  });

  onUnmounted(() => removeUpdateProgressListener?.());

  return {
    appVersion,
    latestVersion,
    latestReleaseUrl,
    updateDownloadUrl,
    updateChecksumUrl,
    updateDownloadStatus,
    updateDownloadProgress,
    updateDownloadError,
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
  };
}
