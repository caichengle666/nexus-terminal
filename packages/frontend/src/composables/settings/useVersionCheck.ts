import { ref, computed } from 'vue';
import axios from 'axios';
import pkg from '../../../package.json'; // 调整路径以正确导入 package.json
import { useI18n } from 'vue-i18n';

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
};

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

const getPlatformDownloadAsset = (assets: ReleaseAsset[]) => {
  const isMac = /Macintosh|Mac OS X/i.test(navigator.userAgent);
  const assetPattern = isMac ? /macOS[- ]arm64\.dmg$/i : /Portable.*\.exe$/i;
  return assets.find(asset => assetPattern.test(asset.name))?.browser_download_url || null;
};

export function useVersionCheck() {
  const { t } = useI18n();
  const appVersion = ref(pkg.version);
  const latestVersion = ref<string | null>(null);
  const latestReleaseUrl = ref<string | null>(null);
  const updateDownloadUrl = ref<string | null>(null);
  const isCheckingVersion = ref(false);
  const versionCheckError = ref<string | null>(null);

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
    isCheckingVersion.value = true;
    versionCheckError.value = null;
    latestVersion.value = null;
    latestReleaseUrl.value = null;
    updateDownloadUrl.value = null;
    try {
      await loadActualAppVersion();
      const response = await axios.get('https://api.github.com/repos/caichengle666/nexus-terminal/releases/latest');
      if (response.data && response.data.tag_name) {
        latestVersion.value = response.data.tag_name;
        latestReleaseUrl.value = response.data.html_url || null;
        updateDownloadUrl.value = getPlatformDownloadAsset(response.data.assets || []);
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
    }
  };

  return {
    appVersion,
    latestVersion,
    latestReleaseUrl,
    updateDownloadUrl,
    isCheckingVersion,
    versionCheckError,
    isUpdateAvailable,
    checkLatestVersion,
  };
}
