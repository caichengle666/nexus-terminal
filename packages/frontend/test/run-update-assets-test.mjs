// Bundles src/composables/settings/updateAssets.ts with esbuild into a temporary
// ESM file and runs the node:test suite against it.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = mkdtempSync(path.join(tmpdir(), 'nexus-update-assets-'));
const outFile = path.join(outDir, 'update-assets.mjs');

try {
  await build({
    entryPoints: [path.resolve(here, '../src/composables/settings/updateAssets.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: outFile,
    logLevel: 'error',
  });
  const result = spawnSync(process.execPath, ['--test', path.join(here, 'update-assets.test.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, UPDATE_ASSETS_MODULE: outFile },
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
