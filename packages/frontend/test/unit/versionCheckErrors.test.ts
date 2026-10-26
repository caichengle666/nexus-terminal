import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  classifyRendererCheckError,
  describeAttemptReason,
  formatCheckFailureDetail,
  isNoReleasesFailure,
} from '../../src/composables/settings/versionCheckErrors';

// Resolve keys against the real zh-CN locale so a missing string fails here too.
const zh = JSON.parse(readFileSync(path.resolve(process.cwd(), 'src/locales/zh-CN.json'), 'utf8'));
const en = JSON.parse(readFileSync(path.resolve(process.cwd(), 'src/locales/en-US.json'), 'utf8'));
const makeT = (messages: any) => (key: string, params: Record<string, unknown> = {}) => {
  const value = key.split('.').reduce((node, part) => node?.[part], messages);
  assert.equal(typeof value, 'string', `missing locale key ${key}`);
  return (value as string).replace(/\{(\w+)\}/g, (_m, name) => String(params[name] ?? ''));
};
const t = makeT(zh);

test('versionCheckErrors：每个尝试的来源和原因都会显示', () => {
  const detail = formatCheckFailureDetail([
    { source: 'api.github.com', step: 'api', ok: false, code: 'timeout' },
    { source: 'github.com', step: 'page', ok: false, code: 'dns', detail: 'net::ERR_NAME_NOT_RESOLVED' },
    { source: 'ghproxy.example', step: 'mirror-api', ok: false, code: 'http', status: 502 },
  ], t);
  assert.equal(detail, 'api.github.com: 连接超时 · github.com: DNS 解析失败 · ghproxy.example: HTTP 502');
});

test('versionCheckErrors：成功的尝试和重复原因不显示', () => {
  const detail = formatCheckFailureDetail([
    { source: 'm.example', step: 'mirror-api', ok: false, code: 'reset' },
    { source: 'm.example', step: 'mirror-page', ok: false, code: 'reset' },
    { source: 'github.com', ok: true },
  ], t);
  assert.equal(detail, 'm.example: 连接被重置');
  assert.equal(formatCheckFailureDetail([], t), '');
  assert.equal(formatCheckFailureDetail(undefined, t), '');
});

test('versionCheckErrors：每种原因码都有三语文案', () => {
  const tEn = makeT(en);
  for (const code of ['timeout', 'dns', 'reset', 'refused', 'proxy', 'tls', 'offline', 'network', 'http', 'rate-limit', 'not-found', 'invalid-response', 'too-large', 'blocked', 'unknown-code']) {
    assert.ok(describeAttemptReason({ source: 'x', ok: false, code, status: 418 }, t));
    assert.ok(describeAttemptReason({ source: 'x', ok: false, code, status: 418 }, tEn));
  }
  assert.equal(describeAttemptReason({ source: 'x', ok: false, code: 'rate-limit', status: 403 }, t), 'HTTP 403（GitHub 限流）');
});

test('versionCheckErrors：网页端 axios 错误分类（超时 / HTTP / 网络）', () => {
  assert.equal(classifyRendererCheckError({ code: 'ECONNABORTED', message: 'timeout of 15000ms exceeded' }).code, 'timeout');
  assert.deepEqual(
    (({ code, status, source }) => ({ code, status, source }))(classifyRendererCheckError({ response: { status: 403 }, message: 'Request failed with status code 403' })),
    { code: 'rate-limit', status: 403, source: 'api.github.com' },
  );
  assert.equal(classifyRendererCheckError({ response: { status: 404 } }).code, 'not-found');
  assert.equal(classifyRendererCheckError({ response: { status: 500 } }).code, 'http');
  assert.equal(classifyRendererCheckError({ code: 'ERR_NETWORK', message: 'Network Error' }).code, 'network');
  assert.equal(classifyRendererCheckError(new Error('Invalid API response format')).code, 'invalid-response');
});

test('versionCheckErrors：全部 404 才算“未找到发布版本”', () => {
  assert.equal(isNoReleasesFailure([{ source: 'a', ok: false, code: 'not-found' }, { source: 'b', ok: false, code: 'not-found' }]), true);
  assert.equal(isNoReleasesFailure([{ source: 'a', ok: false, code: 'not-found' }, { source: 'b', ok: false, code: 'timeout' }]), false);
  assert.equal(isNoReleasesFailure([]), false);
});
