/** Produce one isolated Vite + React-regression artifact with source maps.
 * Always uses a new OS temp directory. Never writes clients/web/dist. */
import { mkdtemp, readFile, readdir, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { build as viteBuild } from 'vite';
import { build as esbuild } from 'esbuild';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scratch = await mkdtemp(join(tmpdir(), 'remote-pi-p87-web-'));
const outDir = join(scratch, 'site');
const typecheck = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--incremental', 'false'], { cwd: root, stdio: 'inherit' });
if (typecheck.status !== 0) throw Error('Isolated artifact typecheck failed');
process.env.REMOTE_PI_HISTORY_TEST_PROBE = '1';
await viteBuild({ root, configFile: join(root, 'vite.config.ts'), build: { outDir, sourcemap: true, emptyOutDir: true } });
await esbuild({
  absWorkingDir: root,
  entryPoints: ['scripts/history-hook.browser.ts', 'scripts/history-viewer.browser.tsx', 'scripts/session-reopen.browser.ts'],
  outdir: outDir, bundle: true, splitting: true, chunkNames: 'regression/chunk-[hash]', format: 'esm', platform: 'browser', target: 'es2020',
  sourcemap: true, tsconfig: join(root, 'tsconfig.json'),
  define: { __REMOTE_PI_HISTORY_TEST_BUILD__: 'true', 'process.env.NODE_ENV': '"development"' },
});
const assets = await readdir(join(outDir, 'assets'));
const globalCSS = assets.filter(name => name.endsWith('.css')).map(name => `<link rel="stylesheet" href="/assets/${name}">`).join('\n');
await writeFile(join(outDir, 'history-regression.html'), `<!doctype html><html><head><meta charset="utf-8">${globalCSS}
<link rel="stylesheet" href="/history-hook.browser.css">
<link rel="stylesheet" href="/history-viewer.browser.css"></head><body><div id="root"></div>
<script>globalThis.__REMOTE_PI_HISTORY_TEST_PROBE__=true;</script>
<script type="module" src="/history-hook.browser.js"></script>
<script type="module" src="/history-viewer.browser.js"></script>
<script type="module" src="/session-reopen.browser.js"></script></body></html>`);
await copyFile(join(root, 'scripts/probe-history-acceptance.mjs'), join(scratch, 'probe-history-acceptance.mjs'));
await mkdir(join(scratch, 'evidence'));
const files = [];
async function hashes(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await hashes(path);
    else {
      const bytes = await readFile(path);
      files.push({ path: relative(scratch, path).replaceAll('\\', '/'), bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
}
await hashes(outDir);
files.sort((a, b) => a.path.localeCompare(b.path));
const treeHash = createHash('sha256').update(JSON.stringify(files)).digest('hex');
const manifest = { schema: 1, scratch, outDir, probeBuild: true, runtimeOptIn: '__REMOTE_PI_HISTORY_TEST_PROBE__=true before navigation',
  builtAt: new Date().toISOString(), treeHash, files };
await writeFile(join(scratch, 'artifact.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ scratch, outDir, manifest: join(scratch, 'artifact.json'), treeHash,
  sourceMaps: files.filter(file => file.path.endsWith('.map')).length, regressionURL: '/history-regression.html' }, null, 2));
