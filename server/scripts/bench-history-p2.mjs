#!/usr/bin/env node
/**
 * Plan 86 P2 — incremental history performance measurement.
 *
 * Measures the REAL compiled service in two worker threads (writer + read-only
 * reader), exactly the production shape. Nothing from `server/dist` is imported
 * or written: the service and worker entry are compiled ONCE into a scratch
 * outDir, and `REMOTE_PI_HOME` / `PI_CODING_AGENT_DIR` point at that scratch
 * tree BEFORE the first import.
 *
 * Reported targets (Plan 86 P2):
 *   - 100 MiB warm last-30 read median <= 50 ms;
 *   - 1000-session warm first-50 list median <= 20 ms with page-bounded stats
 *     (stat_count does not grow with the workspace size);
 *   - a trusted 4 KiB append parses only the appended bytes (old file size is
 *     irrelevant);
 *   - the main event loop stays blocked <= 20 ms while a 100 MiB cold build runs
 *     in the writer thread.
 *
 * The output is scalar-only (ids/counts/ms/bytes/booleans). No message text,
 * paths, tokens or pairing material is printed. Cold build and body decode are
 * reported as SEPARATE O(bytes) buckets, never mixed into a page latency.
 *
 * Usage: node scripts/bench-history-p2.mjs [--keep] [--samples N]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { pathToFileURL, fileURLToPath } from "node:url";

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSC = path.join(SERVER_ROOT, "node_modules", "typescript", "bin", "tsc");
const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const samplesIndex = args.indexOf("--samples");
const SAMPLES = samplesIndex >= 0 ? Math.max(3, Number(args[samplesIndex + 1])) : 7;

if (!fs.existsSync(TSC)) {
  console.error("typescript is not installed; this script never installs dependencies");
  process.exit(2);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rp86-p2-bench-"));
const agentRoot = path.join(scratch, "agent");
const distDir = path.join(scratch, "dist");
const remoteA = path.join(scratch, "remote-a");
const remoteB = path.join(scratch, "remote-b");
fs.mkdirSync(agentRoot, { recursive: true });
process.env["PI_CODING_AGENT_DIR"] = agentRoot;
process.env["REMOTE_PI_HOME"] = remoteA;
process.env["RP86_DEBUG"] = "";

const build = spawnSync(
  process.execPath,
  [
    TSC,
    "--ignoreConfig",
    "--outDir",
    distDir,
    "--rootDir",
    path.join(SERVER_ROOT, "src"),
    "--module",
    "nodenext",
    "--moduleResolution",
    "nodenext",
    "--target",
    "es2022",
    "--skipLibCheck",
    "--declaration",
    "false",
    "--sourceMap",
    "false",
    "--types",
    "node",
    path.join(SERVER_ROOT, "src", "session", "history_service.ts"),
    path.join(SERVER_ROOT, "src", "session", "history_worker_main.ts"),
  ],
  { encoding: "utf8", timeout: 240_000 },
);
if (build.status !== 0) {
  console.error(`isolated build failed (${build.status})`);
  console.error(build.stdout);
  console.error(build.stderr);
  process.exit(1);
}

const serviceModule = await import(pathToFileURL(path.join(distDir, "session", "history_service.js")).href);
const pathsModule = await import(pathToFileURL(path.join(distDir, "session", "session_paths.js")).href);
const { HistoryService } = serviceModule;
const { sessionDirFor } = pathsModule;
const DAEMON = "aaaa1111";
const SESSION = "s1";

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function round(value) {
  return value === null || value === undefined ? null : Math.round(value * 1000) / 1000;
}

function scalar(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : value ?? null;
}

function makeWorkspace(name) {
  const cwd = path.join(scratch, "ws", name);
  fs.mkdirSync(cwd, { recursive: true });
  const bucket = sessionDirFor(cwd, agentRoot);
  fs.mkdirSync(bucket, { recursive: true });
  return { cwd, bucket };
}

function makeService({ cwd, remoteHome, trusted = false, pageCacheBytes, chunkBytes, maxFilesPerScan }) {
  return new HistoryService({
    resolveWorkspace: (id) => (id === DAEMON ? { daemon_id: id, cwd } : null),
    runtime: () => ({
      state: trusted ? "running" : "stopped",
      session_id: trusted ? SESSION : null,
      ready: trusted ? true : false,
    }),
    ...(trusted ? { trustedAppend: () => true } : {}),
    agentRoot,
    remoteHome,
    reconcileIntervalMs: 0,
    workerTimeoutMs: 240_000,
    ...(pageCacheBytes !== undefined ? { pageCacheBytes } : {}),
    ...(chunkBytes !== undefined ? { chunkBytes } : {}),
    ...(maxFilesPerScan !== undefined ? { maxFilesPerScan } : {}),
  });
}

function writeLargeSession(bucket, { entries, textBytes }) {
  const file = path.join(bucket, `2026-01-01T00-00-00-000Z_${SESSION}.jsonl`);
  const header = JSON.stringify({
    type: "session",
    id: SESSION,
    cwd: path.dirname(path.dirname(bucket)),
    timestamp: "2026-01-01T00:00:00.000Z",
  });
  const fd = fs.openSync(file, "w");
  try {
    fs.writeSync(fd, header + "\n");
    const text = "x".repeat(textBytes);
    for (let index = 0; index < entries; index += 1) {
      const line = JSON.stringify({
        type: "message",
        id: `u${index}`,
        parentId: null,
        timestamp: new Date(Date.parse("2026-01-01T00:00:01.000Z") + index * 1000).toISOString(),
        message: { role: "user", content: text },
      });
      fs.writeSync(fd, line + "\n");
    }
  } finally {
    fs.closeSync(fd);
  }
  return file;
}

function writeSmallSessions(bucket, count) {
  const header = JSON.stringify({
    type: "session",
    id: "seed",
    cwd: path.dirname(path.dirname(bucket)),
    timestamp: "2026-01-01T00:00:00.000Z",
  });
  const message = (id, at, text) =>
    JSON.stringify({
      type: "message",
      id,
      parentId: null,
      timestamp: new Date(Date.parse("2026-01-01T00:00:00.000Z") + at * 1000).toISOString(),
      message: { role: "user", content: text },
    });
  for (let index = 0; index < count; index += 1) {
    const id = `s${index}`;
    const file = path.join(bucket, `2026-01-01T00-00-00-${String(index).padStart(3, "0")}Z_${id}.jsonl`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: "session",
        id,
        cwd: path.dirname(path.dirname(bucket)),
        timestamp: "2026-01-01T00:00:00.000Z",
      }) +
        "\n" +
        message("u1", 1, `hello ${id}`) +
        "\n" +
        message("u2", 2, `world ${id}`) +
        "\n",
    );
  }
  // The first line above is only a template; the header is real. Keep TS quiet.
  void header;
}

async function listReady(service, deadlineMs = 240_000) {
  const started = performance.now();
  const metrics = { cold_build_bytes: 0, cold_build_entries: 0, retries: 0 };
  const deadline = performance.now() + deadlineMs;
  for (;;) {
    const outcome = await service.list({ type: "history_list", id: `L-${metrics.retries}`, daemon_id: DAEMON });
    metrics.retries += 1;
    metrics.cold_build_bytes += outcome.metrics.cold_build_bytes ?? 0;
    metrics.cold_build_entries += outcome.metrics.cold_build_entries ?? 0;
    if (outcome.reply.type === "history_list_ok" && outcome.reply.index_state === "ready") {
      return { reply: outcome.reply, metrics, wall_ms: performance.now() - started };
    }
    if (performance.now() > deadline) throw new Error("cold build deadline");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function readReady(service, limit, deadlineMs = 240_000) {
  const deadline = performance.now() + deadlineMs;
  for (;;) {
    const outcome = await service.read({
      type: "history_read",
      id: `R-${Date.now()}`,
      daemon_id: DAEMON,
      session_id: SESSION,
      limit,
    });
    if (outcome.reply.type === "history_read_ok") return outcome;
    if (performance.now() > deadline) throw new Error("read deadline");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function sampleRead(service, limit) {
  const wall = [];
  const query = [];
  const readBytes = [];
  const statCounts = [];
  const cache = [];
  return (async () => {
    for (let index = 0; index < SAMPLES; index += 1) {
      const started = performance.now();
      const outcome = await readReady(service, limit);
      wall.push(performance.now() - started);
      query.push(outcome.metrics.query_ms ?? 0);
      readBytes.push(outcome.metrics.read_bytes ?? 0);
      statCounts.push(outcome.metrics.stat_count ?? 0);
      cache.push(outcome.metrics.cache_hit);
    }
    return {
      samples: SAMPLES,
      wall_median_ms: round(median(wall)),
      query_median_ms: round(median(query)),
      read_bytes_median: scalar(median(readBytes)),
      stat_count_median: scalar(median(statCounts)),
      cache_hit_last: cache[cache.length - 1],
    };
  })();
}

async function sampleList(service, limit) {
  const wall = [];
  const query = [];
  const statCounts = [];
  const readBytes = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    const started = performance.now();
    const outcome = await service.list({ type: "history_list", id: `WL-${index}`, daemon_id: DAEMON, limit });
    wall.push(performance.now() - started);
    query.push(outcome.metrics.query_ms ?? 0);
    statCounts.push(outcome.metrics.stat_count ?? 0);
    readBytes.push(outcome.metrics.read_bytes ?? 0);
  }
  return {
    samples: SAMPLES,
    wall_median_ms: round(median(wall)),
    query_median_ms: round(median(query)),
    stat_count_median: scalar(median(statCounts)),
    read_bytes_median: scalar(median(readBytes)),
  };
}

/** Measure main-thread drift while [work] runs in the worker threads. */
async function measureMainBlock(work) {
  const delays = [];
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    delays.push(Math.max(0, now - last - 1));
    last = now;
  }, 1);
  try {
    const result = await work();
    return { result, max_delay_ms: round(Math.max(0, ...delays)), samples: delays.length };
  } finally {
    clearInterval(timer);
  }
}

const report = {
  phase: "plan86-p2",
  measured: true,
  node: process.version,
  platform: process.platform,
  cpu: os.cpus()[0]?.model ?? "unknown",
  conditions: {
    filesystem_cache: "warm (fixtures written immediately before measuring)",
    process: "new isolated dist + two real worker threads per service",
    os_cache_cold: false,
    network: "not involved",
    dist_imported: "isolated scratch outDir; server/dist not imported or written",
    samples_per_series: SAMPLES,
  },
  cold_build: {},
  warm_read_100mib: {},
  warm_read_100mib_cached: {},
  warm_list_1000: {},
  trusted_append: {},
  main_thread_block: {},
  body: {},
  targets: {},
  limitations: [],
};

let serviceLarge = null;
let serviceLargeCached = null;
let serviceMany = null;
let serviceBlock = null;
let serviceBody = null;

try {
  // ── Phase 1: one 100 MiB session, 2000 x ~50 KiB entries ──────────────────
  const large = makeWorkspace("large");
  const largeFile = writeLargeSession(large.bucket, { entries: 2100, textBytes: 50 * 1024 });
  const largeBytes = fs.statSync(largeFile).size;
  serviceLarge = makeService({ cwd: large.cwd, remoteHome: remoteA, pageCacheBytes: 0, maxFilesPerScan: 2048 });
  const cold = await listReady(serviceLarge);
  report.cold_build = {
    file_bytes: largeBytes,
    wall_ms: round(cold.wall_ms),
    parsed_bytes: scalar(cold.metrics.cold_build_bytes),
    parsed_entries: scalar(cold.metrics.cold_build_entries),
    retries: cold.metrics.retries,
  };
  report.warm_read_100mib = await sampleRead(serviceLarge, 30);
  report.warm_read_100mib.file_bytes = largeBytes;
  report.warm_read_100mib.uncached_page = true;

  serviceLargeCached = makeService({ cwd: large.cwd, remoteHome: remoteA });
  report.warm_read_100mib_cached = await sampleRead(serviceLargeCached, 30);

  // ── Phase 2: 1000 sessions, warm first 50 ────────────────────────────────
  const many = makeWorkspace("many");
  writeSmallSessions(many.bucket, 1000);
  serviceMany = makeService({ cwd: many.cwd, remoteHome: remoteB, maxFilesPerScan: 2048 });
  const manyCold = await listReady(serviceMany);
  report.cold_build_sessions_1000 = {
    wall_ms: round(manyCold.wall_ms),
    parsed_bytes: scalar(manyCold.metrics.cold_build_bytes),
    parsed_entries: scalar(manyCold.metrics.cold_build_entries),
    retries: manyCold.metrics.retries,
  };
  report.warm_list_1000 = await sampleList(serviceMany, 50);

  // ── Phase 3: trusted 4 KiB append on the 100 MiB file ────────────────────
  const beforeAppend = fs.statSync(largeFile).size;
  const appendedText = "z".repeat(4000);
  const appendedLine = JSON.stringify({
    type: "message",
    id: "zzz-appended",
    parentId: null,
    timestamp: "2027-01-01T00:00:00.000Z",
    message: { role: "user", content: appendedText },
  });
  fs.appendFileSync(largeFile, appendedLine + "\n");
  serviceLarge.dispose();
  const trustedService = makeService({ cwd: large.cwd, remoteHome: remoteA, trusted: true, pageCacheBytes: 0, chunkBytes: 4096 });
  const appended = await readReady(trustedService, 30);
  report.trusted_append = {
    old_file_bytes: beforeAppend,
    appended_bytes: Buffer.byteLength(appendedLine + "\n", "utf8"),
    parsed_bytes: scalar(appended.metrics.cold_build_bytes),
    read_bytes: scalar(appended.metrics.read_bytes),
    stat_count: scalar(appended.metrics.stat_count),
    cold_build_ms: round(appended.metrics.cold_build_ms ?? 0),
  };
  serviceLarge = trustedService;

  // ── Phase 4: body decode on the appended session ─────────────────────────
  const bodyPage = await readReady(serviceLarge, 30);
  if (bodyPage.reply.type === "history_read_ok") {
    const item = bodyPage.reply.items.find((entry) => (entry.body_refs?.length ?? 0) > 0);
    const ref = item?.body_refs?.[0];
    if (ref !== undefined) {
      const first = await serviceLarge.body({
        type: "history_body",
        id: "B1",
        daemon_id: DAEMON,
        session_id: SESSION,
        snapshot: bodyPage.reply.snapshot,
        body_ref: ref.ref,
        offset_bytes: 0,
      });
      if (first.reply.type === "history_body_ok") {
        const second = await serviceLarge.body({
          type: "history_body",
          id: "B2",
          daemon_id: DAEMON,
          session_id: SESSION,
          snapshot: bodyPage.reply.snapshot,
          body_ref: ref.ref,
          offset_bytes: first.reply.next_offset_bytes,
        });
        report.body = {
          total_bytes: first.reply.total_bytes,
          first_chunk_source_bytes: scalar(first.metrics.body_source_bytes),
          first_chunk_decode_ms: round(first.metrics.body_decode_ms ?? 0),
          second_chunk_source_bytes: scalar(second.metrics.body_source_bytes),
          second_chunk_sidecar_bytes: scalar(second.metrics.body_sidecar_bytes),
        };
      } else {
        report.limitations.push(`body first reply was ${first.reply.type}`);
      }
    }
  }

  // ── Phase 5: main thread during a fresh 100 MiB cold build ───────────────
  const blockWorkspace = makeWorkspace("block");
  writeLargeSession(blockWorkspace.bucket, { entries: 2000, textBytes: 50 * 1024 });
  const remoteBlock = path.join(scratch, "remote-block");
  serviceBlock = makeService({ cwd: blockWorkspace.cwd, remoteHome: remoteBlock });
  serviceBody = serviceBlock;
  const blocked = await measureMainBlock(() => listReady(serviceBlock));
  report.main_thread_block = {
    during: "100 MiB cold build in the writer thread",
    max_delay_ms: blocked.max_delay_ms,
    samples: blocked.samples,
    cold_wall_ms: round(blocked.result.wall_ms),
  };

  // ── Targets ──────────────────────────────────────────────────────────────
  report.targets = {
    warm_read_last30_median_le_50ms:
      report.warm_read_100mib.query_median_ms !== null && report.warm_read_100mib.query_median_ms <= 50,
    warm_read_last30_no_transcript_bytes:
      (report.warm_read_100mib.read_bytes_median ?? 0) === 0,
    warm_list_first50_median_le_20ms:
      report.warm_list_1000.query_median_ms !== null && report.warm_list_1000.query_median_ms <= 20,
    warm_list_stat_count_page_bounded: (report.warm_list_1000.stat_count_median ?? 0) <= 50,
    warm_list_no_transcript_bytes: (report.warm_list_1000.read_bytes_median ?? 0) === 0,
    trusted_append_parsed_bytes_page_sized:
      (report.trusted_append.parsed_bytes ?? Number.MAX_SAFE_INTEGER) <= 64 * 1024 &&
      (report.trusted_append.old_file_bytes ?? 0) > 100 * 1024 * 1024,
    main_thread_block_le_20ms:
      report.main_thread_block.max_delay_ms !== null && report.main_thread_block.max_delay_ms <= 20,
  };
  report.ok = Object.values(report.targets).every(Boolean);
} catch (error) {
  report.ok = false;
  report.error = error instanceof Error ? error.message : String(error);
  report.limitations.push("measurement aborted; see error");
} finally {
  for (const service of [serviceLarge, serviceLargeCached, serviceMany, serviceBlock, serviceBody]) {
    try {
      await service?.dispose();
    } catch {
      /* best effort */
    }
  }
  if (!KEEP) {
    try {
      fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch {
      report.limitations.push("scratch cleanup failed; pass --keep to inspect");
    }
  }
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
