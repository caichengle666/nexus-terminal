// Bundles src/composables/useWebSocketConnection.ts with esbuild into a temporary ESM
// file and runs the node:test suite against it (fake WebSocket + mock timers).
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = mkdtempSync(path.join(tmpdir(), 'nexus-ws-reconnect-'));
const outFile = path.join(outDir, 'ws.mjs');

try {
  await build({
    entryPoints: [path.resolve(here, '../src/composables/useWebSocketConnection.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: outFile,
    logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const result = spawnSync(process.execPath, ['--test', path.join(here, 'ws-reconnect.test.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, WS_MODULE: outFile },
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
