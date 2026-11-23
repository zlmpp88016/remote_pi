#!/usr/bin/env node
/**
 * Plan 87 host attribution. Builtins-only until the explicit scratch import.
 * No server/dist, SDK, identity, relay, Pi, or production state is used.
 * Root runs formal modes SERIALLY after all build lanes finish. --mode smoke
 * validates mechanics only; its numbers are never acceptance evidence.
 */
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { performance, PerformanceObserver } from 'node:perf_hooks';
import assert from 'node:assert/strict';

const script = fileURLToPath(import.meta.url);
const server = path.resolve(path.dirname(script), '..');
const INTERVAL_MS = 1;
const THRESHOLD_MS = 20; // Frozen criterion, including startup/GC/outliers.
const HELP = `host-timer-probe.mjs — scratch-only host attribution
Usage: node scripts/host-timer-probe.mjs --mode MODE --out OS_TEMP_FILE [options]
  --mode idle|imported-idle|cold|setup|smoke (required)
  --entries N         cold fixture entries (default 2100; legacy comparison 2000)
  --duration-ms N     standalone/imported idle duration (default 10000)
  --control-ms N      cold pre/post idle controls (default 10000)
  --deadline-ms N     cold request deadline (default 240000)
  --profile-main      separate diagnostic run: main-isolate inspector CPU + GC
  --interval-counters diagnostic-only: bracketed CPU/eLU snapshot per callback
                      adds observer overhead; never formal acceptance evidence
  --keep              retain this invocation's owned scratch tree
  --out FILE          new JSON file under the OS temp directory; never overwritten
  --help              no setup, imports, timers, or listener
setup compiles/hashes/creates the fixture but runs no timer windows or requests.
smoke uses 8 x 1KiB entries and 30ms controls; it cannot report acceptance PASS.
idle imports NO history modules and performs NO compilation or fixture creation.
cold includes lazy worker startup, unchanged service defaults, and full end tail.
Every callback, including the callback spanning completion, is preserved raw.
No delay, GC sample, startup sample, or outlier is removed; no idle subtraction.
`;

export function parseProbeArgs(args) {
  const result = { mode: null, entries: 2100, durationMs: 10000, controlMs: 10000,
    deadlineMs: 240000, profileMain: false, intervalCounters: false, keep: false, out: null, help: false };
  const seen = new Set();
  const numeric = { '--entries': ['entries', 1, 10000], '--duration-ms': ['durationMs', 1, 600000],
    '--control-ms': ['controlMs', 1, 600000], '--deadline-ms': ['deadlineMs', 100, 600000] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error(`duplicate option ${flag}`);
    seen.add(flag);
    if (flag === '--help') result.help = true;
    else if (flag === '--keep') result.keep = true;
    else if (flag === '--profile-main') result.profileMain = true;
    else if (flag === '--interval-counters') result.intervalCounters = true;
    else if (flag === '--mode' || flag === '--out' || numeric[flag]) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      if (numeric[flag]) {
        const [key, min, max] = numeric[flag];
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
          throw new Error(`${flag} must be an integer in ${min}..${max}`);
        }
        result[key] = Number(value);
      } else result[flag.slice(2)] = value;
    } else throw new Error(`unsupported option ${flag}`);
  }
  if (result.help) return result;
  if (!['idle', 'imported-idle', 'cold', 'setup', 'smoke'].includes(result.mode)) throw new Error('--mode is required');
  if (!result.out) throw new Error('--out is required');
  if (result.profileMain && !['cold', 'smoke'].includes(result.mode)) throw new Error('--profile-main requires cold or smoke');
  if (result.intervalCounters && result.mode === 'setup') throw new Error('--interval-counters requires a measured diagnostic window');
  if (result.mode === 'smoke') {
    if (['--entries', '--control-ms', '--duration-ms'].some(flag => seen.has(flag))) throw new Error('smoke size and controls are fixed');
    result.entries = 8;
    result.controlMs = 30;
  }
  return result;
}

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function stamp() {
  return { performance_ms: performance.now(), hrtime_ns: process.hrtime.bigint().toString(), epoch_ms: Date.now() };
}
function threadCpu() {
  if (typeof process.threadCpuUsage !== 'function') return null;
  return process.threadCpuUsage();
}
function counters() {
  return { at_ms: performance.now(), process_cpu_us: process.cpuUsage(), main_thread_cpu_us: threadCpu(),
    main_event_loop: performance.eventLoopUtilization() };
}
function cpuDelta(end, start) {
  if (end === null || start === null) return null;
  return { user: end.user - start.user, system: end.system - start.system };
}
function counterDelta(end, start) {
  return { wall_ms: end.at_ms - start.at_ms, process_cpu_us: cpuDelta(end.process_cpu_us, start.process_cpu_us),
    main_thread_cpu_us: cpuDelta(end.main_thread_cpu_us, start.main_thread_cpu_us),
    main_event_loop: performance.eventLoopUtilization(end.main_event_loop, start.main_event_loop) };
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Pure reducer is also used by scope tests for zero-sample and unrounded gates.
export function summarizeGaps(rows) {
  if (rows.length === 0) return { callbacks: 0, max_delay_ms: null, median_delay_ms: null,
    above_20ms: 0, first_gap_ms: null, last_gap_ms: null, criterion: 'incomplete' };
  let max = -Infinity;
  let above = 0;
  const delays = [];
  for (const row of rows) {
    const value = row[3];
    delays.push(value);
    if (value > max) max = value;
    if (value > THRESHOLD_MS) above++;
  }
  delays.sort((a, b) => a - b);
  const mid = Math.floor(delays.length / 2);
  return { callbacks: rows.length, max_delay_ms: max,
    median_delay_ms: delays.length % 2 ? delays[mid] : (delays[mid - 1] + delays[mid]) / 2,
    above_20ms: above, first_gap_ms: rows[0][1], last_gap_ms: rows.at(-1)[1],
    criterion: max <= THRESHOLD_MS ? 'pass' : 'fail' };
}

/** The interval remains live until a callback occurs strictly AFTER completion. */
export async function measureWindow(name, work, { evidence = 'measurement', tailDeadlineMs = 10000,
  intervalCounters = false } = {}) {
  // Enabling extra observation must never accidentally produce a formal PASS.
  if (intervalCounters && evidence === 'measurement') evidence = 'diagnostic_interval_counters';
  // Establish an event-loop turn before the eLU baseline (also for standalone idle).
  await new Promise(resolve => setImmediate(resolve));
  const rows = [];
  const startCounters = counters();
  const start = performance.now();
  let last = start;
  const intervalSamples = intervalCounters ? [] : null;
  const captureIntervalCounters = intervalCounters ? (index, callbackMs) => {
    const readBeginMs = performance.now();
    const processCpu = process.cpuUsage();
    const mainCpu = threadCpu();
    const elu = performance.eventLoopUtilization();
    intervalSamples.push({ callback_index: index, callback_ms: callbackMs,
      read_begin_ms: readBeginMs, read_end_ms: performance.now(),
      process_cpu_us: processCpu, main_thread_cpu_us: mainCpu, main_event_loop: elu });
  } : null;
  captureIntervalCounters?.(-1, start);
  let completed = null;
  let fenceResolve;
  let fenceCounters;
  const fence = new Promise(resolve => { fenceResolve = resolve; });
  const timer = setInterval(() => {
    const now = performance.now();
    const gap = now - last;
    const drift = gap - INTERVAL_MS;
    rows.push([now, gap, drift, Math.max(0, drift)]);
    captureIntervalCounters?.(rows.length - 1, now);
    last = now;
    if (completed !== null && now > completed && fenceCounters === undefined) {
      fenceCounters = counters();
      clearInterval(timer);
      fenceResolve(true);
    }
  }, INTERVAL_MS);
  let value;
  let workError = null;
  let completionCounters;
  let tailTimer;
  let fenceObserved = false;
  try {
    try { value = await work(); } catch (error) { workError = error; }
    completed = performance.now();
    completionCounters = counters();
    fenceObserved = await Promise.race([fence, new Promise(resolve => {
      tailTimer = setTimeout(() => resolve(false), tailDeadlineMs);
    })]);
  } finally {
    clearInterval(timer);
    clearTimeout(tailTimer);
  }
  const legacyRows = rows.filter(row => row[0] <= completed);
  const legacyLast = legacyRows.at(-1)?.[0] ?? start;
  const candidate = summarizeGaps(rows);
  const legacy = summarizeGaps(legacyRows);
  if (evidence !== 'measurement') {
    candidate.numeric_comparison = candidate.criterion;
    legacy.numeric_comparison = legacy.criterion;
    candidate.criterion = evidence === 'smoke_only' ? 'not_applicable_smoke' : 'not_applicable_diagnostic';
    legacy.criterion = candidate.criterion;
  }
  const result = { name, evidence, interval_ms: INTERVAL_MS, threshold_ms: THRESHOLD_MS,
    clock: 'performance.now; milliseconds; no rounding', start_ms: start, completion_ms: completed,
    observed_end_ms: rows.at(-1)?.[0] ?? null, work_duration_ms: completed - start,
    raw_columns: ['callback_ms', 'gap_ms', 'signed_drift_ms', 'legacy_clamped_delay_ms'], raw: rows,
    raw_capacity: 'dynamic array; no sample limit or dropping', overflow: 0,
    legacy_to_completion: legacy, including_completion_fence: candidate,
    tail: { fence_observed: fenceObserved, deadline_ms: tailDeadlineMs,
      last_callback_before_completion_ms: legacyRows.at(-1)?.[0] ?? null,
      legacy_uncovered_tail_ms: completed - legacyLast,
      callback_after_completion_ms: fenceObserved ? rows.at(-1)[0] : null,
      completion_to_callback_ms: fenceObserved ? rows.at(-1)[0] - completed : null,
      spanning_gap_ms: fenceObserved ? rows.at(-1)[1] : null },
    counters: { start: startCounters, completion: completionCounters, fence: fenceCounters ?? null,
      to_completion: counterDelta(completionCounters, startCounters),
      to_fence: fenceCounters ? counterDelta(fenceCounters, startCounters) : null },
    ...(intervalCounters ? { interval_counters: {
      diagnostic_only: true, acceptance_evidence: false,
      alignment: 'baseline index -1, then one bracketed snapshot for every raw callback',
      raw_capacity: 'dynamic array; no sample limit or dropping', overflow: 0,
      limitations: [
        'CPU/eLU reads occur inside the recorded bracket after the callback timestamp',
        'Windows thread CPU updates may be quantized; a zero short-window delta does not prove zero CPU',
        'eLU active is wall time and may include waits/descheduling; it is not CPU time',
        'per-callback reads and allocations add observer overhead; not an uninstrumented control',
      ], samples: intervalSamples,
    } } : {}),
    work_error: workError ? String(workError.message ?? workError) : null, value: value ?? null };
  if (!fenceObserved || workError) result.complete = false;
  else result.complete = true;
  return result;
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return { path: file, bytes: (await fsp.stat(file)).size, sha256: hash.digest('hex') };
}
async function listFiles(root, suffix) {
  const files = [];
  for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(file, suffix));
    else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(file);
  }
  return files.sort();
}
async function prepare(scratch, options, mark, provenance) {
  const sourcesBefore = new Map();
  for (const file of await listFiles(path.join(server, 'src'), '.ts')) sourcesBefore.set(file, await hashFile(file));
  const dist = path.join(scratch, 'dist');
  const compiler = path.join(server, 'node_modules/typescript/bin/tsc');
  provenance.compiler = await hashFile(compiler);
  provenance.typescript_package = await hashFile(path.join(server, 'node_modules/typescript/package.json'));
  provenance.typescript_version = JSON.parse(await fsp.readFile(provenance.typescript_package.path, 'utf8')).version;
  const compilerArgs = [compiler, '--ignoreConfig', '--outDir', dist, '--rootDir', path.join(server, 'src'),
    '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022', '--skipLibCheck',
    '--declaration', 'false', '--sourceMap', 'false', '--types', 'node',
    path.join(server, 'src/session/history_service.ts'), path.join(server, 'src/session/history_worker_main.ts')];
  provenance.compile = { executable: process.execPath, args: compilerArgs, cwd: server };
  await fsp.writeFile(path.join(scratch, 'package.json'), '{"type":"module"}\n', { flag: 'wx' });
  mark('scratch_compile_start');
  const compiled = spawnSync(process.execPath, compilerArgs, { cwd: server, encoding: 'utf8', timeout: 240000 });
  mark('scratch_compile_end', { status: compiled.status });
  if (compiled.status !== 0) throw new Error(`scratch compile failed: ${compiled.error?.message ?? compiled.stdout ?? ''}${compiled.stderr ?? ''}`);
  provenance.compiled = [];
  provenance.sources = [];
  for (const file of await listFiles(dist, '.js')) {
    assert.ok(inside(scratch, file));
    provenance.compiled.push(await hashFile(file));
    const source = path.join(server, 'src', path.relative(dist, file).replace(/\.js$/, '.ts'));
    const after = await hashFile(source);
    const before = sourcesBefore.get(source);
    assert.ok(before && before.sha256 === after.sha256, `source changed during scratch compile: ${source}`);
    provenance.sources.push(after);
  }
  provenance.source_stable_during_compile = true;
  process.env.REMOTE_PI_HOME = path.join(scratch, 'home');
  process.env.PI_CODING_AGENT_DIR = path.join(scratch, 'agent');
  process.env.REMOTE_PI_LOG = 'off';
  process.env.RP86_DEBUG = '';
  mark('history_import_start');
  const serviceModule = await import(pathToFileURL(path.join(dist, 'session/history_service.js')).href);
  const { sessionDirFor } = await import(pathToFileURL(path.join(dist, 'session/session_paths.js')).href);
  const { createThreadsHistoryPort } = await import(pathToFileURL(path.join(dist, 'session/history_worker_client.js')).href);
  mark('history_import_end');
  const workspace = path.join(scratch, 'workspace');
  await fsp.mkdir(workspace, { recursive: true });
  const agentRoot = process.env.PI_CODING_AGENT_DIR;
  const bucket = sessionDirFor(workspace, agentRoot);
  await fsp.mkdir(bucket, { recursive: true });
  const file = path.join(bucket, '2026-01-01T00-00-00-000Z_s1.jsonl');
  mark('fixture_write_start');
  const fd = fs.openSync(file, 'wx');
  const textBytes = options.mode === 'smoke' ? 1024 : 50 * 1024;
  try {
    fs.writeSync(fd, JSON.stringify({ type: 'session', id: 's1', cwd: workspace, timestamp: '2026-01-01T00:00:00.000Z' }) + '\n');
    const text = 'x'.repeat(textBytes);
    for (let n = 0; n < options.entries; n++) fs.writeSync(fd, JSON.stringify({ type: 'message', id: `u${n}`, parentId: null,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, n + 1)).toISOString(), message: { role: 'user', content: text } }) + '\n');
  } finally { fs.closeSync(fd); }
  mark('fixture_write_end');
  const fixture = { ...await hashFile(file), entries: options.entries, text_bytes_per_entry: textBytes,
    legacy_2000_case: options.entries === 2000, literal_at_least_100mib: fs.statSync(file).size >= 100 * 1024 * 1024,
    filesystem_cache: 'warm: synthetic file written just before controls', os_cache_cold: false };
  if (options.entries === 2100 && options.mode !== 'smoke') assert.ok(fixture.literal_at_least_100mib);
  let workerScript = path.join(dist, 'session/history_worker_main.js');
  if (options.profileMain) {
    // Diagnostic-only worker phase messages add overhead. The formal transport
    // still uses the exact compiled worker entry without this wrapper.
    workerScript = path.join(scratch, 'diagnostic-worker.mjs');
    await fsp.writeFile(workerScript, `import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { handleHistoryWorkerRequest } from './dist/session/history_worker.js';
const role = workerData.role;
const phase = (name, extra = {}) => parentPort.postMessage({ __probePhase: name, role,
  worker_at_ms: performance.now(), worker_time_origin_ms: performance.timeOrigin,
  worker_hrtime_ns: process.hrtime.bigint().toString(), ...extra });
phase('worker_ready');
let chain = Promise.resolve();
parentPort.on('message', raw => {
  chain = chain.then(async () => {
    phase('worker_handle_start', { request_id: raw.id, kind: raw.kind });
    try {
      const reply = await handleHistoryWorkerRequest(raw, role);
      phase('worker_handle_end', { request_id: raw.id, kind: raw.kind });
      if (reply !== null) parentPort.postMessage(reply);
    } catch (error) {
      phase('worker_handle_error', { request_id: raw.id, kind: raw.kind });
      throw error;
    }
  });
  chain = chain.catch(() => undefined);
});
`, { flag: 'wx' });
    provenance.diagnostic_worker = await hashFile(workerScript);
  }
  const ports = new Set();
  let acceptNewPorts = true;
  const workerPortFactory = role => {
    // HistoryService.dispose() sends dispose even to an unused client. Do not
    // start a previously unused worker just to clean up an idle/setup run.
    if (!acceptNewPorts) throw new Error('probe cleanup does not create workers');
    mark('port_create_start', { role });
    const port = createThreadsHistoryPort(workerScript, role);
    ports.add(port);
    mark('port_create_end', { role, mode: port.mode });
    return { mode: port.mode, on(event, handler) {
      return port.on(event, (...args) => {
        const value = args[0];
        if (event === 'message' && typeof value?.__probePhase === 'string') {
          const { __probePhase, ...details } = value;
          mark(__probePhase, details);
          return;
        }
        mark(event === 'message' ? 'response_received' : `worker_${event}`, {
          role, ...(event === 'message' ? { id: value?.id ?? null, ok: value?.ok ?? null } : {}) });
        return handler(...args);
      });
    }, postMessage(message) {
      mark('post_message_start', { role, id: message.id, kind: message.kind });
      port.postMessage(message);
      mark('post_message_end', { role, id: message.id, kind: message.kind });
    }, terminate() {
      mark('worker_terminate_start', { role });
      return Promise.resolve(port.terminate()).finally(() => { ports.delete(port); mark('worker_terminate_end', { role }); });
    } };
  };
  mark('service_construct_start');
  const service = new serviceModule.HistoryService({
    resolveWorkspace: id => id === 'aaaa1111' ? { daemon_id: id, cwd: workspace } : null,
    runtime: () => ({ state: 'stopped', session_id: null, ready: false }),
    agentRoot, remoteHome: process.env.REMOTE_PI_HOME, workerPortFactory,
    reconcileIntervalMs: 0, workerTimeoutMs: options.deadlineMs,
  });
  assert.equal(service.workerMode(), 'threads');
  assert.deepEqual(service.trustedWritersForTest('aaaa1111'), []);
  mark('service_construct_end', { mode: service.workerMode(), trusted_writers: 0 });
  return { service, fixture, ports, beginDispose: () => { acceptNewPorts = false; } };
}

async function startDiagnostics(mark) {
  const { Session } = await import('node:inspector');
  const session = new Session();
  session.connect();
  const post = (method, params = {}) => new Promise((resolve, reject) => {
    session.post(method, params, (error, result) => error ? reject(error) : resolve(result));
  });
  const gc = [];
  const collect = entries => {
    for (const entry of entries) gc.push({ start_ms: entry.startTime, duration_ms: entry.duration,
      kind: entry.detail?.kind ?? null, flags: entry.detail?.flags ?? null });
  };
  const observer = new PerformanceObserver(list => collect(list.getEntries()));
  observer.observe({ entryTypes: ['gc'] });
  try {
    await post('Profiler.enable');
    await post('Profiler.setSamplingInterval', { interval: 1000 });
    mark('inspector_start_request');
    await post('Profiler.start');
    const start = stamp();
    mark('inspector_started');
    return { async stop() {
      // Two event-loop turns plus takeRecords retain late GC observer delivery.
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      collect(observer.takeRecords());
      mark('inspector_stop_request');
      try {
        const { profile } = await post('Profiler.stop');
        const end = stamp();
        collect(observer.takeRecords());
        return { profile, gc, start, end, sampling_interval_us: 1000,
          gc_scope: 'main isolate only; no forced GC; all observed entries retained',
          clock_alignment: 'profile start/end and monotonic host anchors supplied; use anchors, not assumed equal origins' };
      } finally { observer.disconnect(); session.disconnect(); }
    } };
  } catch (error) { observer.disconnect(); session.disconnect(); throw error; }
}

async function runProbe(options) {
  const out = path.resolve(options.out);
  const tmp = await fsp.realpath(os.tmpdir());
  if (!inside(os.tmpdir(), out) || out === path.resolve(os.tmpdir())) throw new Error('--out must be a file under OS temp');
  await fsp.mkdir(path.dirname(out), { recursive: true });
  if (!inside(tmp, await fsp.realpath(path.dirname(out)))) throw new Error('--out parent resolves outside OS temp');
  const profilePath = `${out}.cpuprofile`;
  // Reserve output atomically: neither a previous run nor a credential file can be overwritten.
  const outHandle = await fsp.open(out, 'wx');
  let profileHandle;
  let scratch;
  let prepared;
  let diagnostic;
  const phases = [];
  const mark = (name, details = {}) => phases.push({ name, at_ms: performance.now(), ...details });
  const report = { schema: 'plan87-host-attribution-v1', status: 'preparing', mode: options.mode,
    evidence: options.mode === 'smoke' ? 'smoke_only_no_performance_claim' : options.mode === 'setup' ? 'setup_only' : (options.profileMain || options.intervalCounters) ? 'diagnostic_not_acceptance' : 'raw_measurement',
    frozen_historical_result: { legacy_max_delay_ms: 27.555, threshold_ms: THRESHOLD_MS, result: 'FAIL',
      source: 'agent://16e559a1-2ead-43c2-ae43-8ad0d97795e7', remeasured: false },
    environment: { node: process.version, versions: process.versions, platform: process.platform, arch: process.arch,
      cpu_model: os.cpus()[0]?.model ?? null, logical_cpus: os.cpus().length, os_release: os.release(),
      executable: process.execPath, exec_argv: process.execArgv, argv: process.argv.slice(1), cwd: process.cwd(),
      performance_time_origin_ms: performance.timeOrigin, clock_anchor: stamp(),
      thread_cpu_available: typeof process.threadCpuUsage === 'function',
      process_cpu_scope: 'whole process including workers; not main-thread CPU',
      elu_scope: 'main event loop; not CPU time; active may include synchronous waits/descheduling',
      external_load: 'operator must serialize after all build lanes; no scheduler/power/timer settings changed' },
    options: { ...options, out }, provenance: { driver: await hashFile(script), node: await hashFile(process.execPath) },
    phases, windows: [], isolation: { production_dist_used: false, sdk_imported: false, pi_started: false,
      history_modules_imported: false,
      network_listener: false, real_identity_used: false, trust_changed: false }, cleanup: {} };
  let failure;
  try {
    if (options.profileMain) profileHandle = await fsp.open(profilePath, 'wx');
    if (options.mode !== 'idle') {
      scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'rp87-host-probe-'));
      report.isolation.scratch = scratch;
      prepared = await prepare(scratch, options, mark, report.provenance);
      report.isolation.history_modules_imported = true;
      report.fixture = prepared.fixture;
    }
    if (options.profileMain) diagnostic = await startDiagnostics(mark);
    const evidence = options.mode === 'smoke' ? 'smoke_only' : (options.profileMain || options.intervalCounters) ? 'diagnostic_not_acceptance' : 'measurement';
    const record = async (name, work) => {
      mark(`${name}_start`);
      const window = await measureWindow(name, work, { evidence, intervalCounters: options.intervalCounters });
      report.windows.push(window);
      mark(`${name}_end`);
      if (!window.complete) throw new Error(`${name} incomplete: ${window.work_error ?? 'completion fence missing'}`);
      return window.value;
    };
    if (options.mode === 'idle') await record('standalone_idle_no_history_import', () => delay(options.durationMs));
    else if (options.mode === 'imported-idle') await record('imported_idle_before_any_worker', () => delay(options.durationMs));
    else if (options.mode !== 'setup') {
      await record('imported_idle_before_any_worker', () => delay(options.controlMs));
      await record('cold_including_lazy_workers', async () => {
        const deadline = performance.now() + options.deadlineMs;
        // Deferred cold steps are intentionally absent from per-request costs.
        // A zero sum here is never evidence of zero total indexing work.
        const metrics = { requests: 0, cold_build_bytes: 0, cold_build_entries: 0,
          build_metrics_scope: 'foreground_requests_only_background_build_not_counted' };
        for (;;) {
          const id = `L-${++metrics.requests}`;
          mark('list_request_start', { id });
          const result = await prepared.service.list({ type: 'history_list', id, daemon_id: 'aaaa1111' });
          mark('list_complete', { id, reply_type: result.reply.type, index_state: result.reply.index_state ?? null });
          metrics.cold_build_bytes += result.metrics.cold_build_bytes ?? 0;
          metrics.cold_build_entries += result.metrics.cold_build_entries ?? 0;
          if (result.reply.type === 'history_list_ok' && result.reply.index_state === 'ready') {
            assert.ok(result.reply.sessions.some(value => value.id === 's1'));
            assert.equal(prepared.service.workerMode(), 'threads');
            return { ...metrics, last_metrics: result.metrics, worker_mode: prepared.service.workerMode() };
          }
          if (result.reply.type !== 'history_list_ok' && !(result.reply.type === 'history_error' && result.reply.code === 'building')) {
            throw new Error(`unexpected list outcome: ${result.reply.type}`);
          }
          if (performance.now() >= deadline) throw new Error('cold build deadline');
          await delay(5);
        }
      });
      await record('imported_idle_after_build_workers_live', () => delay(options.controlMs));
    }
    report.status = options.mode === 'setup' ? 'setup_ready' : options.mode === 'smoke' ? 'smoke_pass' : 'measured';
  } catch (error) {
    failure = error;
    report.status = 'incomplete';
    report.error = String(error.message ?? error);
  } finally {
    if (prepared) {
      mark('service_dispose_start');
      prepared.beginDispose();
      let disposeTimer;
      try {
        await Promise.race([prepared.service.dispose(), new Promise((_, reject) => {
          disposeTimer = setTimeout(() => reject(new Error('service dispose deadline')), 15000);
        })]);
        report.cleanup.service_disposed = true;
      } catch (error) { failure ??= error; report.cleanup.dispose_error = String(error.message ?? error); }
      finally {
        clearTimeout(disposeTimer);
        // Real port references are retained even if service disposal fails on Windows.
        const terminated = await Promise.allSettled([...prepared.ports].map(port => Promise.resolve(port.terminate())));
        report.cleanup.forced_port_terminations = terminated.length;
        report.cleanup.termination_failures = terminated.filter(value => value.status === 'rejected').length;
        prepared.ports.clear();
      }
      mark('service_dispose_end');
    }
    if (diagnostic) {
      try {
        const result = await diagnostic.stop();
        await profileHandle.writeFile(JSON.stringify(result.profile));
        await profileHandle.close();
        profileHandle = null;
        report.diagnostic = { ...result, profile: undefined, cpu_profile: await hashFile(profilePath),
          acceptance_evidence: false, gc_filtered: false };
      } catch (error) { failure ??= error; report.diagnostic_error = String(error.message ?? error); }
    }
    if (profileHandle) await profileHandle.close();
    if (scratch) {
      if (options.keep) report.cleanup.scratch_kept = scratch;
      else {
        try {
          await fsp.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
          report.cleanup.scratch_removed = true;
        } catch (error) { failure ??= error; report.cleanup.scratch_error = String(error.message ?? error); }
      }
    }
    report.isolation.worker_ports_created = phases.filter(phase => phase.name === 'port_create_end').length;
    if (failure) report.status = 'incomplete';
    report.finished = stamp();
    await outHandle.writeFile(JSON.stringify(report, null, 2) + '\n');
    await outHandle.close();
  }
  process.stdout.write(JSON.stringify({ status: report.status, evidence: report.evidence, out,
    windows: report.windows.length, raw_callbacks: report.windows.reduce((sum, window) => sum + window.raw.length, 0),
    scratch_removed: report.cleanup.scratch_removed ?? null }) + '\n');
  if (failure) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  let options;
  try { options = parseProbeArgs(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; }
  if (options?.help) process.stdout.write(HELP);
  else if (options) await runProbe(options).catch(error => { process.stderr.write(`host attribution failed: ${error.message}\n`); process.exitCode = 1; });
}
