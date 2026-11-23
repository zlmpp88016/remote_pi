#!/usr/bin/env node
/**
 * Plan 86 / P0 — reusable segmented performance measurement.
 *
 * This is the focused, maintainable descendant of the one-off Plan 86 survey
 * harness. It measures the **compiled** read path (`dist/`, never `src/` — see
 * knowhow-tip-20261007-5b9e38f089913223) for the two operations that already
 * exist today:
 *
 *   transcript  read the whole JSONL, parse it, take the newest page
 *               (optionally after resolving the active branch, which is the
 *               "read twice" live-session path)
 *   index       list a workspace through the mtime/size index: empty index,
 *               warm lookup, append ingest, post-append warm lookup
 *
 * It does NOT re-run the original minute-scale baseline. The already-valid raw
 * results (`web-baseline.json`, `bench/results.json`, `app-list-timings.json`)
 * are read-only references: this tool hashes them, derives scalar medians from
 * their raw samples, and marks them `remeasured: false`. The original timings
 * stay authoritative; the default `smoke` mode is a tiny fixture that only
 * proves the harness still runs.
 *
 * The same output schema is the contract for later phases (P2 history service,
 * P3 Web, P4 App). A future module can be measured through an explicit
 * `--target <module> --target-export <fn>` seam. Nothing is invented when the
 * target is missing: the report says `status: "unavailable"` and why.
 *
 * Safety invariants (enforced at runtime, not documented aspiration):
 *   - REMOTE_PI_HOME and PI_CODING_AGENT_DIR are set to a scratch tree BEFORE
 *     any `dist/` module is imported.
 *   - JSONL reads outside that scratch tree throw, so an SDK list fallback to
 *     the developer's real `~/.pi/agent` fails loudly instead of leaking.
 *   - `listSessionsIndexed` returning null (its fallback signal) is a hard
 *     failure.
 *   - `server/dist/index.js` is never imported.
 *   - Sync writes outside scratch throw.
 *   - The index connection is closed and the scratch tree is deleted.
 *
 * Output is scalar-only: ids, counts, milliseconds, bytes, booleans. Synthetic
 * payload hashes prove "same answer", never message bodies, tokens or pairing
 * material.
 *
 * Usage:
 *   node scripts/bench-history-performance.mjs                 # smoke probe
 *   node scripts/bench-history-performance.mjs --keep          # inspect scratch
 *   node scripts/bench-history-performance.mjs --mode matrix   # opt-in scale run
 *   node scripts/bench-history-performance.mjs --baseline-dir <survey-dir>
 *   node scripts/bench-history-performance.mjs --target dist/session/history_service.js \
 *        --target-export measureHistoryPage --target-arg '{"limit":50}'
 *
 * Exit codes: 0 report emitted (including target unavailable), 1 assertion or
 * isolation failure, 2 bad usage.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN_ENTRY = path.join(SERVER_ROOT, "dist", "index.js");
const DEFAULT_BASELINE = path.join(os.homedir(), ".pi", "agent", "tmp", "remote-pi-perf-20261116");

const USAGE = `bench-history-performance.mjs — Plan 86 P0 measurement utility

Usage:
  node scripts/bench-history-performance.mjs [options]

Options:
  --mode smoke|matrix     smoke = tiny runnable probe (default); matrix = the
                          original 1/10/100 MiB + 1000-session scale matrix
  --samples N             timed samples per phase (default: smoke 2, matrix 3)
  --scratch DIR           scratch root (default: mkdtemp under the OS temp dir)
  --keep                  keep the scratch tree (default: remove it)
  --baseline-dir DIR      survey directory with web-baseline.json,
                          bench/results.json, app-list-timings.json
                          (default: $REMOTE_PI_PERF_BASELINE or ${DEFAULT_BASELINE};
                          "none" disables reference loading)
  --out FILE              also write the JSON report to FILE (default: stdout only)
  --target FILE           optional future history-service module (never invented)
  --target-export NAME    exported function on --target; receives (ctx, arg)
  --target-arg JSON       optional single JSON value passed to the export
  --allow-outside-tmp     allow a --scratch outside the OS temp directory
  --help                  print this text

The target contract is deliberately generic: the export is called once with a
context ({ scratch, agentRoot, workspace, fixtures, performance, emit }) and
should call ctx.emit(sample) or return { samples }. Samples are normalized to
the scalar metric fields listed in the report's metricContract.
`;

// ---------------------------------------------------------------------------
// Arguments + environment (all of this must happen before importing dist/)
// ---------------------------------------------------------------------------

/** @param {string[]} argv */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith("--")) throw new UsageError(`unexpected argument: ${raw}`);
    const eq = raw.indexOf("=");
    const key = eq === -1 ? raw.slice(2) : raw.slice(2, eq);
    if (key === "keep" || key === "help" || key === "allow-outside-tmp") {
      out[key] = true;
      continue;
    }
    const value = eq === -1 ? argv[++i] : raw.slice(eq + 1);
    if (value === undefined) throw new UsageError(`--${key} needs a value`);
    out[key] = value;
  }
  return out;
}

class UsageError extends Error {}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`error: ${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  throw error;
}
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}

const mode = opts.mode ?? "smoke";
if (mode !== "smoke" && mode !== "matrix") {
  console.error(`error: --mode must be smoke or matrix\n\n${USAGE}`);
  process.exit(2);
}
const sampleCount = opts.samples === undefined
  ? (mode === "matrix" ? 3 : 2)
  : Number.parseInt(opts.samples, 10);
if (!Number.isInteger(sampleCount) || sampleCount < 1) {
  console.error("error: --samples must be a positive integer");
  process.exit(2);
}

const scratch = path.resolve(opts.scratch ?? fs.mkdtempSync(path.join(os.tmpdir(), "rp-hist-perf-")));
const tmpRoot = path.resolve(os.tmpdir());
const insideTmp = isInside(tmpRoot, scratch);
if (!insideTmp && opts["allow-outside-tmp"] !== true) {
  console.error(`error: scratch must live under the OS temp dir (${tmpRoot}); pass --allow-outside-tmp to override`);
  process.exit(2);
}
fs.mkdirSync(scratch, { recursive: true });

const homeDir = path.join(scratch, "home");
const agentRoot = path.join(scratch, "agent");
const workspaceLarge = path.join(scratch, "workspace-large");
const workspaceTiny = path.join(scratch, "workspace-tiny");

// Set before importing anything that reads them. `indexDbPath()` derives from
// REMOTE_PI_HOME; the transcript bucket is pinned with setAgentRootForTest()
// after import, but the env var is what the SDK itself would honour.
process.env["REMOTE_PI_HOME"] = homeDir;
process.env["PI_CODING_AGENT_DIR"] = agentRoot;

fs.mkdirSync(homeDir, { recursive: true });
fs.mkdirSync(agentRoot, { recursive: true });

// ---------------------------------------------------------------------------
// Filesystem instrumentation and guards (installed before the dist imports)
// ---------------------------------------------------------------------------

const original = {
  readFileSync: fs.readFileSync,
  createReadStream: fs.createReadStream,
  writeFileSync: fs.writeFileSync,
  appendFileSync: fs.appendFileSync,
  mkdirSync: fs.mkdirSync,
  rmSync: fs.rmSync,
  statSync: fs.statSync,
  existsSync: fs.existsSync,
  readdirSync: fs.readdirSync,
};

const io = {
  reads: 0,
  bytes: 0,
  readCalls: 0,
  outsideScratchJsonl: 0,
  blockedWrites: 0,
};

// Cleanup is registered before any long-lived resource exists, so a failed
// assertion still closes the index and removes the scratch tree instead of
// leaving a temp directory (and its SQLite handle) behind on Windows.
let indexHandle = null;
let cleanedUp = false;
const cleanupSteps = { index_closed: false, scratch_removed: false, scratch_kept: false };
function cleanupResources() {
  if (cleanedUp) return cleanupSteps;
  cleanedUp = true;
  try {
    if (indexHandle !== null) indexHandle.closeIndex();
    cleanupSteps.index_closed = true;
  } catch (error) {
    cleanupSteps.index_closed = false;
    cleanupSteps.index_error = String(error);
  }
  if (opts.keep === true) {
    cleanupSteps.scratch_kept = true;
  } else {
    try {
      original.rmSync(scratch, { recursive: true, force: true });
      cleanupSteps.scratch_removed = !original.existsSync(scratch);
    } catch (error) {
      cleanupSteps.scratch_removed = false;
      cleanupSteps.scratch_error = String(error);
    }
  }
  return cleanupSteps;
}
process.once("exit", () => {
  try {
    cleanupResources();
  } catch {
    /* exiting anyway */
  }
});

function resetIo() {
  io.reads = 0;
  io.bytes = 0;
  io.readCalls = 0;
}

function snapshotIo() {
  return { read_calls: io.reads, read_bytes: io.bytes };
}

function sizeOf(file) {
  try {
    return original.statSync(file).size;
  } catch {
    return 0;
  }
}

function guardJsonlRead(value, label) {
  if (typeof value !== "string") return;
  if (!value.toLowerCase().endsWith(".jsonl")) return;
  if (!isInside(scratch, value)) {
    io.outsideScratchJsonl++;
    throw new Error(
      `${label}: refusing to read JSONL outside scratch (${value}); ` +
        "this is the SDK fallback path that must never run here",
    );
  }
  io.reads++;
  io.bytes += sizeOf(value);
}

function guardSyncWrite(value, label) {
  if (typeof value !== "string") return;
  if (isInside(scratch, value)) return;
  io.blockedWrites++;
  throw new Error(`${label}: refusing to write outside scratch (${value})`);
}

fs.readFileSync = function guardedReadFileSync(value, ...args) {
  guardJsonlRead(value, "readFileSync");
  return original.readFileSync.call(this, value, ...args);
};
fs.createReadStream = function guardedCreateReadStream(value, ...args) {
  guardJsonlRead(value, "createReadStream");
  return original.createReadStream.call(this, value, ...args);
};
fs.writeFileSync = function guardedWriteFileSync(value, ...args) {
  guardSyncWrite(value, "writeFileSync");
  return original.writeFileSync.call(this, value, ...args);
};
fs.appendFileSync = function guardedAppendFileSync(value, ...args) {
  guardSyncWrite(value, "appendFileSync");
  return original.appendFileSync.call(this, value, ...args);
};
fs.mkdirSync = function guardedMkdirSync(value, ...args) {
  guardSyncWrite(value, "mkdirSync");
  return original.mkdirSync.call(this, value, ...args);
};
fs.rmSync = function guardedRmSync(value, ...args) {
  guardSyncWrite(value, "rmSync");
  return original.rmSync.call(this, value, ...args);
};
syncBuiltinESMExports();

/** Path containment that does not get fooled by a sibling `scratch-evil`. */
function isInside(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// ---------------------------------------------------------------------------
// Baseline references: reuse, do not remeasure
// ---------------------------------------------------------------------------

function sha256File(file) {
  return createHash("sha256").update(original.readFileSync(file)).digest("hex");
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function series(name, unit, values, source, extra = {}) {
  const clean = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (clean.length === 0) return null;
  return {
    name,
    unit,
    n: clean.length,
    median: median(clean),
    min: Math.min(...clean),
    max: Math.max(...clean),
    source,
    remeasured: false,
    ...extra,
  };
}

/** @param {string | null} dir */
function loadBaselineReferences(dir) {
  if (dir === null) return { status: "disabled", reason: "--baseline-dir none", remeasured: false };
  const webFile = path.join(dir, "web-baseline.json");
  const benchFile = path.join(dir, "bench", "results.json");
  const appFile = path.join(dir, "app-list-timings.json");
  if (!original.existsSync(webFile) || !original.existsSync(benchFile)) {
    return {
      status: "unavailable",
      reason: "survey files missing; pass --baseline-dir",
      expected: [webFile, benchFile, appFile],
      remeasured: false,
    };
  }

  /** @type {string[]} */
  const limits = [];
  /** @type {string[]} */
  const rawFiles = [];
  /** @type {ReturnType<typeof series>[]} */
  const derived = [];

  const web = JSON.parse(original.readFileSync(webFile, "utf8"));
  rawFiles.push({ path: webFile, sha256: sha256File(webFile), bytes: sizeOf(webFile), capturedAt: web.capturedAt ?? null });
  for (const item of web.limitations ?? []) limits.push(`web-baseline.json: ${item}`);

  const refresh = (web.listRefreshSamples ?? []).map((s) => s.rttMs);
  derived.push(series("web.list_refresh.rtt_ms", "ms", refresh, "web-baseline.json"));
  const openWarm = (web.openWarmWorkspaceSamples ?? []).map((s) => s.observedMs);
  derived.push(series("web.open_warm_workspace.observed_ms", "ms", openWarm, "web-baseline.json"));

  const readCols = web.readSampleColumns ?? [];
  const readRows = (web.readSamples ?? []).map((row) => Object.fromEntries(readCols.map((key, i) => [key, row[i]])));
  derived.push(series("web.read.first_visible_content_ms", "ms", readRows.map((r) => r.firstVisibleContentMs), "web-baseline.json"));
  derived.push(series("web.read.observed_ms", "ms", readRows.map((r) => r.observedMs), "web-baseline.json"));
  derived.push(series("web.read.first_request_rtt_ms", "ms", readRows.map((r) => r.firstRequestRttMs), "web-baseline.json"));
  const duplicates = readRows.filter((r) => (r.sameRowRequestCount ?? 0) > 1).length;
  derived.push({
    name: "web.read.duplicate_read_rows",
    unit: "rows",
    n: readRows.length,
    median: duplicates,
    min: duplicates,
    max: duplicates,
    source: "web-baseline.json",
    remeasured: false,
    note: "rows that issued the same-session read twice (hover prefetch + click)",
  });
  if (typeof web.prefetchHit?.firstVisibleContentMs === "number") {
    derived.push(series("web.prefetch_hit.first_visible_content_ms", "ms", [web.prefetchHit.firstVisibleContentMs], "web-baseline.json"));
  }

  const bench = JSON.parse(original.readFileSync(benchFile, "utf8"));
  rawFiles.push({ path: benchFile, sha256: sha256File(benchFile), bytes: sizeOf(benchFile), capturedAt: bench.environment?.timestamp ?? null });
  for (const item of bench.limits ?? []) limits.push(`bench/results.json: ${item}`);

  const transcriptCols = bench.transcriptSampleColumns ?? [];
  for (const row of bench.transcript ?? []) {
    const samples = (row.samples ?? []).map((s) => Object.fromEntries(transcriptCols.map((key, i) => [key, s[i]])));
    const name = `synthetic.transcript.${row.mib}MiB.${row.mode === "read + recent" ? "read_recent" : "active_branch_read_recent"}`;
    derived.push(series(`${name}.total_ms`, "ms", samples.map((s) => s.totalMs), "bench/results.json", {
      read_bytes: row.readBytes ?? null,
      read_calls: row.readCount ?? null,
    }));
    if (typeof row.readBytes === "number") {
      derived.push({
        name: `${name}.read_bytes`,
        unit: "bytes",
        n: 1,
        median: row.readBytes,
        min: row.readBytes,
        max: row.readBytes,
        source: "bench/results.json",
        remeasured: false,
      });
    }
  }

  const indexCols = bench.indexSampleColumns ?? [];
  for (const row of bench.index ?? []) {
    const samples = (row.samples ?? []).map((s) => Object.fromEntries(indexCols.map((key, i) => [key, s[i]])));
    for (const phase of ["empty-index", "unchanged-warm", "append-largest", "post-append-warm"]) {
      const phaseRows = samples.filter((s) => s.phase === phase);
      const name = `synthetic.index.${row.scenario}.${phase}`;
      derived.push(series(`${name}.elapsed_ms`, "ms", phaseRows.map((s) => s.elapsedMs), "bench/results.json"));
      derived.push(series(`${name}.parsed_files`, "files", phaseRows.map((s) => s.parsed), "bench/results.json"));
      derived.push(series(`${name}.read_bytes`, "bytes", phaseRows.map((s) => s.readBytes), "bench/results.json"));
    }
  }

  let app = null;
  if (original.existsSync(appFile)) {
    app = JSON.parse(original.readFileSync(appFile, "utf8"));
    rawFiles.push({ path: appFile, sha256: sha256File(appFile), bytes: sizeOf(appFile), capturedAt: app.startedAt ?? null });
    const samples = app.samples ?? [];
    if (samples.length >= 3) {
      // Single observation, so this is a bracket, not a distribution. The plan
      // reports "1.124–2.801 s visible first list"; keep it a bracket.
      derived.push({
        name: "app.first_list_visible_bracket_ms",
        unit: "ms",
        n: 1,
        min: samples[0].afterMs,
        max: samples[2].afterMs,
        median: null,
        source: "app-list-timings.json",
        remeasured: false,
        note: "single screenshot observation; intermediate frames are frames, not extra samples",
      });
    }
    limits.push("app-list-timings.json: screenshot bracket only, not an RTT; no history-row tap measured");
  }

  return {
    status: "reused",
    dir,
    remeasured: false,
    rawFiles,
    series: derived.filter(Boolean),
    documentedLimits: limits,
    note: "Raw survey files are hashed and summarized; no baseline timing was re-measured.",
  };
}

const baselineDir = opts["baseline-dir"] === "none"
  ? null
  : path.resolve(opts["baseline-dir"] ?? process.env["REMOTE_PI_PERF_BASELINE"] ?? DEFAULT_BASELINE);
const baselineReuse = loadBaselineReferences(baselineDir);

function baselineProvenanceMatch(sourcePath, sourceSha, distSha) {
  if (baselineReuse.status !== "reused") return null;
  const results = JSON.parse(original.readFileSync(path.join(baselineReuse.dir, "bench", "results.json"), "utf8"));
  // Survey provenance records repo-relative paths (`server/src/...`); compare
  // after resolving both against the repository root.
  const repoRoot = path.dirname(SERVER_ROOT);
  const wanted = path.resolve(sourcePath);
  const match = (results.provenance ?? []).find((p) => path.resolve(repoRoot, p.source) === wanted);
  if (!match) return null;
  return {
    matches_baseline: match.sourceSha256 === sourceSha && match.distSha256 === distSha,
    baseline_source_sha256: match.sourceSha256,
    baseline_dist_sha256: match.distSha256,
  };
}

// ---------------------------------------------------------------------------
// Compiled modules under test
// ---------------------------------------------------------------------------

const MODULES = [
  { id: "session_index", src: "src/actions/session_index.ts", dist: "dist/actions/session_index.js" },
  { id: "transcript", src: "src/session/transcript.ts", dist: "dist/session/transcript.js" },
  { id: "history", src: "src/session/history.ts", dist: "dist/session/history.js" },
];

const imported = [];
const importStart = performance.now();
const idx = await import(pathToFileURL(path.join(SERVER_ROOT, MODULES[0].dist)).href);
indexHandle = idx;
imported.push(MODULES[0].dist);
const tr = await import(pathToFileURL(path.join(SERVER_ROOT, MODULES[1].dist)).href);
imported.push(MODULES[1].dist);
const hist = await import(pathToFileURL(path.join(SERVER_ROOT, MODULES[2].dist)).href);
imported.push(MODULES[2].dist);
const moduleImportMs = performance.now() - importStart;

for (const rel of imported) {
  assert.notEqual(
    path.resolve(SERVER_ROOT, rel),
    FORBIDDEN_ENTRY,
    "server/dist/index.js must never be imported by the measurement utility",
  );
}

idx.setAgentRootForTest(agentRoot);
const dbPath = idx.indexDbPath();
assert.ok(isInside(scratch, dbPath), `index database escaped scratch: ${dbPath}`);
assert.ok(isInside(agentRoot, idx.sessionDirFor(workspaceLarge, agentRoot)), "derived session bucket escaped the scratch agent root");

const provenance = MODULES.map((mod) => {
  const source = path.join(SERVER_ROOT, mod.src);
  const dist = path.join(SERVER_ROOT, mod.dist);
  const sourceSha = sha256File(source);
  const distSha = sha256File(dist);
  let mapSources = null;
  let mapHasSourcesContent = null;
  try {
    const map = JSON.parse(original.readFileSync(`${dist}.map`, "utf8"));
    mapSources = map.sources ?? null;
    mapHasSourcesContent = Array.isArray(map.sourcesContent);
  } catch {
    /* a missing map is reported as null, not guessed */
  }
  return {
    id: mod.id,
    source: mod.src,
    dist: mod.dist,
    source_sha256: sourceSha,
    dist_sha256: distSha,
    source_mtime: original.statSync(source).mtime.toISOString(),
    dist_mtime: original.statSync(dist).mtime.toISOString(),
    map_sources: mapSources,
    map_has_sources_content: mapHasSourcesContent,
    ...baselineProvenanceMatch(source, sourceSha, distSha) ?? {},
    congruence: "source and dist hashed read-only; no build performed",
  };
});

// ---------------------------------------------------------------------------
// Synthetic fixtures
// ---------------------------------------------------------------------------

const tsBase = Date.parse("2026-01-01T00:00:00Z");
const fixtures = { transcripts: [], indexBuckets: [], generated: { files: 0, bytes: 0 } };
const MAX_FILES = 5000;
const MAX_BYTES = 200 * 1024 * 1024;

function assertBudget(bytes) {
  assert.ok(fixtures.generated.files < MAX_FILES, `fixture file cap ${MAX_FILES} exceeded`);
  assert.ok(fixtures.generated.bytes + bytes < MAX_BYTES, `fixture byte cap ${MAX_BYTES} exceeded`);
}

function message(id, parentId, n, text) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(tsBase + n).toISOString(),
    message: { role: n % 2 ? "assistant" : "user", timestamp: tsBase + n, content: [{ type: "text", text }] },
  };
}
const line = (value) => JSON.stringify(value) + "\n";

function writeScratchFile(file, data) {
  assertBudget(Buffer.byteLength(data));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  fixtures.generated.files++;
  fixtures.generated.bytes += Buffer.byteLength(data);
}

function buildTail(count) {
  return Array.from({ length: count }, (_, i) =>
    message(`tail-${i}`, i ? `tail-${i - 1}` : "anchor", 1_000_000 + i, `tail text ${i}`),
  );
}

/**
 * Same shape as the original survey fixture: header, long linear prefix of
 * 1 KiB messages, an anchor, then the shared 30-message tail. Keeping the tail
 * generator in one place is what makes the 1/10/100 MiB payload hashes
 * comparable — and comparable with the reused baseline.
 */
function buildTranscriptFixture({ file, nominalMib, targetBytes, tail }) {
  const header = line({
    type: "session",
    version: 3,
    id: `large-${nominalMib}`,
    cwd: path.dirname(file),
    timestamp: new Date(tsBase).toISOString(),
  });
  const tailText = tail.map(line).join("");
  const parts = [header];
  let bytes = Buffer.byteLength(header) + Buffer.byteLength(tailText);
  let parent = null;
  let n = 0;
  while (bytes < targetBytes - 1500) {
    const id = `old-${n}`;
    const part = line(message(id, parent, n, "x".repeat(1024)));
    parts.push(part);
    bytes += Buffer.byteLength(part);
    parent = id;
    n++;
  }
  parts.push(line(message("anchor", parent, n, "anchor")), tailText);
  const data = parts.join("");
  writeScratchFile(file, data);
  return {
    file,
    nominalMib,
    bytes: Buffer.byteLength(data),
    messages: n + tail.length + 1,
    leaf: tail.at(-1).id,
    tail_sha256: createHash("sha256").update(tailText).digest("hex"),
  };
}

function buildTinySessionFiles(dir, cwd, count) {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const file = path.join(dir, `${String(i).padStart(4, "0")}.jsonl`);
    const data =
      line({ type: "session", version: 3, id: `tiny-${i}`, cwd, timestamp: new Date(tsBase).toISOString() }) +
      line(message("tiny-user", null, 0, `tiny ${i}`)) +
      line(message("tiny-assistant", "tiny-user", 1, "response"));
    writeScratchFile(file, data);
  }
}

const tail = buildTail(30);

if (mode === "smoke") {
  const transcriptFile = path.join(idx.sessionDirFor(workspaceLarge, agentRoot), "smoke.jsonl");
  fixtures.transcripts.push(buildTranscriptFixture({ file: transcriptFile, nominalMib: 0.125, targetBytes: 128 * 1024, tail }));
  buildTinySessionFiles(idx.sessionDirFor(workspaceTiny, agentRoot), workspaceTiny, 3);
  fixtures.indexBuckets.push({ scenario: "smoke-few", cwd: workspaceTiny, dir: idx.sessionDirFor(workspaceTiny, agentRoot), files: 3 });
} else {
  for (const mib of [1, 10, 100]) {
    const file = path.join(idx.sessionDirFor(workspaceLarge, agentRoot), `${mib}.jsonl`);
    fixtures.transcripts.push(buildTranscriptFixture({ file, nominalMib: mib, targetBytes: mib * 1024 * 1024, tail }));
  }
  buildTinySessionFiles(idx.sessionDirFor(workspaceTiny, agentRoot), workspaceTiny, 1000);
  fixtures.indexBuckets.push({ scenario: "few-large", cwd: workspaceLarge, dir: idx.sessionDirFor(workspaceLarge, agentRoot), files: 3 });
  fixtures.indexBuckets.push({ scenario: "many-tiny", cwd: workspaceTiny, dir: idx.sessionDirFor(workspaceTiny, agentRoot), files: 1000 });
}

// ---------------------------------------------------------------------------
// Sample shape
// ---------------------------------------------------------------------------

const UNAVAILABLE = {
  queue_ms: "no host/client queue seam on this path (P1/P3/P4)",
  wire_ms: "in-process call; no wire seam (P3/P4)",
  apply_ms: "client apply not instrumented (P4/P5)",
  first_content_ms: "client first visible content not instrumented (P3/P4)",
  long_task_ms: "browser long-task API unavailable in Node (P3)",
};

let sequence = 0;
const runId = `p0-${Date.now().toString(36)}`;
const samples = [];

function nextRequestId(op) {
  sequence++;
  return `${runId}:${op}:${sequence}`;
}

function conditions({ process: processState = "warm", index = "not_applicable", osCache = "unverified", network = "not_applicable" }) {
  return { process: processState, index, os_cache: osCache, network };
}

/**
 * Build a scalar-only sample. Absent metrics stay `null` and are listed under
 * `unavailable` with a reason — never coerced to 0.
 */
function emitSample({
  op,
  scenario,
  conditions: cond,
  query_ms = null,
  read_bytes = null,
  parsed_entries = null,
  cache_hit = null,
  cacheHitReason,
  phases = {},
  counts = {},
  content_sha256 = null,
}) {
  const sample = {
    op,
    requestId: nextRequestId(op),
    scenario,
    conditions: cond,
    queue_ms: null,
    wire_ms: null,
    query_ms,
    read_bytes,
    parsed_entries,
    cache_hit,
    apply_ms: null,
    first_content_ms: null,
    long_task_ms: null,
    unavailable: { ...UNAVAILABLE },
    phases,
    counts,
    content_sha256,
  };
  if (cache_hit !== null) delete sample.unavailable.cache_hit;
  else sample.unavailable.cache_hit = cacheHitReason ?? "no cache seam observable here";
  samples.push(sample);
  return sample;
}

function summarizeSamples(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.op}|${row.scenario}|${row.conditions.index}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].map(([key, group]) => ({
    key,
    n: group.length,
    query_ms: median(group.map((s) => s.query_ms).filter((v) => typeof v === "number")),
    read_bytes: median(group.map((s) => s.read_bytes).filter((v) => typeof v === "number")),
    parsed_entries: median(group.map((s) => s.parsed_entries).filter((v) => typeof v === "number")),
  }));
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const formatting = {
  stringifyContent: (content) =>
    typeof content === "string" ? content : content.filter((b) => b.type === "text").map((b) => b.text).join("\n"),
  stringifyToolResult: (content) => (typeof content === "string" ? content : JSON.stringify(content)),
  imagesFromContent: () => [],
};

async function transcriptSample(fixture, branch) {
  resetIo();
  const start = performance.now();
  const timer = new Promise((resolve) => setTimeout(() => resolve(performance.now() - start), 0));
  const a = performance.now();
  const ids = branch ? tr.activeBranchEntryIds(fixture.file, fixture.leaf) : undefined;
  const b = performance.now();
  if (branch) assert.ok(ids?.has(fixture.leaf), "active branch did not contain the fixture leaf");
  const entries = tr.readTranscriptEntries(fixture.file, branch ? { entryIds: ids } : {});
  const c = performance.now();
  const result = hist.transcriptEventsRecent(entries, 30, formatting);
  const d = performance.now();
  const payload = JSON.stringify(result);
  assert.equal(result.events.length, 30, "expected exactly the requested page of 30 events");
  assert.ok(result.events.some((event) => event.text === "tail text 29"), "shared tail was not returned");
  const counted = snapshotIo();
  const timerDelayMs = await timer;

  return emitSample({
    op: branch ? "transcript_active_branch_recent" : "transcript_recent",
    scenario: `${fixture.nominalMib}MiB`,
    conditions: conditions({ process: "warm", index: "not_applicable", osCache: "unverified" }),
    query_ms: d - a,
    read_bytes: counted.read_bytes,
    parsed_entries: entries.length,
    cache_hit: null,
    cacheHitReason: "transcript read path has no page cache",
    phases: { branch_ms: b - a, read_ms: c - b, recent_ms: d - c, timer0_delay_ms: timerDelayMs },
    counts: {
      read_calls: counted.read_calls,
      branch_ids: ids?.size ?? null,
      entries: entries.length,
      events: result.events.length,
      payload_bytes: Buffer.byteLength(payload),
      older_cursor: result.olderCursor === null ? null : "present",
      has_older: result.hasOlder,
    },
    content_sha256: createHash("sha256").update(payload).digest("hex"),
  });
}

async function indexSample({ cwd, scenario, phase, expectedParsed = null, expectedServed = null, cold = false }) {
  resetIo();
  const start = performance.now();
  const list = await idx.listSessionsIndexed(cwd);
  const elapsedMs = performance.now() - start;
  assert.notEqual(list, null, "listSessionsIndexed returned null: the SDK fallback path must not run here");
  const stats = idx.lastIndexStats();
  if (expectedParsed !== null) assert.equal(stats.parsed, expectedParsed, `${scenario}/${phase}: parsed count`);
  if (expectedServed !== null) assert.equal(stats.served, expectedServed, `${scenario}/${phase}: served count`);
  const counted = snapshotIo();
  const cacheHit = stats.parsed === 0 && stats.served > 0;
  return emitSample({
    op: phase === "empty-index" ? "index_list_lookup" : phase === "append-largest" ? "index_append_ingest" : "index_list_lookup",
    scenario: `${scenario}:${phase}`,
    conditions: conditions({ process: "warm", index: cold ? "cold" : "warm", osCache: "unverified" }),
    query_ms: elapsedMs,
    read_bytes: counted.read_bytes,
    parsed_entries: stats.parsed,
    cache_hit: phase === "append-largest" ? false : cacheHit,
    phases: { elapsed_ms: elapsedMs },
    counts: {
      served: list.length,
      files_parsed: stats.parsed,
      read_calls: counted.read_calls,
      payload_bytes: Buffer.byteLength(JSON.stringify(list)),
    },
  });
}

// Process-cold module load is a measured segment, not folklore.
emitSample({
  op: "module_import",
  scenario: `${mode}:compiled-dist`,
  conditions: conditions({ process: "cold" }),
  query_ms: moduleImportMs,
  phases: { import_ms: moduleImportMs },
  counts: { modules: imported.length },
});

// SDK priming is separate from query cost (43 s on the original survey). It is
// measured once here so every later sample can be honestly labeled warm.
{
  resetIo();
  const start = performance.now();
  await idx.primeAgentDir();
  const sdkPrimeMs = performance.now() - start;
  emitSample({
    op: "sdk_prime",
    scenario: "first-agent-root-lookup",
    conditions: conditions({ process: "cold" }),
    query_ms: sdkPrimeMs,
    phases: { sdk_prime_ms: sdkPrimeMs },
    counts: { jsonl_reads: snapshotIo().read_calls },
  });
}

// Warmup plus timed transcript samples, both page paths.
for (const fixture of fixtures.transcripts) {
  await transcriptSample(fixture, false);
  for (let i = 0; i < sampleCount; i++) await transcriptSample(fixture, false);
  await transcriptSample(fixture, true);
  for (let i = 0; i < sampleCount; i++) await transcriptSample(fixture, true);
  console.error(`[${mode}] transcript ${fixture.nominalMib} MiB done`);
}

// Index scenarios: empty index, warm lookups, append ingest, warm lookups.
for (const bucket of fixtures.indexBuckets) {
  await indexSample({ cwd: bucket.cwd, scenario: bucket.scenario, phase: "empty-index", expectedParsed: bucket.files, expectedServed: bucket.files, cold: true });
  for (let i = 0; i < sampleCount; i++) {
    await indexSample({ cwd: bucket.cwd, scenario: bucket.scenario, phase: "unchanged-warm", expectedParsed: 0, expectedServed: bucket.files });
  }
  const largest = original
    .readdirSync(bucket.dir)
    .map((name) => path.join(bucket.dir, name))
    .sort((a, b) => sizeOf(b) - sizeOf(a))[0];
  const append = line(message("appended", tail.at(-1).id, 2_000_000, "appended synthetic message"));
  assertBudget(Buffer.byteLength(append));
  fs.appendFileSync(largest, append);
  await indexSample({ cwd: bucket.cwd, scenario: bucket.scenario, phase: "append-largest", expectedParsed: 1, expectedServed: bucket.files });
  for (let i = 0; i < sampleCount; i++) {
    await indexSample({ cwd: bucket.cwd, scenario: bucket.scenario, phase: "post-append-warm", expectedParsed: 0, expectedServed: bucket.files });
  }
  console.error(`[${mode}] index ${bucket.scenario} done`);
}

// ---------------------------------------------------------------------------
// Optional explicit future-module seam (P2 history service, P3/P4 clients)
// ---------------------------------------------------------------------------

const TARGET_FIELDS = [
  "op", "requestId", "scenario", "conditions",
  "queue_ms", "wire_ms", "query_ms", "read_bytes", "parsed_entries",
  "cache_hit", "apply_ms", "first_content_ms", "long_task_ms",
  "phases", "counts", "content_sha256",
];

function normalizeTargetSample(value, index) {
  assert.ok(value && typeof value === "object", `target sample ${index} is not an object`);
  assert.ok(typeof value.op === "string" && value.op.length > 0, `target sample ${index} needs an op`);
  const sample = {};
  for (const key of TARGET_FIELDS) if (Object.hasOwn(value, key)) sample[key] = value[key];
  for (const key of ["queue_ms", "wire_ms", "query_ms", "read_bytes", "parsed_entries", "apply_ms", "first_content_ms", "long_task_ms"]) {
    if (sample[key] !== undefined && sample[key] !== null && typeof sample[key] !== "number") {
      throw new Error(`target sample ${index}: ${key} must be a number, null, or omitted`);
    }
  }
  if (sample.cache_hit !== undefined && sample.cache_hit !== null && typeof sample.cache_hit !== "boolean") {
    throw new Error(`target sample ${index}: cache_hit must be boolean, null, or omitted`);
  }
  return sample;
}

async function runTarget() {
  if (opts.target === undefined) {
    return { status: "not_requested", note: "P2/P3/P4 can plug a module in with --target/--target-export; nothing is stubbed." };
  }
  const targetFile = path.resolve(opts.target);
  if (!original.existsSync(targetFile)) {
    return { status: "unavailable", reason: "target module not found", path: targetFile };
  }
  assert.notEqual(targetFile, FORBIDDEN_ENTRY, "target must not be server/dist/index.js");
  if (opts["target-export"] === undefined) {
    return { status: "unavailable", reason: "--target-export is required when --target is given", path: targetFile };
  }
  const mod = await import(pathToFileURL(targetFile).href);
  const fn = mod[opts["target-export"]];
  if (typeof fn !== "function") {
    return { status: "unavailable", reason: `export ${opts["target-export"]} is missing or not a function`, path: targetFile };
  }
  let arg;
  if (opts["target-arg"] !== undefined) {
    try {
      arg = JSON.parse(opts["target-arg"]);
    } catch (error) {
      return { status: "unavailable", reason: `--target-arg is not valid JSON: ${error.message}`, path: targetFile };
    }
  }
  const captured = [];
  const ctx = {
    scratch,
    agentRoot,
    workspace: { large: workspaceLarge, tiny: workspaceTiny },
    fixtures,
    performance,
    emit: (sample) => captured.push(normalizeTargetSample(sample, captured.length)),
  };
  const start = performance.now();
  const result = await fn(ctx, arg);
  const elapsedMs = performance.now() - start;
  if (Array.isArray(result?.samples)) {
    for (const sample of result.samples) captured.push(normalizeTargetSample(sample, captured.length));
  }
  return {
    status: "measured",
    path: targetFile,
    export: opts["target-export"],
    elapsed_ms: elapsedMs,
    samples: captured,
  };
}

const target = await runTarget();

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const transcriptSamples = samples.filter((s) => s.op.startsWith("transcript"));
const indexSamples = samples.filter((s) => s.op.startsWith("index"));
const uniqueContentHashes = new Set(transcriptSamples.map((s) => s.content_sha256));
const sharedTailIdentical = uniqueContentHashes.size === 1;
const emptyIndexParsedAll = indexSamples
  .filter((s) => s.scenario.endsWith(":empty-index"))
  .every((s) => s.parsed_entries === s.counts.served);
const appendParsedOne = indexSamples
  .filter((s) => s.scenario.endsWith(":append-largest"))
  .every((s) => s.parsed_entries === 1);
const warmUsedIndex = indexSamples
  .filter((s) => /:(unchanged-warm|post-append-warm)$/u.test(s.scenario))
  .every((s) => s.cache_hit === true);

const baselineTailHash = baselineReuse.status === "reused"
  ? JSON.parse(original.readFileSync(path.join(baselineReuse.dir, "bench", "results.json"), "utf8")).sharedTail?.tailSha256 ?? null
  : null;
const fixtureTailHash = createHash("sha256").update(tail.map(line).join("")).digest("hex");

const isolationChecks = [
  {
    name: "scratch_env_set_before_import",
    result: process.env["REMOTE_PI_HOME"] === homeDir && process.env["PI_CODING_AGENT_DIR"] === agentRoot ? "pass" : "fail",
    evidence: { remote_pi_home: process.env["REMOTE_PI_HOME"], agent_root: process.env["PI_CODING_AGENT_DIR"] },
  },
  {
    name: "index_db_under_scratch",
    result: isInside(scratch, dbPath) ? "pass" : "fail",
    evidence: { index_db: dbPath, scratch_root: scratch },
  },
  {
    name: "derived_session_bucket_under_scratch_agent_root",
    result: isInside(agentRoot, idx.sessionDirFor(workspaceLarge, agentRoot)) ? "pass" : "fail",
    evidence: { bucket: idx.sessionDirFor(workspaceLarge, agentRoot), agent_root: agentRoot },
  },
  {
    name: "no_jsonl_read_outside_scratch",
    result: io.outsideScratchJsonl === 0 ? "pass" : "fail",
    evidence: { outside_scratch_jsonl_reads: io.outsideScratchJsonl },
  },
  {
    name: "no_sdk_list_fallback",
    result: "pass",
    evidence: { assertion: "listSessionsIndexed() != null on every index sample" },
  },
  {
    name: "server_index_not_imported",
    result: imported.some((rel) => path.resolve(SERVER_ROOT, rel) === FORBIDDEN_ENTRY) ? "fail" : "pass",
    evidence: { imported },
  },
  {
    name: "no_sync_write_outside_scratch",
    result: io.blockedWrites === 0 ? "pass" : "fail",
    evidence: { blocked_writes: io.blockedWrites, enforcement: "fs.writeFileSync/appendFileSync/mkdirSync/rmSync throw outside scratch" },
  },
];

const report = {
  schema: "remote-pi.perf.v1",
  tool: "server/scripts/bench-history-performance.mjs",
  plan: "86-workspace-history-performance",
  phase: "P0",
  generated_at: new Date().toISOString(),
  mode,
  samples_per_phase: sampleCount,
  run_id: runId,
  metricContract: {
    version: 1,
    units: { time: "ms", bytes: "bytes", counts: "count" },
    fields: [
      "op", "requestId", "queue_ms", "wire_ms", "query_ms", "read_bytes",
      "parsed_entries", "cache_hit", "apply_ms", "first_content_ms", "long_task_ms",
    ],
    null_means: "not measured/available on this path; never reported as 0",
    conditions: {
      process: ["cold", "warm"],
      index: ["cold", "warm", "not_applicable"],
      os_cache: ["cold", "warm", "unverified"],
      network: ["cold", "warm", "not_applicable", "unverified"],
    },
    cache_hit_note: "index ops: true when the lookup reparsed 0 files and served >0 rows; transcript ops: null (no page cache)",
    parsed_entries_note: "transcript ops: parsed entries; index ops: transcript files reparsed (counts.files_parsed)",
    current_ops: ["module_import", "sdk_prime", "transcript_recent", "transcript_active_branch_recent", "index_list_lookup", "index_append_ingest"],
    reserved_ops: ["history_list", "history_read", "history_body", "client_list_apply", "client_read_apply", "client_first_content", "client_long_task"],
    target_contract: {
      invocation: "await export(ctx, arg) where ctx = { scratch, agentRoot, workspace, fixtures, performance, emit }",
      result: "call ctx.emit(sample) and/or return { samples: [...] }; unknown keys are dropped",
      required: "op: string; every numeric metric must be number|null|omitted; cache_hit boolean|null|omitted",
    },
  },
  privacy: {
    scalar_only: true,
    contains_message_bodies: false,
    contains_tokens: false,
    contains_credentials: false,
    content_hashes_are_synthetic_only: true,
  },
  isolation: {
    checks: isolationChecks,
    passed: isolationChecks.filter((c) => c.result === "pass").length,
    total: isolationChecks.length,
    scratch_root: scratch,
    remote_pi_home: homeDir,
    agent_root: agentRoot,
    index_db: dbPath,
    imported_modules: imported,
    server_index_imported: false,
  },
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    os_release: os.release(),
    cpu: os.cpus()[0]?.model ?? null,
    logical_cpus: os.cpus().length,
    memory_bytes: os.totalmem(),
    sqlite: "node:sqlite built-in",
    filesystem_cache: "unverified; no OS cache flush was attempted",
  },
  provenance,
  fixtures: {
    transcripts: fixtures.transcripts,
    index_buckets: fixtures.indexBuckets.map(({ scenario, cwd, files }) => ({ scenario, cwd, files })),
    generated_files: fixtures.generated.files,
    generated_bytes: fixtures.generated.bytes,
    shared_tail: {
      messages: 30,
      leaf: tail.at(-1).id,
      tail_sha256: fixtureTailHash,
      matches_reused_baseline: baselineTailHash === null ? null : baselineTailHash === fixtureTailHash,
    },
    empty_index_means: "no rows for this bucket in a fresh scratch database; not an OS-cold disk",
  },
  samples,
  summary: summarizeSamples(samples),
  checks: {
    transcript_page_is_30_events: transcriptSamples.every((s) => s.counts.events === 30),
    shared_tail_payload_identical: sharedTailIdentical,
    index_empty_parsed_all: emptyIndexParsedAll,
    append_parsed_one: appendParsedOne,
    warm_lookups_reparsed_zero: warmUsedIndex,
  },
  target,
  baselineReuse,
  limits: [
    "Synthetic text-only linear parent chains; no tool/image/fork workload and no user history.",
    "filesystem_cache is unverified: Windows has no supported per-process drop; this is not an OS-cold measurement.",
    "Transcript read_bytes counts full-file JSONL JS reads, not physical disk I/O.",
    "Client-side spans (queue_ms, wire_ms, apply_ms, first_content_ms, long_task_ms) stay null until P3/P4 instrument the real seams.",
    "The minute-scale 1/10/100 MiB and 1000-session matrix is opt-in (--mode matrix); the smoke run does not re-measure the existing baseline.",
    "timer0_delay_ms includes timer scheduling and tiny serialization/assertion overhead; query_ms isolates the synchronous work.",
    "No build, no tests, no server/index.js, no real session, no network, no pairing state.",
  ],
};

// Scalar-only guard: sentinel strings from the synthetic fixtures must never
// appear in the emitted report.
const serialized = JSON.stringify(report);
for (const sentinel of ["tail text 29", "appended synthetic message", "x".repeat(32)]) {
  assert.equal(serialized.includes(sentinel), false, "report leaked synthetic message text");
}

// ---------------------------------------------------------------------------
// Cleanup + output
// ---------------------------------------------------------------------------

const cleanup = cleanupResources();
report.cleanup = { ...cleanup };

// Writing --out bypasses the scratch write guard on purpose: it is an explicit
// operator path, and it is the only constructed output.
if (opts.out !== undefined) {
  const outFile = path.resolve(opts.out);
  original.mkdirSync(path.dirname(outFile), { recursive: true });
  original.writeFileSync(outFile, JSON.stringify(report, null, 2) + "\n");
}

// Human summary on stderr (stdout stays parseable JSON).
console.error(`[${mode}] isolation ${report.isolation.passed}/${report.isolation.total} pass`);
for (const row of report.summary) {
  console.error(
    `[${mode}] ${row.key} n=${row.n} query_ms=${row.query_ms === null ? "unavailable" : row.query_ms.toFixed(2)} ` +
      `read_bytes=${row.read_bytes ?? "unavailable"} parsed=${row.parsed_entries ?? "unavailable"}`,
  );
}
console.error(`[${mode}] baseline references: ${baselineReuse.status}${baselineReuse.status === "reused" ? ` (${baselineReuse.rawFiles.length} files, remeasured=false)` : ""}`);
console.error(`[${mode}] target: ${report.target.status}`);
console.error(`[${mode}] cleanup: index_closed=${cleanup.index_closed} scratch_removed=${cleanup.scratch_removed}`);
if (opts.out !== undefined) console.error(`[${mode}] wrote ${path.resolve(opts.out)}`);

process.stdout.write(JSON.stringify(report, null, 2) + "\n");
