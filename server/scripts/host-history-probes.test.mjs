#!/usr/bin/env node
/** Plan87 focused mechanics checks. No formal performance acceptance here. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { parseProbeArgs, summarizeGaps, measureWindow } from './host-timer-probe.mjs';
import { parseFixtureArgs, fixtureMarkdown, LARGE_FIXTURE, createFixtureFleet } from './integration-host-history.mjs';

const server = resolve(import.meta.dirname, '..');

test('CLI rejects malformed or duplicate modes, entries, ports before any setup', () => {
  assert.equal(parseProbeArgs(['--mode', 'cold', '--entries', '2000', '--out', 'x']).entries, 2000);
  assert.equal(parseProbeArgs(['--mode', 'cold', '--out', 'x']).entries, 2100);
  for (const args of [[], ['--mode', 'unknown', '--out', 'x'], ['--mode', 'cold', '--entries', '1.2', '--out', 'x'],
    ['--mode', 'cold', '--entries', '0', '--out', 'x'], ['--mode', 'cold', '--mode', 'cold', '--out', 'x'],
    ['--mode', 'smoke', '--entries', '8', '--out', 'x'], ['--mode', 'idle', '--profile-main', '--out', 'x']]) {
    assert.throws(() => parseProbeArgs(args));
  }
  assert.deepEqual(parseFixtureArgs([]), { smoke: false, large: false, port: 0, help: false });
  assert.deepEqual(parseFixtureArgs(['--large', '--port', '61986']), { smoke: false, large: true, port: 61986, help: false });
  for (const args of [['--port', '-1'], ['--port', '65536'], ['--port', '61986x'], ['--port', '3001'],
    ['--port', '9444'], ['--large', '--large'], ['--scale']]) assert.throws(() => parseFixtureArgs(args));
});

test('strict CLI process validation has exit 2 and no report/compile', () => {
  const result = spawnSync(process.execPath, ['scripts/host-timer-probe.mjs', '--mode', 'cold', '--entries', 'x'],
    { cwd: server, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /integer/);
});

test('unrounded maximum retains outlier/GC-sized delays and zero-sample incompleteness', () => {
  const summary = summarizeGaps([[1, 1, 0, 0], [22, 21.0000000001, 20.0000000001, 20.0000000001], [124, 102, 101, 101]]);
  assert.equal(summary.callbacks, 3);
  assert.equal(summary.max_delay_ms, 101);
  assert.equal(summary.above_20ms, 2);
  assert.equal(summary.criterion, 'fail');
  assert.equal(summarizeGaps([[21, 21.0000000001, 20.0000000001, 20.0000000001]]).criterion, 'fail');
  assert.equal(summarizeGaps([]).criterion, 'incomplete');
});

test('terminal callback covers synchronous last tail and failing work still fences', async () => {
  const result = await measureWindow('tail-smoke', async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
    const until = performance.now() + 3;
    while (performance.now() < until) { /* synthetic short tail, no perf assertion */ }
    return { ok: true };
  }, { evidence: 'smoke_only' });
  assert.equal(result.complete, true);
  assert.equal(result.tail.fence_observed, true);
  assert.ok(result.tail.callback_after_completion_ms > result.completion_ms);
  assert.equal(result.including_completion_fence.callbacks, result.legacy_to_completion.callbacks + 1);
  assert.equal(result.raw.length, result.including_completion_fence.callbacks);
  assert.equal(result.including_completion_fence.criterion, 'not_applicable_smoke');
  assert.equal(result.raw[0][1], result.raw[0][0] - result.start_ms);
  for (let n = 1; n < result.raw.length; n++) assert.equal(result.raw[n][1], result.raw[n][0] - result.raw[n - 1][0]);
  const failed = await measureWindow('failure-smoke', () => { throw new Error('expected failure'); }, { evidence: 'smoke_only' });
  assert.equal(failed.complete, false);
  assert.equal(failed.tail.fence_observed, true);
  assert.equal(failed.work_error, 'expected failure');
});

test('interval counters preserve every callback and cannot produce formal acceptance', async () => {
  assert.equal(parseProbeArgs(['--mode', 'idle', '--interval-counters', '--out', 'x']).intervalCounters, true);
  assert.equal(parseProbeArgs(['--mode', 'idle', '--out', 'x']).intervalCounters, false);
  assert.throws(() => parseProbeArgs(['--mode', 'setup', '--interval-counters', '--out', 'x']));
  assert.throws(() => parseProbeArgs(['--mode', 'idle', '--interval-counters', '--interval-counters', '--out', 'x']));
  const result = await measureWindow('interval-counter-mechanics', () => new Promise(resolve => setTimeout(resolve, 12)),
    { intervalCounters: true });
  assert.equal(result.complete, true);
  assert.equal(result.evidence, 'diagnostic_interval_counters');
  assert.equal(result.including_completion_fence.criterion, 'not_applicable_diagnostic');
  assert.equal(result.legacy_to_completion.criterion, 'not_applicable_diagnostic');
  const ledger = result.interval_counters;
  assert.equal(ledger.acceptance_evidence, false);
  assert.equal(ledger.overflow, 0);
  assert.equal(ledger.samples.length, result.raw.length + 1);
  for (let i = 0; i < ledger.samples.length; i++) {
    const value = ledger.samples[i];
    assert.equal(value.callback_index, i - 1);
    assert.equal(value.callback_ms, i === 0 ? result.start_ms : result.raw[i - 1][0]);
    assert.ok(value.read_begin_ms >= value.callback_ms);
    assert.ok(value.read_end_ms >= value.read_begin_ms);
    assert.ok(value.process_cpu_us.user >= 0 && value.process_cpu_us.system >= 0);
    if (typeof process.threadCpuUsage === 'function') assert.ok(value.main_thread_cpu_us.user >= 0);
    assert.ok(value.main_event_loop.idle >= 0 && value.main_event_loop.active >= 0);
  }
  const ordinary = await measureWindow('unchanged-ordinary-window', async () => {}, { evidence: 'smoke_only' });
  assert.equal(Object.hasOwn(ordinary, 'interval_counters'), false);
});

test('5000 unique 2.5KiB Markdown messages alone exceed 8MiB before projection overhead', () => {
  const bodies = new Set();
  let bytes = 0;
  for (let n = 0; n < LARGE_FIXTURE.entries; n++) {
    const text = fixtureMarkdown('rp87-large-0000', n);
    assert.equal(Buffer.byteLength(text), 2560);
    assert.match(text, /```js/);
    bodies.add(text);
    bytes += Buffer.byteLength(text);
  }
  assert.equal(bodies.size, 5000);
  assert.equal(bytes, 12800000);
  assert.ok(bytes > 8 * 1024 * 1024);
  assert.equal(LARGE_FIXTURE.sessions, 9);
  assert.equal(LARGE_FIXTURE.manySessions, 1000);
  assert.equal(Math.ceil(LARGE_FIXTURE.entries / LARGE_FIXTURE.readLimit), 167);
  assert.notEqual(fixtureMarkdown('rp87-large-0000', 0), fixtureMarkdown('rp87-large-0001', 0));
});

test('all existing fleet mutation methods still throw and count; list/runtime cannot start Pi', () => {
  const calls = [];
  const fleet = createFixtureFleet([{ id: 'owned', cwd: 'synthetic', name: 'P87_LARGE' }], calls);
  assert.equal(fleet.list()[0].live, false);
  assert.equal(fleet.list()[0].daemon, false);
  assert.deepEqual(fleet.runtime('owned'), { state: 'stopped', session_id: null, ready: false });
  assert.equal(fleet.runtime('absent'), null);
  for (const name of ['ensure', 'start', 'stop', 'addWorkspace', 'removeWorkspace']) assert.throws(() => fleet[name](), /forbidden/);
  assert.deepEqual(calls, ['ensure', 'start', 'stop', 'addWorkspace', 'removeWorkspace']);
});

test('setup validates scratch compile and fixture scope without timers or lazy worker creation', { timeout: 60000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'rp87-setup-check-'));
  try {
    const out = join(scratch, 'setup.json');
    const result = spawnSync(process.execPath, ['scripts/host-timer-probe.mjs', '--mode', 'setup', '--entries', '8', '--out', out],
      { cwd: server, encoding: 'utf8', timeout: 50000 });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(report.status, 'setup_ready');
    assert.equal(report.evidence, 'setup_only');
    assert.equal(report.windows.length, 0);
    assert.equal(report.isolation.worker_ports_created, 0);
    assert.equal(report.isolation.production_dist_used, false);
    assert.equal(report.fixture.entries, 8);
    assert.equal(report.fixture.text_bytes_per_entry, 51200);
    assert.equal(report.cleanup.service_disposed, true);
    assert.equal(report.cleanup.scratch_removed, true);
    // Exact commands are rerun-safe only with a new output: do not overwrite raw evidence.
    const again = spawnSync(process.execPath, ['scripts/host-timer-probe.mjs', '--mode', 'setup', '--entries', '8', '--out', out],
      { cwd: server, encoding: 'utf8', timeout: 10000 });
    assert.equal(again.status, 1);
    assert.match(again.stderr, /EEXIST/);
    assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), report);
  } finally { await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('diagnostic tiny scratch smoke executes real threads, CPU profile, GC and cleanup', { timeout: 60000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'rp87-smoke-check-'));
  try {
    const out = join(scratch, 'mechanics.json');
    const result = spawnSync(process.execPath, ['scripts/host-timer-probe.mjs', '--mode', 'smoke', '--profile-main', '--out', out],
      { cwd: server, encoding: 'utf8', timeout: 50000 });
    const report = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(result.status, 0, result.stderr + JSON.stringify({ status: report.status, error: report.error,
      windows: report.windows.map(window => ({ name: window.name, complete: window.complete, error: window.work_error })),
      phases: report.phases.slice(-12), cleanup: report.cleanup }));
    assert.equal(report.status, 'smoke_pass');
    assert.equal(report.evidence, 'smoke_only_no_performance_claim');
    assert.equal(report.frozen_historical_result.result, 'FAIL');
    assert.equal(report.windows.length, 3);
    assert.equal(report.windows.find(window => window.name === 'cold_including_lazy_workers').value.build_metrics_scope,
      'foreground_requests_only_background_build_not_counted');
    for (const window of report.windows) {
      assert.equal(window.complete, true);
      assert.equal(window.tail.fence_observed, true);
      assert.equal(window.overflow, 0);
      assert.equal(window.including_completion_fence.criterion, 'not_applicable_smoke');
      assert.ok(window.counters.to_completion.process_cpu_us.user >= 0);
    }
    assert.equal(report.cleanup.service_disposed, true);
    assert.equal(report.cleanup.scratch_removed, true);
    assert.equal(report.cleanup.forced_port_terminations, 0);
    assert.equal(report.isolation.production_dist_used, false);
    assert.equal(report.isolation.pi_started, false);
    assert.equal(report.provenance.source_stable_during_compile, true);
    assert.ok(report.provenance.sources.some(value => value.path.endsWith('history_build.ts')));
    assert.ok(report.phases.some(value => value.name === 'worker_handle_start' && value.role === 'writer'));
    assert.ok(report.phases.some(value => value.name === 'worker_handle_end' && value.role === 'writer'));
    assert.equal(report.diagnostic.acceptance_evidence, false);
    assert.equal(report.diagnostic.gc_filtered, false);
    const profile = JSON.parse(await readFile(`${out}.cpuprofile`, 'utf8'));
    assert.ok(profile.nodes.length > 0);
    assert.ok(Array.isArray(profile.samples));
  } finally { await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
