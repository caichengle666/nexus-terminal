const https = require('https');

const ALLOWED_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
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
    validateUpdateUrl(redirectUrl, allowedHosts);
    return redirectUrl;
  } catch {
    throw new Error('更新资源重定向地址无效。');
  }
};

const validateUpdateUrl = (value, allowedHosts = ALLOWED_HOSTS) => {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname)) throw new Error('更新资源必须来自受信任的 HTTPS 地址。');
  return parsed;
};

const requestWithRedirect = (value, options = {}, redirectCount = 0) => new Promise((resolve, reject) => {
  if (redirectCount > MAX_REDIRECTS) return reject(new Error('更新资源重定向次数过多。'));
  const allowedHosts = options.allowedHosts || ALLOWED_HOSTS;
  let parsed;
  try { parsed = validateUpdateUrl(value, allowedHosts); } catch (error) { return reject(error); }
  let settled = false;
  const fail = error => {
    if (settled) return;
    settled = true;
    reject(error);
  };
  const request = https.request(parsed, {
    ...options,
    allowedHosts: undefined,
    timeout: REQUEST_TIMEOUT_MS,
    headers: { 'User-Agent': USER_AGENT, ...(options.headers || {}) },
  }, response => {
    response.on('error', fail);
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
  request.setTimeout(REQUEST_TIMEOUT_MS, () => {
    request.destroy(new Error('更新请求超时。'));
  });
  request.on('error', fail);
  request.end();
});

const fetchUpdateText = async (value, agent = null) => {
  const { response } = await requestWithRedirect(value, { method: 'GET', agent });
  if (response.statusCode !== 200) { response.resume(); throw new Error(`获取更新校验文件失败（HTTP ${response.statusCode}）。`); }
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
};

module.exports = {
  ALLOWED_HOSTS,
  USER_AGENT,
  REQUEST_TIMEOUT_MS,
  MAX_REDIRECTS,
  MAX_CHECKSUM_TEXT_SIZE,
  normalizeMirrorUrls,
  validateMirrorUrl,
  resolveRedirectUrl,
  validateUpdateUrl,
  requestWithRedirect,
  fetchUpdateText,
};
