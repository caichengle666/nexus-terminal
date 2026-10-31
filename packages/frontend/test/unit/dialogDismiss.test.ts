import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveDismissAttempt } from '../../src/utils/dialogDismiss';

test('ordinary confirm dialogs still cancel on backdrop / Esc / external close', () => {
  for (const source of ['backdrop', 'escape', 'external'] as const) {
    assert.equal(resolveDismissAttempt(true, source), 'cancel');
    assert.equal(resolveDismissAttempt(undefined, source), 'cancel');
  }
});

test('modal (AI tool) confirm dialogs ignore every implicit dismiss', () => {
  for (const source of ['backdrop', 'escape', 'external'] as const) {
    assert.equal(resolveDismissAttempt(false, source), 'ignore');
  }
});

test('AI command and file-write confirmations are opened as modal dialogs', () => {
  // Bundled into a temp dir, so resolve the source from the repo checkout.
  const source = readFileSync(new URL('../../src/components/AiTerminalAssistant.vue', `file://${process.env.NEXUS_FRONTEND_DIR || process.cwd()}/test/unit/`), 'utf8');
  const command = source.slice(source.indexOf('const confirmAiCommand'), source.indexOf('// write_remote_file: always confirmed'));
  const write = source.slice(source.indexOf('const confirmAiFileWrite'), source.indexOf('const runOptions'));
  assert.match(command, /dismissible: false/);
  assert.match(write, /dismissible: false/);
});
