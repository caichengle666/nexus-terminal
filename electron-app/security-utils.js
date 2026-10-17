'use strict';

// Pure security helpers used by main.js. This module must not require
// `electron` so it can be unit tested with plain `node --test`.

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Origins / URLs
// ---------------------------------------------------------------------------

const getUrlOrigin = value => {
  try {
    const origin = new URL(String(value)).origin;
    return origin && origin !== 'null' ? origin : null;
  } catch {
    return null;
  }
};

// `blob:http://localhost:1234/uuid` resolves to origin `http://localhost:1234`,
// so same-origin blob URLs are treated like the origin that created them.
const isTrustedOrigin = (value, trustedOrigins) => {
  const origin = getUrlOrigin(value);
  if (!origin) return false;
  for (const trusted of trustedOrigins || []) {
    if (trusted && origin === trusted) return true;
  }
  return false;
};

const isSafeExternalUrl = value => {
  if (typeof value !== 'string' || value.length > 8192) return false;
  let parsed;
  try { parsed = new URL(value); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (!parsed.hostname) return false;
  if (parsed.username || parsed.password) return false;
  return true;
};

// ---------------------------------------------------------------------------
// open-path
// ---------------------------------------------------------------------------

// Extensions that shell.openPath would launch/execute (or that act as
// launchers) instead of just showing content.
const BLOCKED_OPEN_PATH_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse',
  '.wsf', '.wsh', '.msi', '.msp', '.lnk', '.scr', '.pif', '.hta', '.cpl', '.msc',
  '.jar', '.reg', '.url', '.scf', '.appref-ms', '.application', '.gadget',
  '.sh', '.bash', '.zsh', '.csh', '.ksh', '.app', '.command', '.tool', '.pkg',
  '.mpkg', '.terminal', '.workflow', '.desktop', '.appimage', '.run', '.bin',
  '.py', '.pyw', '.pl', '.rb', '.php',
]);

const normalizeExtension = targetPath => {
  // Windows ignores trailing dots/spaces ("evil.exe. " opens evil.exe).
  const trimmed = String(targetPath).replace(/[\\/]+$/, '').replace(/[.\s]+$/, '');
  return path.extname(trimmed).toLowerCase();
};

const hasBlockedOpenPathExtension = targetPath => {
  if (typeof targetPath !== 'string') return true;
  // Check every path segment so that e.g. "Foo.app/Contents" is refused too.
  const segments = targetPath.split(/[\\/]+/).filter(Boolean);
  return segments.some(segment => BLOCKED_OPEN_PATH_EXTENSIONS.has(normalizeExtension(segment)));
};

const isUncOrDevicePath = targetPath => /^(?:\\\\|\/\/)/.test(targetPath) || /^\\\\[?.]\\/.test(targetPath);

/**
 * Decide whether a renderer-supplied path may be handed to shell.openPath.
 * Only existing local directories are allowed (the renderer only ever asks to
 * reveal folders), and anything that looks like an executable/launcher is
 * refused, both on the given path and on its resolved real path.
 */
const validateOpenPathRequest = (targetPath, options = {}) => {
  const platform = options.platform || process.platform;
  const fsImpl = options.fs || fs;
  if (typeof targetPath !== 'string' || !targetPath.trim()) return { ok: false, error: '路径无效。' };
  if (targetPath.length > 4096 || /[\u0000-\u001f]/.test(targetPath)) return { ok: false, error: '路径无效。' };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(targetPath)) return { ok: false, error: '只允许打开本地路径。' };
  if (platform === 'win32' && isUncOrDevicePath(targetPath)) return { ok: false, error: '不允许打开网络或设备路径。' };
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(targetPath)) return { ok: false, error: '只允许打开绝对路径。' };
  if (hasBlockedOpenPathExtension(targetPath)) return { ok: false, error: '出于安全原因，不允许打开可执行文件。' };
  let realPath;
  let stats;
  try {
    realPath = fsImpl.realpathSync(targetPath);
    stats = fsImpl.statSync(realPath);
  } catch {
    return { ok: false, error: '路径不存在。' };
  }
  if (platform === 'win32' && isUncOrDevicePath(realPath)) return { ok: false, error: '不允许打开网络或设备路径。' };
  if (hasBlockedOpenPathExtension(realPath)) return { ok: false, error: '出于安全原因，不允许打开可执行文件。' };
  if (!stats.isDirectory()) return { ok: false, error: '只允许打开文件夹。' };
  return { ok: true, path: realPath };
};

// ---------------------------------------------------------------------------
// RDP input
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

const stripControlChars = value => String(value ?? '').replace(CONTROL_CHARS, '');

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*\.?$/i;
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6_RE = /^[0-9a-f:]+(?:%[a-z0-9_.-]+)?$/i;

const isValidIpv6 = value => {
  if (!IPV6_RE.test(value)) return false;
  const address = value.split('%')[0];
  if (!address.includes(':') || (address.match(/::/g) || []).length > 1) return false;
  const groups = address.split(':');
  if (groups.length > 8) return false;
  return groups.every(group => group.length <= 4);
};

const isValidRdpHost = value => {
  if (typeof value !== 'string' || !value) return false;
  const unbracketed = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  if (unbracketed !== value) return isValidIpv6(unbracketed);
  return IPV4_RE.test(value) || HOSTNAME_RE.test(value) || isValidIpv6(value);
};

/**
 * Validate and normalise RDP connection details coming from the renderer.
 * Returns { ok: true, host, port, username, server } or { ok: false, error }.
 * `server` is "host[:port]" with IPv6 hosts bracketed when a port is given.
 */
const sanitizeRdpConnection = (details = {}) => {
  const input = details && typeof details === 'object' ? details : {};
  const host = stripControlChars(input.host).trim();
  if (!host) return { ok: false, error: '缺少 RDP 主机地址。' };
  if (!isValidRdpHost(host)) return { ok: false, error: 'RDP 主机地址格式无效。' };

  let port = null;
  const rawPort = input.port;
  if (rawPort !== undefined && rawPort !== null && String(rawPort).trim() !== '') {
    const portText = stripControlChars(rawPort).trim();
    if (!/^\d{1,5}$/.test(portText)) return { ok: false, error: 'RDP 端口无效。' };
    port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'RDP 端口无效。' };
  }

  const username = stripControlChars(input.username).trim();
  if (username.length > 256) return { ok: false, error: 'RDP 用户名过长。' };
  if (/["]/.test(username)) return { ok: false, error: 'RDP 用户名包含非法字符。' };

  const bareHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const isV6 = bareHost.includes(':');
  const hostForServer = isV6 && port ? `[${bareHost}]` : host;
  const server = port ? `${hostForServer}:${port}` : hostForServer;
  return { ok: true, host: bareHost, port, username: username || null, server };
};

const buildRdpFileContent = ({ server, username }) => [
  `full address:s:${stripControlChars(server)}`,
  username ? `username:s:${stripControlChars(username)}` : '',
  'prompt for credentials:i:1',
  'authentication level:i:2',
  'screen mode id:i:2',
].filter(Boolean).join('\n');

module.exports = {
  BLOCKED_OPEN_PATH_EXTENSIONS,
  buildRdpFileContent,
  getUrlOrigin,
  hasBlockedOpenPathExtension,
  isSafeExternalUrl,
  isTrustedOrigin,
  isValidRdpHost,
  sanitizeRdpConnection,
  stripControlChars,
  validateOpenPathRequest,
};
