// Fails when the frontend locale files do not share exactly the same key set.
// Run: node --test test/i18n-keys.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const localesDir = path.resolve(here, '../src/locales');
const LOCALES = ['zh-CN', 'en-US', 'ja-JP'];
const REFERENCE = 'zh-CN';

function flatten(obj, prefix = '', out = new Map()) {
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value, full, out);
    } else {
      out.set(full, value);
    }
  }
  return out;
}

const flat = Object.fromEntries(
  LOCALES.map((locale) => {
    const raw = readFileSync(path.join(localesDir, `${locale}.json`), 'utf8');
    return [locale, flatten(JSON.parse(raw))];
  }),
);

for (const locale of LOCALES.filter((l) => l !== REFERENCE)) {
  test(`${locale} has the same keys as ${REFERENCE}`, () => {
    const ref = flat[REFERENCE];
    const cur = flat[locale];
    const missing = [...ref.keys()].filter((k) => !cur.has(k));
    const extra = [...cur.keys()].filter((k) => !ref.has(k));
    assert.deepEqual(
      { missing, extra },
      { missing: [], extra: [] },
      `${locale}: ${missing.length} key(s) missing, ${extra.length} extra key(s) compared with ${REFERENCE}`,
    );
  });
}

test('all locale values are non-empty strings', () => {
  const bad = [];
  for (const locale of LOCALES) {
    for (const [key, value] of flat[locale]) {
      if (typeof value !== 'string' || value.trim() === '') bad.push(`${locale}:${key}`);
    }
  }
  assert.deepEqual(bad, []);
});

// vue-i18n's own message compiler ships with vue-i18n; catch syntax errors such as an
// unescaped "@" (linked-message syntax) that would break a message at runtime.
test('all locale messages compile with vue-i18n', async (t) => {
  let baseCompile;
  try {
    ({ baseCompile } = await import('@intlify/message-compiler'));
  } catch {
    t.skip('@intlify/message-compiler not resolvable');
    return;
  }
  const bad = [];
  for (const locale of LOCALES) {
    for (const [key, value] of flat[locale]) {
      if (typeof value !== 'string') continue;
      const errors = [];
      baseCompile(value, { onError: (e) => errors.push(e.message) });
      if (errors.length) bad.push(`${locale}:${key} (${errors[0]})`);
    }
  }
  assert.deepEqual(bad, []);
});
