// Bundles the pure AI tool helpers (src/stores/ai/ai.tools.ts) with esbuild into a
// temporary ESM file and runs the node:test suite against it. No extra deps needed.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = mkdtempSync(path.join(tmpdir(), 'nexus-ai-tools-'));
const outFile = path.join(outDir, 'ai.tools.mjs');

try {
  await build({
    entryPoints: [path.resolve(here, '../src/stores/ai/ai.tools.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: outFile,
    logLevel: 'error',
  });
  const result = spawnSync(process.execPath, ['--test', path.join(here, 'ai-tools.test.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, AI_TOOLS_MODULE: outFile },
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
