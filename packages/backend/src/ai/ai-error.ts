// Maps upstream AI provider failures to a status/code the frontend can act on.
//
// With `responseType: 'stream'` axios hands us the provider's error body as a
// readable stream, so it has to be drained (bounded) before the provider's
// message can be shown. Upstream 401/403 must never be forwarded as-is: the
// frontend treats our own 401 as "Nexus login expired" and would log the user
// out, so provider auth failures become 424 + code AI_AUTH instead.

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

export interface AiErrorResponse {
  status: number;
  code: AiErrorCode;
  message: string;
  providerStatus?: number;
}

export const MAX_ERROR_BODY_BYTES = 64 * 1024;
export const ERROR_BODY_TIMEOUT_MS = 3000;

const isReadableStream = (value: any): boolean => !!value
  && typeof value === 'object'
  && typeof value.on === 'function'
  && typeof value.pipe === 'function';

/** Reads at most `maxBytes` from a stream, giving up after `timeoutMs`. Never rejects. */
export const readStreamBody = (stream: any, maxBytes = MAX_ERROR_BODY_BYTES, timeoutMs = ERROR_BODY_TIMEOUT_MS): Promise<string> => (
  new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener?.('data', onData);
      stream.removeListener?.('end', finish);
      stream.removeListener?.('error', finish);
      stream.removeListener?.('close', finish);
      if (size >= maxBytes || !stream.readableEnded) stream.destroy?.();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = maxBytes - size;
      if (remaining <= 0) return finish();
      chunks.push(buffer.length > remaining ? buffer.subarray(0, remaining) : buffer);
      size += Math.min(buffer.length, remaining);
      if (size >= maxBytes) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    stream.on('data', onData);
    stream.once('end', finish);
    stream.once('error', finish);
    stream.once('close', finish);
    stream.resume?.();
  })
);

const pickMessage = (data: any): string => {
  if (!data) return '';
  if (typeof data === 'string') return data;
  if (typeof data !== 'object') return String(data);
  const error = data.error;
  if (typeof error === 'string') return error;
  if (error && typeof error.message === 'string') return error.message;
  if (typeof data.message === 'string') return data.message;
  if (typeof data.detail === 'string') return data.detail;
  if (Array.isArray(data) && data.length > 0) return pickMessage(data[0]);
  return '';
};

const pickProviderCode = (data: any): string => {
  const error = data && typeof data === 'object' ? (data.error ?? data) : undefined;
  const values = [error?.code, error?.type, error?.status];
  return values.filter(value => typeof value === 'string').join(' ').toLowerCase();
};

/** Parses a provider error body (JSON or plain text) into a short message. */
export const parseProviderErrorBody = (raw: string): { message: string; providerCode: string } => {
  const text = (raw || '').trim();
  if (!text) return { message: '', providerCode: '' };
  try {
    const parsed = JSON.parse(text);
    return { message: pickMessage(parsed).trim().slice(0, 2000), providerCode: pickProviderCode(parsed) };
  } catch {
    // Some providers answer with an SSE error event or plain text/HTML.
    const dataLine = text.split(/\r?\n/).find(line => line.startsWith('data:'));
    if (dataLine) {
      try {
        const parsed = JSON.parse(dataLine.slice(5).trim());
        return { message: pickMessage(parsed).trim().slice(0, 2000), providerCode: pickProviderCode(parsed) };
      } catch {
        // fall through to plain text
      }
    }
    const plain = /<html/i.test(text) ? '' : text;
    return { message: plain.slice(0, 500), providerCode: '' };
  }
};

const STREAM_UNSUPPORTED_PATTERN = /stream/i;

/** Builds the response for a failed AI call, draining a streamed error body when needed. */
export const resolveAiError = async (error: any, options: { streaming?: boolean; fallbackMessage?: string } = {}): Promise<AiErrorResponse> => {
  const fallbackMessage = options.fallbackMessage || 'AI request failed.';
  const upstreamStatus = Number(error?.response?.status) || 0;

  if (!upstreamStatus) {
    // Our own validation errors (status set on the Error) or network failures.
    const ownStatus = Number(error?.status) || 0;
    if (ownStatus) {
      return {
        status: ownStatus,
        code: ownStatus === 413 ? 'AI_TOO_LARGE' : ownStatus >= 500 ? 'AI_ERROR' : 'AI_BAD_REQUEST',
        message: error?.message || fallbackMessage,
      };
    }
    const errno = String(error?.code || '');
    if (errno === 'ECONNABORTED' || errno === 'ETIMEDOUT' || /timeout/i.test(String(error?.message || ''))) {
      return { status: 504, code: 'AI_TIMEOUT', message: error?.message || fallbackMessage };
    }
    if (['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(errno)) {
      return { status: 502, code: 'AI_UNREACHABLE', message: error?.message || fallbackMessage };
    }
    return { status: 500, code: 'AI_ERROR', message: error?.message || fallbackMessage };
  }

  let data = error.response.data;
  if (isReadableStream(data)) {
    data = await readStreamBody(data);
  } else if (Buffer.isBuffer(data)) {
    data = data.subarray(0, MAX_ERROR_BODY_BYTES).toString('utf8');
  }
  const parsed = typeof data === 'string'
    ? parseProviderErrorBody(data)
    : { message: pickMessage(data).trim().slice(0, 2000), providerCode: pickProviderCode(data) };
  const message = parsed.message || error?.message || fallbackMessage;
  const providerCode = parsed.providerCode;
  const base = { message, providerStatus: upstreamStatus };

  if (upstreamStatus === 401 || upstreamStatus === 403) return { ...base, status: 424, code: 'AI_AUTH' };
  if (upstreamStatus === 402 || /insufficient_quota|billing|quota/.test(providerCode)) return { ...base, status: 402, code: 'AI_QUOTA' };
  if (upstreamStatus === 429) return { ...base, status: 429, code: 'AI_RATE_LIMIT' };
  if (upstreamStatus === 413) return { ...base, status: 413, code: 'AI_TOO_LARGE' };
  if (upstreamStatus === 408 || upstreamStatus === 504) return { ...base, status: 504, code: 'AI_TIMEOUT' };
  if (options.streaming && [400, 404, 405, 415, 422, 501].includes(upstreamStatus)
    && (STREAM_UNSUPPORTED_PATTERN.test(message) || upstreamStatus === 405 || upstreamStatus === 415 || upstreamStatus === 501)) {
    return { ...base, status: 422, code: 'AI_STREAM_UNSUPPORTED' };
  }
  if (upstreamStatus === 404) return { ...base, status: 404, code: 'AI_NOT_FOUND' };
  if (upstreamStatus >= 400 && upstreamStatus < 500) return { ...base, status: upstreamStatus, code: 'AI_BAD_REQUEST' };
  return { ...base, status: 502, code: 'AI_UPSTREAM' };
};
