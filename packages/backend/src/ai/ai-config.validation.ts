/**
 * Pure helpers for validating the AI provider base URL and deciding which API key
 * may be sent to it. Kept free of DB / settings imports so they can be unit tested.
 *
 * Security model:
 * - The base URL must be an absolute http:// or https:// URL without embedded credentials.
 * - The stored (encrypted) API key is bound to the stored base URL. If a request supplies
 *   a different base URL it must also supply its own API key; the stored key is never
 *   sent to a base URL other than the one it was saved with (prevents key exfiltration
 *   by pointing the server at an attacker-controlled endpoint).
 * - Private / loopback / LAN hosts are intentionally ALLOWED, because many users run local
 *   LLM servers (Ollama, LM Studio, vLLM ...) on 127.0.0.1 or a LAN address. The key binding
 *   above means a stored key can still not be redirected to such a host. Note that an
 *   authenticated user can still make the server issue requests to internal hosts with a
 *   key of their own choosing (limited SSRF by design).
 */

export class AiConfigValidationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AiConfigValidationError';
    this.status = status;
  }
}

const parseHttpUrl = (value: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AiConfigValidationError('AI API Base URL 不是有效的 URL。');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AiConfigValidationError('AI API Base URL 只支持 http:// 或 https:// 协议。');
  }
  if (url.username || url.password) {
    throw new AiConfigValidationError('AI API Base URL 不能包含用户名或密码。');
  }
  if (!url.hostname) {
    throw new AiConfigValidationError('AI API Base URL 缺少主机名。');
  }
  return url;
};

/**
 * Validate and normalize a base URL. Returns the trimmed URL without trailing slashes
 * (the form used to build endpoints). Throws AiConfigValidationError (status 400).
 */
export const validateApiBaseUrl = (value: unknown): string => {
  const trimmed = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
  if (!trimmed) {
    throw new AiConfigValidationError('AI API Base URL is required.');
  }
  parseHttpUrl(trimmed);
  return trimmed;
};

/** Canonical form for comparing two base URLs (case-insensitive host, default port dropped, no trailing slash). */
export const canonicalApiBaseUrl = (value: unknown): string => {
  const trimmed = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}${url.search}`;
  } catch {
    return trimmed;
  }
};

export const isSameApiBaseUrl = (a: unknown, b: unknown) => {
  const left = canonicalApiBaseUrl(a);
  return !!left && left === canonicalApiBaseUrl(b);
};

export interface AiCredentialInput {
  apiBaseUrl?: unknown;
  apiKey?: unknown;
}

export interface AiStoredCredentials {
  apiBaseUrl: string;
  /** Decrypted stored key ('' when none is stored). */
  apiKey: string;
}

export interface AiResolvedCredentials {
  apiBaseUrl: string;
  apiKey: string;
  usesStoredKey: boolean;
}

/**
 * Decide the base URL and API key to use for an outgoing AI request.
 * Throws AiConfigValidationError when the base URL is invalid, or when the payload
 * points at a different base URL than the stored one without supplying its own key.
 */
export const resolveAiCredentials = (
  payload: AiCredentialInput,
  stored: AiStoredCredentials,
): AiResolvedCredentials => {
  const payloadBaseUrl = typeof payload.apiBaseUrl === 'string' ? payload.apiBaseUrl.trim() : '';
  const payloadKey = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '';
  const apiBaseUrl = validateApiBaseUrl(payloadBaseUrl || stored.apiBaseUrl);

  if (payloadKey) {
    return { apiBaseUrl, apiKey: payloadKey, usesStoredKey: false };
  }
  if (!stored.apiKey) {
    return { apiBaseUrl, apiKey: '', usesStoredKey: false };
  }
  if (!isSameApiBaseUrl(apiBaseUrl, stored.apiBaseUrl)) {
    throw new AiConfigValidationError('更换 AI API Base URL 时必须同时填写新的 API Key，已保存的 Key 不会发送到其他地址。');
  }
  return { apiBaseUrl, apiKey: stored.apiKey, usesStoredKey: true };
};

/**
 * Decide whether saving a config may keep the stored (encrypted) key.
 * Returns 'replace' when a new key is supplied, 'keep' when the base URL is unchanged,
 * and throws when the base URL changes without a new key.
 */
export const decideStoredKeyOnSave = (
  payload: AiCredentialInput,
  stored: { apiBaseUrl: string; hasApiKey: boolean },
): 'replace' | 'keep' | 'none' => {
  const payloadKey = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '';
  const payloadBaseUrl = typeof payload.apiBaseUrl === 'string' ? payload.apiBaseUrl.trim() : '';
  if (payloadBaseUrl) validateApiBaseUrl(payloadBaseUrl);
  if (payloadKey) return 'replace';
  if (!stored.hasApiKey) return 'none';
  if (payloadBaseUrl && !isSameApiBaseUrl(payloadBaseUrl, stored.apiBaseUrl)) {
    throw new AiConfigValidationError('更换 AI API Base URL 时必须同时填写新的 API Key，已保存的 Key 不会绑定到其他地址。');
  }
  return 'keep';
};
