// Bundles every test/unit/*.test.ts (plus the src modules it imports) with esbuild into
// temporary ESM files and runs them with node:test. Keeps unit tests in TypeScript without
// adding a TS loader dependency.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const unitDir = path.join(here, 'unit');
const outDir = mkdtempSync(path.join(tmpdir(), 'nexus-unit-'));

try {
  const entries = readdirSync(unitDir).filter((f) => f.endsWith('.test.ts')).sort();
  await build({
    entryPoints: entries.map((f) => path.join(unitDir, f)),
    bundle: true,
    format: 'esm',
    platform: 'node',
    outdir: outDir,
    outExtension: { '.js': '.mjs' },
    logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const files = entries.map((f) => path.join(outDir, f.replace(/\.ts$/, '.mjs')));
  const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
