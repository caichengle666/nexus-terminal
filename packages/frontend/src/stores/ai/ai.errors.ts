import type { ComposerTranslation } from 'vue-i18n';
import i18n from '../../i18n';

const t: ComposerTranslation = i18n.global.t;

// Codes produced by the backend (packages/backend/src/ai/ai-error.ts).
export type AiErrorCode =
  | 'AI_AUTH'
  | 'AI_QUOTA'
  | 'AI_RATE_LIMIT'
  | 'AI_NOT_FOUND'
  | 'AI_BAD_REQUEST'
  | 'AI_STREAM_UNSUPPORTED'
  | 'AI_TOO_LARGE'
  | 'AI_TIMEOUT'
  | 'AI_UNREACHABLE'
  | 'AI_UPSTREAM'
  | 'AI_ERROR';

const NON_RETRYABLE_STATUSES = new Set([400, 401, 402, 403, 404, 413, 422, 424]);
const NON_RETRYABLE_CODES = new Set<string>(['AI_AUTH', 'AI_QUOTA', 'AI_NOT_FOUND', 'AI_BAD_REQUEST', 'AI_STREAM_UNSUPPORTED', 'AI_TOO_LARGE']);

export const getAiErrorCode = (error: any): string => String(error?.response?.data?.code || error?.code || '');
export const getAiErrorStatus = (error: any): number => Number(error?.response?.status) || 0;
export const getAiProviderMessage = (error: any): string => String(error?.response?.data?.message || '').trim();

/** Network blips, timeouts, 408/409/429 and 5xx are retried; auth/quota/bad-request never are. */
export const isRetryableAiError = (error: any) => {
  const code = getAiErrorCode(error);
  if (NON_RETRYABLE_CODES.has(code)) return false;
  const status = getAiErrorStatus(error);
  if (!status) return true;
  if (NON_RETRYABLE_STATUSES.has(status)) return false;
  return status === 408 || status === 409 || status === 429 || status >= 500;
};

/** True only when the provider actually rejected streaming, so a non-stream retry can help. */
export const isStreamUnsupportedError = (error: any) => {
  const code = getAiErrorCode(error);
  if (code) return code === 'AI_STREAM_UNSUPPORTED';
  // Older backends without error codes.
  const status = getAiErrorStatus(error);
  if ([405, 415, 501].includes(status)) return true;
  return [400, 404, 422].includes(status) && /stream/i.test(getAiProviderMessage(error));
};

/** A user-facing, localized description of an AI request failure (keeps the provider's own message). */
export const describeAiError = (error: any, fallback?: string): string => {
  const code = getAiErrorCode(error);
  const status = getAiErrorStatus(error);
  const provider = getAiProviderMessage(error) || (status ? '' : String(error?.message || '').trim());
  const withProvider = (key: string) => {
    const base = t(key);
    return provider && provider !== base ? t('uxAi.errors.withProvider', { base, provider }) : base;
  };
  switch (code) {
    case 'AI_AUTH': return withProvider('uxAi.errors.auth');
    case 'AI_QUOTA': return withProvider('uxAi.errors.quota');
    case 'AI_RATE_LIMIT': return withProvider('uxAi.errors.rateLimit');
    case 'AI_NOT_FOUND': return withProvider('uxAi.errors.notFound');
    case 'AI_TOO_LARGE': return withProvider('uxAi.errors.tooLarge');
    case 'AI_TIMEOUT': return withProvider('uxAi.errors.timeout');
    case 'AI_UNREACHABLE': return withProvider('uxAi.errors.unreachable');
    case 'AI_STREAM_UNSUPPORTED': return withProvider('uxAi.errors.streamUnsupported');
    case 'AI_UPSTREAM': return withProvider('uxAi.errors.upstream');
    default: break;
  }
  if (status === 429) return withProvider('uxAi.errors.rateLimit');
  if (status === 402) return withProvider('uxAi.errors.quota');
  return provider || String(error?.message || '').trim() || fallback || t('uxAi.errors.generic');
};
