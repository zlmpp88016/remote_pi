/**
 * Repeatable, isolated Chromium runner for the deterministic React regressions.
 * Builds into one new OS-temp artifact (never dist/), serves it only on
 * loopback, blocks every non-loopback browser request and launches an already
 * installed local Playwright Core. No Host, Pi, relay, credentials, real session,
 * user browser, CDP 9333, or real-network acceptance is involved. Transport and
 * clock seams inside the React tests are intentionally fake.
 *
 * Run: node scripts/run-history-browser-regressions.mjs
 * Reuse artifact: node scripts/run-history-browser-regressions.mjs --artifact <site-dir>
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const mime = new Map([
  ['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'], ['.svg', 'image/svg+xml'],
  ['.woff', 'font/woff'], ['.woff2', 'font/woff2'], ['.png', 'image/png'],
]);

function locatePlaywright() {
  const candidates = [process.env.REMOTE_PI_PLAYWRIGHT_PACKAGE,
    resolve(root, '../../../ai-goofish-monitor/.venv/Lib/site-packages/playwright/driver/package')]
    .filter(Boolean);
  for (const candidate of candidates) {
    try {
      const entry = createRequire(join(candidate, 'package.json'))(candidate);
      if (entry.chromium?.launch) return entry.chromium;
    } catch { /* Use the next existing local package; never download. */ }
  }
  throw Error('Playwright Core not found; set REMOTE_PI_PLAYWRIGHT_PACKAGE to an existing local driver package.');
}

function parseArgs() {
  const args = process.argv.slice(2);
  let artifact = null;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--artifact') {
      artifact = args.shift();
      if (!artifact) throw Error('--artifact requires an existing site directory');
    } else throw Error(`Unknown argument: ${arg}`);
  }
  return artifact === null ? null : resolve(artifact);
}

function buildFreshArtifact() {
  const run = spawnSync(process.execPath, [join(root, 'scripts/build-history-artifact.mjs')], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  });
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  if (run.status !== 0) throw Error(`isolated artifact builder exited ${run.status ?? run.error}`);
  const start = run.stdout.lastIndexOf('{\n  "scratch"');
  if (start < 0) throw Error('isolated artifact builder did not print its manifest summary');
  return resolve(JSON.parse(run.stdout.slice(start)).outDir);
}

async function serveLocal(site) {
  const canonicalRoot = resolve(site);
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405).end(); return;
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const decoded = decodeURIComponent(url.pathname);
      const leaf = decoded === '/' ? '/history-regression.html' : decoded;
      const file = resolve(canonicalRoot, `.${normalize(leaf)}`);
      if (file !== canonicalRoot && !file.startsWith(canonicalRoot + sep)) {
        response.writeHead(404).end(); return;
      }
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': mime.get(extname(file)) ?? 'application/octet-stream',
        'content-length': body.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', ok);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  assert.notEqual(address.port, 9333, 'never bind the user CDP port');
  return { server, url: `http://127.0.0.1:${address.port}/history-regression.html` };
}

async function openTestPage(browser, url, localPort, pageErrors, initScript) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route('**/*', route => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.hostname === '127.0.0.1' && requestUrl.port === localPort) return route.continue();
    return route.abort('blockedbyclient');
  });
  page.on('pageerror', error => pageErrors.push(String(error?.message ?? error)));
  if (initScript) await page.addInitScript({ content: initScript });
  if (url) await page.goto(url, { waitUntil: 'load' });
  return page;
}

const providedArtifact = parseArgs();
const site = providedArtifact ?? buildFreshArtifact();
assert.ok((await stat(join(site, 'history-regression.html'))).isFile(), 'regression page missing from artifact');
const chromium = locatePlaywright();
const executablePath = process.env.REMOTE_PI_CHROMIUM_EXECUTABLE ?? chromium.executablePath();
assert.ok((await stat(executablePath)).isFile(), `installed Chromium not found: ${executablePath}`);
const local = await serveLocal(site);
let browser;
const pageErrors = [];
const results = {};
let failed = false;
try {
  browser = await chromium.launch({ headless: true, executablePath,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync',
      '--no-first-run', '--no-default-browser-check', '--disable-extensions'] });
  const localPort = new URL(local.url).port;
  const page = await openTestPage(browser, local.url, localPort, pageErrors);
  await page.waitForFunction(() => typeof window.runSessionReopenRegression === 'function' &&
    typeof window.runHistoryHookRegression === 'function' && typeof window.runHistoryViewerRegression === 'function');
  for (const [name, expression] of [
    ['sessionReopen', 'window.runSessionReopenRegression()'],
    ['historyHook', 'window.runHistoryHookRegression()'],
    ['historyViewer', 'window.runHistoryViewerRegression()'],
  ]) {
    results[name] = await page.evaluate(expression);
    assert.ok(Number.isInteger(results[name]?.checks) && results[name].checks > 0, `${name} returned no checks`);
  }
  assert.deepEqual(pageErrors, [], 'browser page errors');
  const evidence = { schema: 1, passed: true, browser: browser.version(), executablePath,
    artifact: site, results, pageErrors,
    semantics: 'Real React DOM, production store/hook/dispatcher and viewer; deterministic fake transport and clock. Not host/network end-to-end or performance acceptance.' };
  if (!providedArtifact) {
    const evidenceDir = join(site, '..', 'evidence');
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(join(evidenceDir, 'browser-regressions.json'), JSON.stringify(evidence, null, 2) + '\n');
  }
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  failed = true;
  console.error(error);
  console.error(JSON.stringify({ artifact: site, results, pageErrors }, null, 2));
} finally {
  if (browser) await browser.close();
  await new Promise(resolveClose => local.server.close(resolveClose));
}
if (failed) process.exitCode = 1;