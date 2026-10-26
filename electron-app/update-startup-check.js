'use strict';

// One silent update check shortly after launch (desktop only). It asks the same
// GitHub "latest release" endpoint as the Settings > About check and only
// surfaces something when a newer version exists. Downloading/installing still
// goes through Settings > About (checksum + optional signature verification).
// This module must not require `electron` so it can be unit tested.

const LATEST_RELEASE_API_URL = 'https://api.github.com/repos/caichengle666/nexus-terminal/releases/latest';
const RELEASES_PAGE_PREFIX = 'https://github.com/caichengle666/nexus-terminal/releases/';
const STARTUP_UPDATE_CHECK_DELAY_MS = 10_000;
const STARTUP_UPDATE_CHECK_TIMEOUT_MS = 15_000;
const MAX_RELEASE_JSON_SIZE = 2 * 1024 * 1024;

// Same comparison as packages/frontend/src/composables/settings/updateAssets.ts.
const normalizeVersion = version => String(version || '')
  .trim()
  .replace(/^v/i, '')
  .split('.')
  .map(part => Number.parseInt(part, 10) || 0);

const isVersionNewer = (latest, current) => {
  const latestParts = normalizeVersion(latest);
  const currentParts = normalizeVersion(current);
  for (let index = 0; index < Math.max(latestParts.length, currentParts.length); index += 1) {
    const difference = (latestParts[index] || 0) - (currentParts[index] || 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
};

/** Returns { version, url } when `release` (GitHub API JSON) is newer than currentVersion, else null. */
const getAvailableUpdate = (release, currentVersion) => {
  if (!release || typeof release !== 'object' || release.draft || release.prerelease) return null;
  const tag = typeof release.tag_name === 'string' ? release.tag_name.trim() : '';
  if (!tag || tag.length > 64 || !/^v?\d+(\.\d+)*$/i.test(tag)) return null;
  if (!isVersionNewer(tag, currentVersion)) return null;
  const htmlUrl = typeof release.html_url === 'string' && release.html_url.startsWith(RELEASES_PAGE_PREFIX)
    ? release.html_url
    : `${RELEASES_PAGE_PREFIX}latest`;
  return { version: tag, url: htmlUrl };
};

/**
 * With checkImpl, uses its result; otherwise fetches the latest release with the provided fetch implementation (Electron's
 * net.fetch in main.js, which honours the system proxy) and returns
 * getAvailableUpdate(). Network/HTTP errors resolve to null: the startup check
 * is silent unless an update is available.
 */
const checkForStartupUpdate = async ({ fetchImpl, checkImpl, currentVersion, timeoutMs = STARTUP_UPDATE_CHECK_TIMEOUT_MS, log = console }) => {
  if (!currentVersion) return null;
  // checkImpl: update-release-check.checkLatestRelease (api.github.com, then the
  // github.com releases/latest redirect), resolving { ok, release }.
  if (typeof checkImpl === 'function') {
    try {
      const result = await checkImpl();
      return result?.ok ? getAvailableUpdate(result.release, currentVersion) : null;
    } catch (error) {
      log?.warn?.(`[Updater] Startup update check skipped: ${error?.message || error}`);
      return null;
    }
  }
  if (typeof fetchImpl !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(LATEST_RELEASE_API_URL, {
      method: 'GET',
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Nexus-Terminal-Updater' },
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response || response.status !== 200) return null;
    const text = await response.text();
    if (text.length > MAX_RELEASE_JSON_SIZE) return null;
    return getAvailableUpdate(JSON.parse(text), currentVersion);
  } catch (error) {
    log?.warn?.(`[Updater] Startup update check skipped: ${error?.message || error}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
};

module.exports = {
  LATEST_RELEASE_API_URL,
  STARTUP_UPDATE_CHECK_DELAY_MS,
  checkForStartupUpdate,
  getAvailableUpdate,
  isVersionNewer,
};
