// Bundles the pure AI helpers (src/stores/ai/ai.tools.ts, ai.memory.ts, ai.errors.ts)
// with esbuild into temporary ESM files and runs the node:test suites against them.
// The app's i18n module (Vite-only import.meta.glob) is replaced by a stub whose
// t() returns the key. No extra deps needed.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = mkdtempSync(path.join(tmpdir(), 'nexus-ai-tools-'));

const i18nStub = {
  name: 'i18n-stub',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /(^|\/)i18n$/ }, () => ({ path: 'i18n-stub', namespace: 'i18n-stub' }));
    pluginBuild.onLoad({ filter: /.*/, namespace: 'i18n-stub' }, () => ({
      contents: `export default { global: { t: (key, params) => params ? key + ' ' + JSON.stringify(params) : key } };`,
      loader: 'js',
    }));
  },
};

const bundle = async (entry, name) => {
  const outfile = path.join(outDir, `${name}.mjs`);
  await build({
    entryPoints: [path.resolve(here, entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'error',
    plugins: [i18nStub],
  });
  return outfile;
};

try {
  const env = {
    ...process.env,
    AI_TOOLS_MODULE: await bundle('../src/stores/ai/ai.tools.ts', 'ai.tools'),
    AI_MEMORY_MODULE: await bundle('../src/stores/ai/ai.memory.ts', 'ai.memory'),
    AI_ERRORS_MODULE: await bundle('../src/stores/ai/ai.errors.ts', 'ai.errors'),
  };
  const result = spawnSync(process.execPath, [
    '--test',
    path.join(here, 'ai-tools.test.mjs'),
    path.join(here, 'ai-memory-errors.test.mjs'),
  ], { stdio: 'inherit', env });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
