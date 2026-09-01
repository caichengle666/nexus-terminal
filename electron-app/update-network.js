const https = require('https');

const ALLOWED_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'proxy.gitwarp.top', 'gh.gitwarp.top']);
const MIRRORS = ['https://proxy.gitwarp.top', 'https://gh.gitwarp.top'];
const USER_AGENT = 'Nexus-Terminal-Updater';

const validateUpdateUrl = value => {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) throw new Error('更新资源必须来自 GitHub HTTPS 地址。');
  return parsed;
};

const requestWithRedirect = (value, options = {}, redirectCount = 0) => new Promise((resolve, reject) => {
  if (redirectCount > 5) return reject(new Error('更新资源重定向次数过多。'));
  let parsed;
  try { parsed = validateUpdateUrl(value); } catch (error) { return reject(error); }
  const request = https.request(parsed, { ...options, headers: { 'User-Agent': USER_AGENT, ...(options.headers || {}) } }, response => {
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
      response.resume();
      return requestWithRedirect(new URL(response.headers.location, parsed).href, options, redirectCount + 1).then(resolve, reject);
    }
    resolve({ response, url: parsed.href });
  });
  request.on('error', reject);
  request.end();
});

const fetchUpdateText = async value => {
  const { response } = await requestWithRedirect(value, { method: 'GET' });
  if (response.statusCode !== 200) { response.resume(); throw new Error(`获取更新校验文件失败（HTTP ${response.statusCode}）。`); }
  let body = '';
  response.setEncoding('utf8');
  for await (const chunk of response) body += chunk;
  return body;
};

module.exports = { ALLOWED_HOSTS, MIRRORS, USER_AGENT, validateUpdateUrl, requestWithRedirect, fetchUpdateText };
