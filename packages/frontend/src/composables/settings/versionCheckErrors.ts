// Turns update-check failures into a short, localized reason such as
// "api.github.com: 超时 · github.com: DNS 解析失败" so "检查失败" is never shown
// without a cause. Pure (no Vue) so it is unit tested in node
// (test/unit/versionCheckErrors.test.ts).

/** One source tried by the check (electron-app/update-release-check.js returns these). */
export type ReleaseCheckAttempt = {
  source: string;
  step?: string;
  ok: boolean;
  code?: string;
  status?: number;
  detail?: string;
};

type Translate = (key: string, params?: Record<string, unknown>) => string;

// Reason codes -> settings.about.checkErrorReason.<key>
const REASON_KEYS: Record<string, string> = {
  timeout: 'timeout',
  dns: 'dns',
  reset: 'reset',
  refused: 'refused',
  proxy: 'proxy',
  tls: 'tls',
  offline: 'offline',
  network: 'network',
  http: 'http',
  'rate-limit': 'rateLimit',
  'not-found': 'notFound',
  'invalid-response': 'invalidResponse',
  'too-large': 'tooLarge',
  blocked: 'blocked',
};

/** Classifies an axios (or fetch) error from the renderer-side check used on the web. */
export const classifyRendererCheckError = (error: any, source = 'api.github.com'): ReleaseCheckAttempt => {
  const status = Number(error?.response?.status) || undefined;
  const detail = String([error?.code, error?.message].filter(Boolean).join(' ')).slice(0, 160) || undefined;
  if (status) {
    const code = status === 403 || status === 429 ? 'rate-limit' : status === 404 ? 'not-found' : 'http';
    return { source, ok: false, code, status, detail };
  }
  const raw = `${error?.code || ''} ${error?.message || ''}`;
  if (/ECONNABORTED|ETIMEDOUT|timeout/i.test(raw)) return { source, ok: false, code: 'timeout', detail };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { source, ok: false, code: 'offline', detail };
  if (/Invalid API response|JSON/i.test(raw)) return { source, ok: false, code: 'invalid-response', detail };
  return { source, ok: false, code: 'network', detail };
};

export const describeAttemptReason = (attempt: ReleaseCheckAttempt, t: Translate): string => {
  const key = REASON_KEYS[attempt.code || ''] || 'network';
  return t(`settings.about.checkErrorReason.${key}`, { status: attempt.status ?? '' });
};

/** "source: reason · source: reason" for every failed attempt (sources de-duplicated, first reason kept per step). */
export const formatCheckFailureDetail = (attempts: ReleaseCheckAttempt[] | null | undefined, t: Translate): string => {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const attempt of attempts || []) {
    if (!attempt || attempt.ok) continue;
    const reason = describeAttemptReason(attempt, t);
    const line = `${attempt.source || '?'}: ${reason}`;
    if (seen.has(line)) continue;
    seen.add(line);
    parts.push(line);
  }
  return parts.join(' · ');
};

/** True when every source answered "no such release" (HTTP 404). */
export const isNoReleasesFailure = (attempts: ReleaseCheckAttempt[] | null | undefined): boolean => {
  const failed = (attempts || []).filter(attempt => attempt && !attempt.ok);
  return failed.length > 0 && failed.every(attempt => attempt.code === 'not-found');
};
