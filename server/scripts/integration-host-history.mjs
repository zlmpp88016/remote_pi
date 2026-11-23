#!/usr/bin/env node
/** Owned, zero-Pi acceptance host. Never loads the production dist or identity. */
import { mkdtemp, mkdir, readFile, writeFile, open, symlink, realpath, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const server = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webDist = process.env.REMOTE_PI_WEB_DIST ?? 'C:/Users/zlmpp/.pi/agent/tmp/rp86-web-AAR4zy/dist';

const HELP = `integration-host-history.mjs — owned, zero-Pi loopback fixture
  --smoke             run the existing small wire smoke and exit
  --large             add P87_LARGE (9 x 5000 entries, 2560-byte unique Markdown)
                      and P87_MANY (1000 small sessions); original markers stay
  --port N            loopback port, default 0 (OS selected); e.g. 61986 for
                      the isolated Android prefill. No fallback if occupied.
  --help              print this text without compilation or starting a listener
REMOTE_PI_WEB_DIST selects an existing isolated Web artifact. Never server/dist.
Large default history_read limit 30 gives 167 pages/session (166 older requests).
No credentials are printed; readiness contains only synthetic fixture metadata.
`;

export function parseFixtureArgs(args) {
  const options = { smoke: false, large: false, port: 0, help: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error(`duplicate option ${flag}`);
    seen.add(flag);
    if (flag === '--smoke') options.smoke = true;
    else if (flag === '--large') options.large = true;
    else if (flag === '--help') options.help = true;
    else if (flag === '--port') {
      const value = args[++i];
      if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 65535) {
        throw new Error('--port must be an integer in 0..65535');
      }
      options.port = Number(value);
      if ([3001, 9444].includes(options.port)) throw new Error('reserved user port');
    } else throw new Error(`unsupported option ${flag}`);
  }
  return options;
}

export const LARGE_FIXTURE = Object.freeze({ entries: 5000, textBytes: 2560, sessions: 9, manySessions: 1000, readLimit: 30 });

/** Each complete body fits the unchanged 4KiB row preview and is distinct. */
export function fixtureMarkdown(sessionId, index, marker = '') {
  const digest = createHash('sha256').update(`${sessionId}:${index}`).digest('hex');
  const prefix = `# Synthetic history ${sessionId} / ${index}\n\n` +
    `Entry key: ${digest}.\n\n- Review the independent message ${index}.\n- Keep the saved scroll position.\n\n` +
    `| Field | Value |\n| --- | --- |\n| session | ${sessionId} |\n| entry | ${index} |\n\n` +
    '```js\n' + `const entry = { session: "${sessionId}", index: ${index}, checksum: "${digest}" };\n` + '```\n\n';
  const paragraph = `Markdown paragraph ${index} for ${sessionId}: **distinct content** ${digest}. ` +
    'The history page keeps chronological messages and can revisit an evicted page using the real host cursor.\n\n';
  const suffix = `\n\n${marker || `RP87_${sessionId}_${index}`}\n`;
  const remaining = LARGE_FIXTURE.textBytes - Buffer.byteLength(prefix + suffix);
  assert.ok(remaining > 0, 'fixture label too long');
  const text = prefix + paragraph.repeat(Math.ceil(remaining / paragraph.length)).slice(0, remaining) + suffix;
  assert.equal(Buffer.byteLength(text), LARGE_FIXTURE.textBytes);
  return text;
}

export function createFixtureFleet(workspaces, calls) {
  const forbidden = name => () => { calls.push(name); throw new Error('fixture fleet mutation forbidden'); };
  return { list: () => workspaces.map(({ id, cwd, name }) => ({ id, cwd, name, live: false, source: 'added', daemon: false })),
    runtime: id => workspaces.some(ws => ws.id === id) ? { state: 'stopped', session_id: null, ready: false } : null,
    ...Object.fromEntries(['ensure', 'start', 'stop', 'addWorkspace', 'removeWorkspace'].map(name => [name, forbidden(name)])) };
}

async function writeFixtureSession(bucket, { sessionId, cwd, name, count, textFor, timeOffset = 0 }) {
  const file = join(bucket, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
  const handle = await open(file, 'wx');
  const hash = createHash('sha256');
  let bytes = 0;
  let textBytes = 0;
  const emit = async value => {
    const line = JSON.stringify(value) + '\n';
    hash.update(line);
    bytes += Buffer.byteLength(line);
    await handle.writeFile(line);
  };
  try {
    await emit({ type: 'session', id: sessionId, cwd, timestamp: '2026-01-01T00:00:00.000Z' });
    await emit({ type: 'session_info', name });
    for (let n = 0; n < count; n++) {
      const text = textFor(n);
      textBytes += Buffer.byteLength(text);
      await emit({ type: 'message', id: `event-${n}`, parentId: n ? `event-${n - 1}` : null,
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, timeOffset + n + 1)).toISOString(),
        message: n % 2 ? { role: 'assistant', content: [{ type: 'text', text }] } : { role: 'user', content: text } });
    }
  } finally { await handle.close(); }
  return { session_id: sessionId, name, entries: count, file_bytes: bytes, text_bytes: textBytes, sha256: hash.digest('hex') };
}


/** Credentials stay in memory. Caller must never print the returned object. */
export async function fetchFixtureBootstrap(origin) {
  const url = new URL(origin);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.protocol, 'http:');
  const page = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  assert.equal(page.status, 200, 'fixture page');
  const cookie = page.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'bootstrap cookie');
  await page.arrayBuffer();
  const response = await fetch(new URL('/api/bootstrap', url), {
    method: 'POST', headers: { cookie, origin: url.origin },
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200, 'bootstrap status');
  const view = await response.json();
  assert.ok(typeof view.hostEpk === 'string' && typeof view.token === 'string' && typeof view.name === 'string', 'bootstrap shape');
  return view;
}

async function smoke(origin, workspaces, bridge, calls, version) {
  assert.equal((await fetch(`${origin}/healthz`)).status, 200, 'health');
  const page = await fetch(origin, { signal: AbortSignal.timeout(10_000) });
  assert.equal(page.status, 200, 'Web index status');
  const html = await page.text();
  const expectedHtml = await readFile(join(webDist, 'index.html'), 'utf8');
  assert.equal(html, expectedHtml, 'selected Web dist index served');
  await fetchFixtureBootstrap(origin);
  const abort = new AbortController();
  const response = await fetch(`${origin}/api/events`, { signal: abort.signal });
  assert.equal(response.status, 200, 'SSE status');
  const reader = response.body.getReader();
  let pending = '';
  const events = [];
  const decoder = new TextDecoder();
  const pump = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        pending += decoder.decode(chunk.value, { stream: true });
        let end;
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const block = pending.slice(0, end);
          pending = pending.slice(end + 2);
          const data = block.split('\n').find(line => line.startsWith('data: '));
          if (!data) continue;
          const value = JSON.parse(data.slice(6));
          events.push(block.includes('event: endpoint') ? { endpoint: value.id } : value);
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    }
  })();
  // Attach immediately so a broken stream cannot become an unhandled rejection.
  let streamFailed = false;
  void pump.catch(() => { streamFailed = true; });
  async function wait(predicate) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !streamFailed) {
      const value = events.find(predicate);
      if (value) return value;
      await new Promise(done => setTimeout(done, 20));
    }
    throw new Error('fixture wire response timeout');
  }
  try {
    const endpoint = (await wait(event => event.endpoint)).endpoint;
    let sequence = 0;
    async function query(request) {
      const id = `fixture-${++sequence}`;
      const posted = await fetch(`${origin}/api/frame?id=${encodeURIComponent(endpoint)}`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ ...request, id }), signal: AbortSignal.timeout(10_000),
      });
      assert.equal(posted.status, 204, 'frame POST');
      const envelope = await wait(event => {
        if (typeof event.ct !== 'string') return false;
        return JSON.parse(Buffer.from(event.ct, 'base64').toString()).in_reply_to === id;
      });
      return JSON.parse(Buffer.from(envelope.ct, 'base64').toString());
    }
    const hello = await query({ type: 'host_hello' });
    assert.equal(hello.type, 'host_hello_ok', 'host hello');
    assert.ok(hello.daemon && typeof hello.daemon === 'object' && !Array.isArray(hello.daemon), 'host daemon shape');
    for (const field of ['version', 'hostname', 'platform']) {
      assert.equal(typeof hello.daemon[field], 'string', `host daemon ${field}`);
    }
    assert.equal(hello.daemon.version, version, 'real server package version');
    assert.ok(Array.isArray(hello.capabilities) && hello.capabilities.every(value => typeof value === 'string'), 'host capabilities shape');
    for (const workspace of workspaces) {
      let listed;
      for (let attempt = 0; attempt < 30; attempt++) {
        listed = await query({ type: 'history_list', daemon_id: workspace.id });
        if (listed.type === 'history_list_ok' && listed.sessions.some(session => session.id === workspace.session_id)) break;
        assert.ok(listed.type === 'history_list_ok' || (listed.type === 'history_error' && listed.code === 'building'), 'list outcome');
        await new Promise(done => setTimeout(done, 100));
      }
      assert.equal(listed.type, 'history_list_ok', 'history list');
      assert.ok(listed.sessions.some(session => session.id === workspace.session_id), 'owned session listed');
      let read;
      for (let attempt = 0; attempt < 30; attempt++) {
        read = await query({ type: 'history_read', daemon_id: workspace.id, session_id: workspace.session_id });
        if (read.type !== 'history_error' || read.code !== 'building') break;
        await new Promise(done => setTimeout(done, 100));
      }
      assert.equal(read.type, 'history_read_ok', 'history read');
      assert.ok(JSON.stringify(read.items).includes(workspace.marker), 'latest visible marker');
    }
    assert.equal(bridge.historyService.workerMode(), 'threads', 'actual compiled worker mode');
    assert.equal(calls.length, 0, 'zero fleet mutations / Pi spawn');
  } finally {
    abort.abort();
    await reader.cancel().catch(() => {});
    await pump;
  }
}

async function main() {
  const options = parseFixtureArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(HELP); return; }
  const scratch = await mkdtemp(join(tmpdir(), 'rp86-host-'));
  let bridge;
  let stopRelay;
  let cleaning;
  const calls = [];
  const cleanup = () => cleaning ??= (async () => {
    try { await bridge?.stop(); } finally {
      try { await stopRelay?.(); } finally {
        await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        process.stdout.write(JSON.stringify({ fleet_mutations: calls.length, zero_pi: calls.length === 0 }) + '\n');
      }
    }
  })();
  try {
    const modules = await realpath(join(server, 'node_modules'));
    await access(join(modules, 'typescript/bin/tsc'));
    await access(join(webDist, 'index.html'));
    const { version, type } = JSON.parse(await readFile(join(server, 'package.json'), 'utf8'));
    assert.equal(typeof version, 'string', 'server package version');
    assert.equal(type, 'module', 'server package ESM');
    await writeFile(join(scratch, 'package.json'), JSON.stringify({ version, type }) + '\n');
    await symlink(modules, join(scratch, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const entries = ['direct.ts', 'daemon/host_bridge.ts', 'pairing/host_pairing.ts', 'pairing/qr.ts', 'pairing/storage.ts', 'daemon/id.ts', 'session/history_worker_main.ts'];
    const compiled = spawnSync(process.execPath, [join(modules, 'typescript/bin/tsc'),
      '--ignoreConfig', '--outDir', join(scratch, 'dist'), '--rootDir', join(server, 'src'),
      '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022',
      '--skipLibCheck', '--declaration', 'false', '--sourceMap', 'false', '--types', 'node',
      ...entries.map(entry => join(server, 'src', entry))], { cwd: server, encoding: 'utf8', timeout: 120_000 });
    if (compiled.status !== 0) {
      process.stderr.write(compiled.stdout ?? '');
      process.stderr.write(compiled.stderr ?? '');
      throw new Error('fixture scratch compile failed');
    }
    const remoteHome = join(scratch, 'home');
    const agentRoot = join(scratch, 'agent');
    Object.assign(process.env, { REMOTE_PI_HOME: remoteHome, PI_CODING_AGENT_DIR: agentRoot,
      REMOTE_PI_BIND: '127.0.0.1', REMOTE_PI_WEB_DIST: webDist, REMOTE_PI_LOG: 'off' });
    for (const key of ['REMOTE_PI_RELAY', 'REMOTE_PI_PUBLIC_RELAY', 'REMOTE_PI_PAIRING_CODE', 'REMOTE_PI_LOG_FILE', 'REMOTE_PI_ALLOWED_HOSTS']) delete process.env[key];
    const { getPublicKeyAsync } = await import('@noble/ed25519');
    const seed = randomBytes(32);
    const publicKey = await getPublicKeyAsync(seed);
    const identityDir = join(remoteHome, '.pi', 'remote');
    await mkdir(identityDir, { recursive: true, mode: 0o700 });
    await writeFile(join(identityDir, 'identity.json'), JSON.stringify({ pk: Buffer.from(publicKey).toString('base64'), sk: seed.toString('base64') }), { mode: 0o600 });
    const load = relative => import(pathToFileURL(join(scratch, 'dist', relative)).href);
    const direct = await load('direct.js');
    stopRelay = direct.stopDirectRelay;
    const { HostPairingSession } = await load('pairing/host_pairing.js');
    const { HostBridge } = await load('daemon/host_bridge.js');
    const { daemonIdForCwd } = await load('daemon/id.js');
    const { sessionDirFor } = await load('session/session_paths.js');
    const pairing = new HostPairingSession();
    await pairing.issue({});
    const origin = await direct.ensureDirectRelay({ port: options.port });
    assert.equal(new URL(origin).hostname, '127.0.0.1', 'loopback-only fixture');
    if (options.port !== 0) assert.equal(Number(new URL(origin).port), options.port, 'explicit port has no fallback');
    process.env.REMOTE_PI_RELAY = origin;
    const workspaces = [];
    for (const [index, name, marker] of [[0, 'P86_SMOKE', 'RP86_SMALL_LAST'], [1, 'P86_OTHER', 'RP86_OTHER_LAST']]) {
      const cwd = join(scratch, `workspace-${index}`);
      await mkdir(cwd, { recursive: true });
      const bucket = sessionDirFor(cwd, agentRoot);
      await mkdir(bucket, { recursive: true });
      const session_id = `rp86-session-${index}`;
      const lines = [{ type: 'session', id: session_id, cwd, timestamp: '2026-01-01T00:00:00.000Z' }, { type: 'session_info', name }];
      const count = index === 0 ? 50 : 10;
      for (let n = 0; n < count; n++) {
        const text = n === count - 1 ? marker : `RP86 fixture ${index} message ${n}`;
        lines.push({ type: 'message', id: `event-${n}`, parentId: n ? `event-${n - 1}` : null,
          timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, n + 1)).toISOString(),
          message: n % 2 ? { role: 'assistant', content: [{ type: 'text', text }] } : { role: 'user', content: text } });
      }
      await writeFile(join(bucket, `2026-01-01T00-00-00-000Z_${session_id}.jsonl`), lines.map(line => JSON.stringify(line)).join('\n') + '\n');
      workspaces.push({ id: daemonIdForCwd(cwd), cwd, name, session_id, marker });
    }
    if (options.large) {
      for (const [kind, name] of [['large', 'P87_LARGE'], ['many', 'P87_MANY']]) {
        const cwd = join(scratch, `workspace-${kind}`);
        await mkdir(cwd, { recursive: true });
        const bucket = sessionDirFor(cwd, agentRoot);
        await mkdir(bucket, { recursive: true });
        const sessions = [];
        const many = kind === 'many';
        const sessionCount = many ? LARGE_FIXTURE.manySessions : LARGE_FIXTURE.sessions;
        for (let index = 0; index < sessionCount; index++) {
          const sessionId = `rp87-${kind}-${String(index).padStart(4, '0')}`;
          const marker = `RP87_${kind.toUpperCase()}_${index}_LAST`;
          const count = many ? 2 : LARGE_FIXTURE.entries;
          const metadata = await writeFixtureSession(bucket, { sessionId, cwd, name: `${name}_${index}`, count,
            timeOffset: index * LARGE_FIXTURE.entries,
            textFor: n => many ? (n === count - 1 ? marker : `RP87 directory fixture ${index}`)
              : fixtureMarkdown(sessionId, n, n === count - 1 ? marker : '') });
          sessions.push({ ...metadata, marker });
        }
        const first = many ? sessions.at(-1) : sessions[0];
        if (!many) assert.ok(first.text_bytes > 8 * 1024 * 1024, 'single-session projection exceeds Web 8MiB budget');
        workspaces.push({ id: daemonIdForCwd(cwd), cwd, name, session_id: first.session_id, marker: first.marker,
          fixture: { kind, session_count: sessionCount, entries_per_session: many ? 2 : LARGE_FIXTURE.entries,
            text_bytes_per_entry: many ? null : LARGE_FIXTURE.textBytes,
            text_bytes_per_session: first.text_bytes, file_bytes_total: sessions.reduce((sum, item) => sum + item.file_bytes, 0),
            read_limit: LARGE_FIXTURE.readLimit, pages_per_session: Math.ceil(first.entries / LARGE_FIXTURE.readLimit),
            session_id_pattern: `rp87-${kind}-NNNN`,
            // Nine ready-to-open session IDs/hashes are useful; avoid a 1000-row stdout dump.
            sessions: many ? [first] : sessions } });
      }
    }
    const fleet = createFixtureFleet(workspaces, calls);
    bridge = new HostBridge({ fleet, pairing, history: { agentRoot, remoteHome, workerScript: join(scratch, 'dist/session/history_worker_main.js') } });
    await bridge.start();
    if (options.smoke) {
      await smoke(origin, workspaces, bridge, calls, version);
      process.stdout.write(JSON.stringify({ smoke: 'pass', workspaces: workspaces.length, worker_mode: 'threads', fleet_mutations: calls.length }) + '\n');
      await cleanup();
      return;
    }
    process.stdout.write(JSON.stringify({ origin, port: Number(new URL(origin).port), scratch, workspaces,
      mode: options.large ? 'large-fixture' : 'fixture', zero_pi: calls.length === 0,
      fixture_config: options.large ? LARGE_FIXTURE : null }) + '\n');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      void cleanup().then(() => process.exit(0), () => process.exit(1));
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write('RP86 fixture failed (no credentials or payload logged).\n'); process.exitCode = 1; });
}
