'use strict';

// "Is there a newer release?" check, run in the main process for the desktop app
// (Settings > About and the silent startup check).
//
// The renderer used to ask api.github.com directly, which ignores the update
// proxy and the mirror list and fails with a bare "检查失败" whenever
// api.github.com is slow, rate limited or blocked (common in mainland China).
// Here the check goes through a pluggable transport (Electron net with the
// system proxy, or Node https with the user's selected proxy) and tries, in order:
//
//   1. https://api.github.com/repos/<repo>/releases/latest (JSON)
//   2. https://github.com/<repo>/releases/latest -> 302 to /releases/tag/<tag>;
//      asset URLs are rebuilt from the tag (SHA256SUMS.txt lists the real names
//      when it can be fetched, otherwise the known electron-builder naming).
//   3. each user-configured mirror wrapping (1), then wrapping (2).
//
// Strict allowlist, same philosophy as update-network.js: only those exact
// api.github.com / github.com paths of this repository, GitHub's asset CDNs as
// redirect targets, and the hosts of the user's own HTTPS mirrors. Whatever a
// source answers, the only thing taken from it is a tag matching TAG_PATTERN and
// official github.com release-download URLs; the download path re-validates
// them and fetches the SHA-256 manifest from the official source only.
//
// This module must not require `electron` so it can be unit tested.

const https = require('https');
const {
  GITHUB_ASSET_CDN_HOSTS,
  USER_AGENT,
  isReleaseDownloadPath,
  normalizeMirrorUrls,
  validateMirrorUrl,
  validateUpdateUrl,
} = require('./update-network');

const REPO_PATH = '/caichengle666/nexus-terminal';
const API_HOST = 'api.github.com';
const GITHUB_HOST = 'github.com';
const LATEST_RELEASE_API_PATH = `/repos${REPO_PATH}/releases/latest`;
const LATEST_RELEASE_API_URL = `https://${API_HOST}${LATEST_RELEASE_API_PATH}`;
const LATEST_RELEASE_PAGE_PATH = `${REPO_PATH}/releases/latest`;
const LATEST_RELEASE_PAGE_URL = `https://${GITHUB_HOST}${LATEST_RELEASE_PAGE_PATH}`;
const RELEASE_TAG_PATH_PREFIX = `${REPO_PATH}/releases/tag/`;
const RELEASE_PAGE_PREFIX = `https://${GITHUB_HOST}${REPO_PATH}/releases/`;
const RELEASE_DOWNLOAD_BASE = `https://${GITHUB_HOST}${REPO_PATH}/releases/download/`;
const CHECKSUM_ASSET_NAME = 'SHA256SUMS.txt';
const TAG_PATTERN = /^v?\d+(?:\.\d+){0,5}$/i;
const TAG_IN_TEXT = /\/caichengle666\/nexus-terminal\/releases\/tag\/(v?\d+(?:\.\d+){0,5})(?=$|[/?#"'<>\s&])/gi;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 10_000;
const MAX_JSON_SIZE = 2 * 1024 * 1024;
const MAX_PAGE_SIZE = 4 * 1024 * 1024;
const MAX_CHECKSUM_SIZE = 256 * 1024;
const MAX_REDIRECTS = 5;
const MAX_MIRRORS = 10;

class ReleaseCheckError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ReleaseCheckError';
    this.checkCode = code;
    Object.assign(this, extra);
  }
}

const httpError = status => new ReleaseCheckError(
  status === 403 || status === 429 ? 'rate-limit' : status === 404 ? 'not-found' : 'http',
  `HTTP ${status}`,
  { status },
);

// ---------------------------------------------------------------------------
// URL policy
// ---------------------------------------------------------------------------

const isValidTag = tag => typeof tag === 'string' && tag.length <= 64 && TAG_PATTERN.test(tag);

/**
 * Throws unless `value` may be requested by the release check.
 * - api.github.com: only the latest-release endpoint of this repository.
 * - github.com: only releases/latest, releases/tag/<tag> and release downloads.
 * - GitHub asset CDNs: only as a redirect target.
 * - mirrorHosts (the user's HTTPS mirrors): any path.
 */
const validateReleaseCheckUrl = (value, { mirrorHosts = new Set(), isRedirect = false } = {}) => {
  let parsed;
  try { parsed = new URL(value); } catch { throw new ReleaseCheckError('blocked', 'invalid URL'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new ReleaseCheckError('blocked', `refused ${parsed.protocol}//${parsed.hostname}`);
  }
  const host = parsed.hostname;
  if (host === API_HOST && !parsed.port && parsed.pathname === LATEST_RELEASE_API_PATH) return parsed;
  if (host === GITHUB_HOST && !parsed.port) {
    const { pathname } = parsed;
    if (pathname === LATEST_RELEASE_PAGE_PATH) return parsed;
    if (pathname.startsWith(RELEASE_TAG_PATH_PREFIX) && isValidTag(decodeURIComponent(pathname.slice(RELEASE_TAG_PATH_PREFIX.length)))) return parsed;
    if (isReleaseDownloadPath(pathname)) return parsed;
  }
  if (GITHUB_ASSET_CDN_HOSTS.has(host) && !parsed.port && isRedirect) return parsed;
  if (mirrorHosts.has(host) && ![API_HOST, GITHUB_HOST].includes(host) && !GITHUB_ASSET_CDN_HOSTS.has(host)) return parsed;
  throw new ReleaseCheckError('blocked', `refused ${host}${parsed.pathname.slice(0, 80)}`);
};

// Same template rules as update-download-service.buildMirrorUrl ("{url}"
// placeholder, otherwise "<mirror>/<source url>"), for the check's source URLs.
const buildMirrorCheckUrl = (mirror, sourceUrl) => {
  validateReleaseCheckUrl(sourceUrl);
  const parsedMirror = validateMirrorUrl(mirror);
  const result = mirror.includes('{url}')
    ? mirror.replaceAll('{url}', sourceUrl)
    : `${parsedMirror.href.replace(/\/+$/, '')}/${sourceUrl}`;
  const parsedResult = new URL(result);
  if (parsedResult.protocol !== 'https:' || parsedResult.hostname !== parsedMirror.hostname) {
    throw new ReleaseCheckError('blocked', 'mirror URL changes host');
  }
  return parsedResult.href;
};

// ---------------------------------------------------------------------------
// Release data
// ---------------------------------------------------------------------------

/** Asset names as electron-builder + the release workflow publish them (GitHub turns spaces into dots). */
const getDefaultAssetNames = tag => {
  const version = String(tag).replace(/^v/i, '');
  return [
    `Nexus.Terminal.Setup.${version}.exe`,
    'Nexus.Terminal.Portable.win-unpacked.zip',
    `Nexus.Terminal-${version}-macOS-arm64.dmg`,
    `Nexus.Terminal-${version}-macOS-x64.dmg`,
    CHECKSUM_ASSET_NAME,
  ];
};

const buildAssetUrl = (tag, name) => {
  const assetUrl = `${RELEASE_DOWNLOAD_BASE}${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
  validateUpdateUrl(assetUrl);
  return assetUrl;
};

const releaseFromTag = (tag, assetNames = getDefaultAssetNames(tag)) => {
  if (!isValidTag(tag)) throw new ReleaseCheckError('invalid-response', 'invalid tag');
  const names = [...new Set(assetNames)];
  if (!names.includes(CHECKSUM_ASSET_NAME)) names.push(CHECKSUM_ASSET_NAME);
  return {
    tag_name: tag,
    html_url: `${RELEASE_PAGE_PREFIX}tag/${encodeURIComponent(tag)}`,
    draft: false,
    prerelease: false,
    assets: names.map(name => ({ name, browser_download_url: buildAssetUrl(tag, name) })),
  };
};

/** GitHub API JSON -> the release shape the renderer understands, keeping only official asset URLs. */
const normalizeApiRelease = data => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ReleaseCheckError('invalid-response', 'not a release object');
  const tag = typeof data.tag_name === 'string' ? data.tag_name.trim() : '';
  if (!isValidTag(tag)) throw new ReleaseCheckError('invalid-response', 'invalid tag');
  if (data.draft || data.prerelease) throw new ReleaseCheckError('invalid-response', 'not a published release');
  const assets = (Array.isArray(data.assets) ? data.assets : []).flatMap(asset => {
    const name = typeof asset?.name === 'string' ? asset.name : '';
    const assetUrl = typeof asset?.browser_download_url === 'string' ? asset.browser_download_url : '';
    if (!name || name.length > 200 || !assetUrl) return [];
    try { validateUpdateUrl(assetUrl); } catch { return []; }
    return [{ name, browser_download_url: assetUrl }];
  });
  const htmlUrl = typeof data.html_url === 'string' && data.html_url.startsWith(RELEASE_PAGE_PREFIX)
    ? data.html_url
    : `${RELEASE_PAGE_PREFIX}tag/${encodeURIComponent(tag)}`;
  return { tag_name: tag, html_url: htmlUrl, draft: false, prerelease: false, assets };
};

const parseJsonRelease = body => {
  let data;
  try { data = JSON.parse(body); } catch { throw new ReleaseCheckError('invalid-response', 'response is not JSON'); }
  return normalizeApiRelease(data);
};

const compareTags = (left, right) => {
  const a = left.replace(/^v/i, '').split('.').map(part => Number.parseInt(part, 10) || 0);
  const b = right.replace(/^v/i, '').split('.').map(part => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

/** Highest release tag referenced as .../caichengle666/nexus-terminal/releases/tag/<tag> in a URL or page. */
const parseTagFromText = text => {
  if (typeof text !== 'string' || !text) return null;
  let best = null;
  for (const match of text.matchAll(TAG_IN_TEXT)) {
    const tag = match[1];
    if (isValidTag(tag) && (!best || compareTags(tag, best) > 0)) best = tag;
  }
  return best;
};

const parseChecksumAssetNames = text => {
  if (typeof text !== 'string') return [];
  const names = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^[0-9a-f]{64}\s+\*?([A-Za-z0-9._ -]{1,200})$/i);
    if (!match) continue;
    const name = match[1].trim().replace(/ /g, '.');
    if (name && !name.startsWith('.') && !name.includes('..')) names.push(name);
  }
  return names;
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const ERROR_PATTERNS = [
  ['timeout', /ETIMEDOUT|ESOCKETTIMEDOUT|ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|\btimed? ?out\b|超时/i],
  ['dns', /ENOTFOUND|EAI_AGAIN|EAI_NONAME|ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|getaddrinfo/i],
  ['proxy', /ERR_PROXY|ERR_TUNNEL_CONNECTION_FAILED|ERR_SOCKS|ERR_MANDATORY_PROXY|proxy/i],
  ['tls', /CERT|SSL|TLS|ERR_BAD_SSL|self[- ]signed|EPROTO/i],
  ['refused', /ECONNREFUSED|ERR_CONNECTION_REFUSED/i],
  ['reset', /ECONNRESET|EPIPE|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_ABORTED|ERR_EMPTY_RESPONSE|socket hang up|aborted/i],
  ['offline', /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_ADDRESS_UNREACHABLE|ENETUNREACH|EHOSTUNREACH|ENETDOWN/i],
];

/** -> { code, status?, detail } where code is one of the reason keys the renderer localizes. */
const classifyReleaseCheckError = error => {
  const raw = [error?.code, error?.message].filter(Boolean).join(' ').trim();
  const detail = raw.slice(0, 160);
  if (error?.checkCode) return { code: error.checkCode, ...(error.status ? { status: error.status } : {}), detail };
  for (const [code, pattern] of ERROR_PATTERNS) {
    if (pattern.test(raw)) return { code, detail };
  }
  return { code: 'network', detail };
};

// ---------------------------------------------------------------------------
// Transports: requestOnce(url, { timeoutMs, maxBytes, headers }) ->
//   { status, location } for 3xx (redirects are never followed by the transport)
//   { status, body } otherwise
// ---------------------------------------------------------------------------

const timeoutError = timeoutMs => new ReleaseCheckError('timeout', `timed out after ${Math.round(timeoutMs / 1000)}s`);
const tooLargeError = () => new ReleaseCheckError('too-large', 'response too large');

/** Node https transport, used with the user's selected proxy agent. */
const createNodeTransport = ({ agent = null, httpsModule = https } = {}) => (target, { timeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS, maxBytes = MAX_JSON_SIZE, headers = {} } = {}) => new Promise((resolve, reject) => {
  let settled = false;
  let request = null;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) {
      try { request?.destroy(); } catch { /* ignore */ }
      reject(error);
    } else {
      resolve(value);
    }
  };
  const timer = setTimeout(() => finish(timeoutError(timeoutMs)), timeoutMs);
  try {
    request = httpsModule.request(new URL(target), {
      method: 'GET',
      agent: agent || undefined,
      headers: { 'User-Agent': USER_AGENT, ...headers },
    }, response => {
      const status = response.statusCode;
      if (status >= 300 && status < 400) {
        response.resume();
        finish(null, { status, location: response.headers.location || null });
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { finish(tooLargeError()); return; }
        chunks.push(chunk);
      });
      response.on('end', () => finish(null, { status, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', error => finish(error));
      response.on('aborted', () => finish(new ReleaseCheckError('reset', 'connection aborted')));
    });
    request.on('error', error => finish(error));
    request.end();
  } catch (error) {
    finish(error);
  }
});

/**
 * Electron net transport (main.js passes net.request bound to the default
 * session, which honours the system proxy / PAC like Chromium does).
 * redirect: 'manual' + abort on 'redirect' lets the caller validate every hop.
 */
const createNetTransport = netRequest => (target, { timeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS, maxBytes = MAX_JSON_SIZE, headers = {} } = {}) => new Promise((resolve, reject) => {
  let settled = false;
  let request = null;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error || (value && value.location !== undefined)) {
      try { request?.abort(); } catch { /* ignore */ }
    }
    if (error) reject(error); else resolve(value);
  };
  const timer = setTimeout(() => finish(timeoutError(timeoutMs)), timeoutMs);
  try {
    request = netRequest({ method: 'GET', url: target, redirect: 'manual', useSessionCookies: false });
    for (const [name, value] of Object.entries({ 'User-Agent': USER_AGENT, ...headers })) request.setHeader(name, value);
    request.on('redirect', (status, _method, redirectUrl) => finish(null, { status, location: redirectUrl || null }));
    request.on('response', response => {
      const status = response.statusCode;
      if (status >= 300 && status < 400) {
        const location = response.headers?.location;
        finish(null, { status, location: (Array.isArray(location) ? location[0] : location) || null });
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { finish(tooLargeError()); return; }
        chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => finish(null, { status, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', error => finish(error));
      response.on('aborted', () => finish(new ReleaseCheckError('reset', 'connection aborted')));
    });
    request.on('error', error => finish(error));
    request.end();
  } catch (error) {
    finish(error);
  }
});

/**
 * GET with redirect policy: every hop is checked with validateReleaseCheckUrl.
 * stopWhen(location) may end the walk on a redirect (returns { status, location }).
 */
const fetchChecked = async (transport, target, { mirrorHosts, timeoutMs, maxBytes, headers, stopAtRedirect } = {}) => {
  let current = target;
  validateReleaseCheckUrl(current, { mirrorHosts });
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const result = await transport(current, { timeoutMs, maxBytes, headers });
    if (!(result.status >= 300 && result.status < 400)) return { ...result, url: current };
    if (!result.location) throw new ReleaseCheckError('invalid-response', `HTTP ${result.status} without Location`);
    const next = new URL(result.location, current).href;
    if (stopAtRedirect?.(next)) return { status: result.status, location: next, url: current };
    validateReleaseCheckUrl(next, { mirrorHosts, isRedirect: true });
    current = next;
  }
  throw new ReleaseCheckError('invalid-response', 'too many redirects');
};

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

const API_HEADERS = { Accept: 'application/vnd.github+json' };
const PAGE_HEADERS = { Accept: 'text/html,application/xhtml+xml' };

const fetchApiRelease = async (transport, target, options) => {
  const result = await fetchChecked(transport, target, { ...options, maxBytes: MAX_JSON_SIZE, headers: API_HEADERS });
  if (result.status !== 200) throw httpError(result.status);
  return parseJsonRelease(result.body);
};

// releases/latest answers 302 -> /releases/tag/<tag>. A mirror may pass the
// redirect on (possibly re-wrapped in its own host) or follow it itself and
// return the tag page; both are handled.
const fetchLatestTag = async (transport, target, options) => {
  const result = await fetchChecked(transport, target, {
    ...options,
    maxBytes: MAX_PAGE_SIZE,
    headers: PAGE_HEADERS,
    // Stop at a redirect that names the tag, provided the target itself is
    // allowed (github.com tag page, or the mirror's own host).
    stopAtRedirect: location => {
      if (!parseTagFromText(location)) return false;
      validateReleaseCheckUrl(location, { mirrorHosts: options.mirrorHosts, isRedirect: true });
      return true;
    },
  });
  if (result.location) return parseTagFromText(result.location);
  if (result.status !== 200) throw httpError(result.status);
  const tag = parseTagFromText(result.url) || parseTagFromText(result.body);
  if (!tag) throw new ReleaseCheckError('invalid-response', 'no release tag found');
  return tag;
};

const fetchAssetNames = async (transport, tag, timeoutMs) => {
  try {
    const result = await fetchChecked(transport, buildAssetUrl(tag, CHECKSUM_ASSET_NAME), { timeoutMs, maxBytes: MAX_CHECKSUM_SIZE });
    if (result.status !== 200) return null;
    const names = parseChecksumAssetNames(result.body);
    return names.length ? names : null;
  } catch {
    return null;
  }
};

/**
 * -> { ok: true, release, source, attempts } or { ok: false, attempts }.
 * attempts: [{ source, step, ok, code?, status?, detail? }] in the order tried.
 */
const checkLatestRelease = async ({ transport, mirrorUrls = [], timeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS, log = console } = {}) => {
  if (typeof transport !== 'function') throw new TypeError('transport is required');
  const attempts = [];
  const fail = (source, step, error) => {
    const info = classifyReleaseCheckError(error);
    attempts.push({ source, step, ok: false, ...info });
    log?.warn?.(`[Updater] Release check via ${source} (${step}) failed: ${info.code}${info.status ? ` ${info.status}` : ''} ${info.detail || ''}`.trim());
  };
  const succeed = (source, step, release) => {
    attempts.push({ source, step, ok: true });
    return { ok: true, release, source, attempts };
  };

  try {
    return succeed(API_HOST, 'api', await fetchApiRelease(transport, LATEST_RELEASE_API_URL, { timeoutMs }));
  } catch (error) { fail(API_HOST, 'api', error); }

  try {
    const tag = await fetchLatestTag(transport, LATEST_RELEASE_PAGE_URL, { timeoutMs });
    const names = await fetchAssetNames(transport, tag, timeoutMs);
    return succeed(GITHUB_HOST, 'page', releaseFromTag(tag, names || undefined));
  } catch (error) { fail(GITHUB_HOST, 'page', error); }

  for (const mirror of normalizeMirrorUrls(mirrorUrls).slice(0, MAX_MIRRORS)) {
    let mirrorHost;
    try { mirrorHost = validateMirrorUrl(mirror).hostname; } catch (error) {
      fail(mirror.slice(0, 80), 'mirror', new ReleaseCheckError('blocked', error.message));
      continue;
    }
    const mirrorHosts = new Set([mirrorHost]);
    try {
      return succeed(mirrorHost, 'mirror-api', await fetchApiRelease(transport, buildMirrorCheckUrl(mirror, LATEST_RELEASE_API_URL), { timeoutMs, mirrorHosts }));
    } catch (error) { fail(mirrorHost, 'mirror-api', error); }
    try {
      const tag = await fetchLatestTag(transport, buildMirrorCheckUrl(mirror, LATEST_RELEASE_PAGE_URL), { timeoutMs, mirrorHosts });
      return succeed(mirrorHost, 'mirror-page', releaseFromTag(tag));
    } catch (error) { fail(mirrorHost, 'mirror-page', error); }
  }
  return { ok: false, attempts };
};

module.exports = {
  API_HOST,
  CHECKSUM_ASSET_NAME,
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  LATEST_RELEASE_API_URL,
  LATEST_RELEASE_PAGE_URL,
  MAX_MIRRORS,
  ReleaseCheckError,
  buildMirrorCheckUrl,
  checkLatestRelease,
  classifyReleaseCheckError,
  createNetTransport,
  createNodeTransport,
  fetchChecked,
  getDefaultAssetNames,
  normalizeApiRelease,
  parseChecksumAssetNames,
  parseTagFromText,
  releaseFromTag,
  validateReleaseCheckUrl,
};
