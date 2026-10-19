// Bundles src/features/appearance/glass-effect.ts with esbuild and runs glass-effect.test.mjs against it.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = mkdtempSync(path.join(tmpdir(), 'nexus-glass-effect-'));

try {
  const outfile = path.join(outDir, 'glass-effect.mjs');
  await build({
    entryPoints: [path.resolve(here, '../src/features/appearance/glass-effect.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'error',
  });
  const result = spawnSync(process.execPath, ['--test', path.join(here, 'glass-effect.test.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, GLASS_EFFECT_MODULE: outfile },
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
