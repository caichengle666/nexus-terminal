const https = require('https');

const GITHUB_HOST = 'github.com';
// GitHub serves release assets from these CDNs; they are only reachable as a
// redirect target of an official release download URL, never as a start URL.
const GITHUB_ASSET_CDN_HOSTS = new Set(['objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const ALLOWED_HOSTS = new Set([GITHUB_HOST, ...GITHUB_ASSET_CDN_HOSTS]);
// Manifest, signature, checksum and binary assets must come from this
// repository's GitHub releases (any other github.com repository is refused).
const RELEASE_DOWNLOAD_PATH_PREFIX = '/caichengle666/nexus-terminal/releases/download/';
const USER_AGENT = 'Nexus-Terminal-Updater';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const MAX_CHECKSUM_TEXT_SIZE = 1 * 1024 * 1024;

const normalizeMirrorUrls = values => [...new Set((Array.isArray(values) ? values : [])
  .map(value => String(value).trim().replace(/\/+$/, ''))
  .filter(Boolean))];

const validateMirrorUrl = value => {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('更新加速地址必须是 HTTPS 地址，且不能包含账号密码。');
  }
  return parsed;
};

const resolveRedirectUrl = (location, baseUrl, allowedHosts = ALLOWED_HOSTS) => {
  try {
    const redirectUrl = new URL(location, baseUrl).href;
    validateUpdateUrl(redirectUrl, allowedHosts, { isRedirect: true });
    return redirectUrl;
  } catch {
    throw new Error('更新资源重定向地址无效。');
  }
};

const isReleaseDownloadPath = pathname => (
  typeof pathname === 'string'
  && pathname.startsWith(RELEASE_DOWNLOAD_PATH_PREFIX)
  && pathname.length > RELEASE_DOWNLOAD_PATH_PREFIX.length
  && !pathname.split('/').some(segment => segment === '..' || segment === '.')
);

// - github.com: only this repository's release downloads.
// - GitHub asset CDNs: only when reached through a redirect.
// - Any other host in allowedHosts (a user-configured mirror): host check only;
//   the mirrored source URL itself is validated before the mirror URL is built.
const validateUpdateUrl = (value, allowedHosts = ALLOWED_HOSTS, { isRedirect = false } = {}) => {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !allowedHosts.has(parsed.hostname)) {
    throw new Error('更新资源必须来自受信任的 HTTPS 地址。');
  }
  if (parsed.hostname === GITHUB_HOST || GITHUB_ASSET_CDN_HOSTS.has(parsed.hostname)) {
    if (parsed.port) throw new Error('更新资源必须来自受信任的 HTTPS 地址。');
    if (parsed.hostname === GITHUB_HOST && !isReleaseDownloadPath(parsed.pathname)) {
      throw new Error('更新资源必须来自 Nexus Terminal 官方 GitHub Release。');
    }
    if (GITHUB_ASSET_CDN_HOSTS.has(parsed.hostname) && !isRedirect) {
      throw new Error('更新资源必须来自 Nexus Terminal 官方 GitHub Release。');
    }
  }
  return parsed;
};

const requestWithRedirect = (value, options = {}, redirectCount = 0) => new Promise((resolve, reject) => {
  if (redirectCount > MAX_REDIRECTS) return reject(new Error('更新资源重定向次数过多。'));
  const allowedHosts = options.allowedHosts || ALLOWED_HOSTS;
  let parsed;
  try { parsed = validateUpdateUrl(value, allowedHosts, { isRedirect: redirectCount > 0 }); } catch (error) { return reject(error); }
  let settled = false;
  const fail = error => {
    if (settled) return;
    settled = true;
    reject(error);
  };
  const request = https.request(parsed, {
    method: options.method,
    agent: options.agent,
    timeout: REQUEST_TIMEOUT_MS,
    headers: { 'User-Agent': USER_AGENT, ...(options.headers || {}) },
  }, response => {
    response.on('error', fail);
    response.on('aborted', () => fail(new Error('更新请求连接中断。')));
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
      settled = true;
      response.resume();
      let redirectUrl;
      try { redirectUrl = resolveRedirectUrl(response.headers.location, parsed, allowedHosts); } catch (error) {
        reject(error);
        return;
      }
      return requestWithRedirect(redirectUrl, { ...options, allowedHosts }, redirectCount + 1).then(resolve, reject);
    }
    settled = true;
    resolve({ response, url: parsed.href });
  });
  options.registerRequest?.(request);
  request.on('close', () => options.unregisterRequest?.(request));
  request.setTimeout(REQUEST_TIMEOUT_MS, () => {
    request.destroy(new Error('更新请求超时。'));
  });
  request.on('error', fail);
  request.end();
});

// Parses the result of Electron's session.resolveProxy() (Chromium PAC syntax,
// e.g. "PROXY 127.0.0.1:7890; DIRECT" or "SOCKS5 [::1]:1080") into the proxy
// shape buildProxyAgent() understands. Only the first usable entry is taken;
// DIRECT (or anything unsupported such as SOCKS4/HTTPS proxies) yields null so
// the request goes out directly, as before.
const parseSystemProxyRule = rule => {
  if (typeof rule !== 'string') return null;
  for (const entry of rule.split(';')) {
    const match = entry.trim().match(/^(PROXY|SOCKS5)\s+(\[[0-9a-f:.]+\]|[^\s:]+):(\d{1,5})$/i);
    if (!match) {
      if (/^DIRECT$/i.test(entry.trim())) return null;
      continue;
    }
    const port = Number(match[3]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    return { type: match[1].toUpperCase() === 'PROXY' ? 'HTTP' : 'SOCKS5', host: match[2], port };
  }
  return null;
};

const fetchUpdateText = async (value, agent = null, context = {}) => {
  const { response } = await requestWithRedirect(value, {
    method: 'GET',
    agent,
    allowedHosts: context.allowedHosts,
    registerRequest: context.registerRequest,
    unregisterRequest: context.unregisterRequest,
  });
  if (response.statusCode !== 200) { response.resume(); throw new Error(`获取更新校验文件失败（HTTP ${response.statusCode}）。`); }
  const readBody = (async () => {
    let body = '';
    response.setEncoding('utf8');
    for await (const chunk of response) {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > MAX_CHECKSUM_TEXT_SIZE) {
        response.destroy();
        throw new Error('更新校验文件超过允许大小。');
      }
    }
    return body;
  })();
  const aborted = new Promise((_, reject) => {
    response.once('aborted', () => reject(new Error('更新请求连接中断。')));
  });
  return Promise.race([readBody, aborted]);
};

module.exports = {
  ALLOWED_HOSTS,
  GITHUB_ASSET_CDN_HOSTS,
  RELEASE_DOWNLOAD_PATH_PREFIX,
  isReleaseDownloadPath,
  USER_AGENT,
  REQUEST_TIMEOUT_MS,
  MAX_REDIRECTS,
  MAX_CHECKSUM_TEXT_SIZE,
  normalizeMirrorUrls,
  parseSystemProxyRule,
  validateMirrorUrl,
  resolveRedirectUrl,
  validateUpdateUrl,
  requestWithRedirect,
  fetchUpdateText,
};
