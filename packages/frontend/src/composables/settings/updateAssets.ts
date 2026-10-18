// Pure helpers for picking release assets; kept free of Vue so they can be
// tested in node against real GitHub release data (test/update-assets.test.mjs).

export type ReleaseAsset = {
  name: string;
  browser_download_url: string;
};

const normalizeVersion = (version: string) => version.replace(/^v/i, '').split('.').map(part => Number.parseInt(part, 10) || 0);
export const isVersionNewer = (latest: string, current: string) => {
  const latestParts = normalizeVersion(latest);
  const currentParts = normalizeVersion(current);
  for (let index = 0; index < Math.max(latestParts.length, currentParts.length); index += 1) {
    const difference = (latestParts[index] || 0) - (currentParts[index] || 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
};

const getBrowserHints = () => {
  if (typeof navigator === 'undefined') return { userAgent: '', platform: '', architecture: '' };
  const userAgentData = (navigator as Navigator & {
    userAgentData?: { platform?: string; architecture?: string };
  }).userAgentData;
  return {
    userAgent: navigator.userAgent || '',
    platform: userAgentData?.platform || '',
    architecture: userAgentData?.architecture || '',
  };
};

// The native architecture reported by Electron (process.arch) wins over the
// user agent, which says "x64" even on Windows on ARM.
export const isArm64Architecture = (nativeArchitecture?: string | null): boolean => {
  if (nativeArchitecture) return /arm64|aarch64/.test(nativeArchitecture.toLowerCase());
  const hints = getBrowserHints();
  return /arm64|aarch64|apple silicon/.test(`${hints.architecture} ${hints.userAgent}`.toLowerCase());
};

export const getPlatformDownloadAsset = (assets: ReleaseAsset[], nativePlatform?: string, nativeArchitecture?: string): ReleaseAsset | null => {
  const hints = getBrowserHints();
  const platform = `${nativePlatform || ''} ${hints.userAgent} ${hints.platform}`.toLowerCase();
  const isArm64 = isArm64Architecture(nativeArchitecture);
  const findAsset = (pattern: RegExp) => assets.find(asset => pattern.test(asset.name)) || null;

  if (/windows|win32/.test(platform)) {
    return findAsset(/setup.*\.exe$/i)
      || findAsset(isArm64
      ? /(?:portable|windows|win).*?(?:arm64|aarch64).*\.exe$/i
      : /portable.*\.exe$/i)
      || findAsset(/\.exe$/i);
  }

  if (/macintosh|mac os x|macos|darwin/.test(platform)) {
    return findAsset(isArm64
      ? /(?:macos|darwin).*?(?:arm64|apple silicon).*\.dmg$/i
      : /(?:macos|darwin).*?(?:x64|intel|amd64).*\.dmg$/i);
  }

  if (/linux/.test(platform)) {
    return findAsset(isArm64
      ? /(?:appimage|linux).*?(?:arm64|aarch64).*\.appimage$/i
      : /(?:appimage|linux).*?(?:x64|amd64).*\.appimage$/i)
      || findAsset(/\.appimage$/i);
  }

  return null;
};

export const getWindowsPortableAsset = (assets: ReleaseAsset[], isArm64: boolean): ReleaseAsset | null => {
  const armAsset = assets.find(asset => /portable.*(?:arm64|aarch64).*\.zip$/i.test(asset.name));
  if (isArm64 && armAsset) return armAsset;
  return assets.find(asset => /portable.*\.zip$/i.test(asset.name) && !/(?:arm64|aarch64)/i.test(asset.name)) || armAsset || null;
};

export const getChecksumAsset = (assets: ReleaseAsset[]): ReleaseAsset | null => {
  return assets.find(asset => /(?:sha256|sha-256|checksums?|checksum)[^/]*$/i.test(asset.name)) || null;
};
