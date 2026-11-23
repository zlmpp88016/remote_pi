/**
 * Plan 86 P2 — ONE 100 MiB transcript entry.
 *
 * This is the case the approved plan treats as a hard boundary: the first page
 * must come from the bounded summary/refs WITHOUT reading the line, the body
 * must decode once into a generation sidecar and hash identically after JSON
 * escapes/surrogate/UTF-8 handling, and later chunks must be position reads
 * (not a whole-line reparse).
 *
 * The fixture is written streaming (no 100 MiB JS string). The expected decoded
 * text hash is computed incrementally from the same pattern, so the assertion
 * is byte-exact without materializing the text either.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HistoryService } from "./history_service.js";
import { createInlineHistoryPort } from "./history_worker_client.js";
import { historyBodiesRoot } from "./history_index.js";
import { HISTORY_BODY_MAX_TOTAL_BYTES } from "../protocol/history.js";
import { makeHistoryFixture, type HistoryFixture } from "../../test/history_fixtures.js";

const DAEMON = "aaaa1111";
const SESSION = "s1";
const TARGET_RAW_BYTES = 100 * 1024 * 1024;

let fixture: HistoryFixture;
let file = "";
let decodedBytes = 0;
let decodedDigest = "";
let rawLineBytes = 0;

beforeAll(() => {
  fixture = makeHistoryFixture("rp86-giant-");
  file = path.join(fixture.bucket, "2026-01-01T00-00-00-000Z_s1.jsonl");
  // Decoded: A"B\C<newline>D😀Eαβγ   Raw JSON escapes the quote/backslash/newline
  // and the surrogate pair. Literal multibyte UTF-8 remains raw.
  const rawPattern = 'A\\"B\\\\C\\nD\\uD83D\\uDE00Eαβγ';
  const decodedPattern = 'A"B\\C\nD😀Eαβγ';
  const decodedPatternBytes = Buffer.from(decodedPattern, "utf8");
  const header = JSON.stringify({
    type: "session",
    id: SESSION,
    cwd: fixture.cwd,
    timestamp: "2026-01-01T00:00:00.000Z",
  });
  const prefix =
    '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"A\\"B\\\\C\\nD\\uD83D\\uDE00Eαβγ';
  // prefix already contains ONE decoded pattern (raw escapes) before the loop;
  // the loop writes additional patterns, then a lone surrogate and the suffix.
  const suffix = '\\uD800"}]}}\n';
  const rawPatternBytes = Buffer.byteLength(rawPattern, "utf8");
  const overhead =
    Buffer.byteLength(header, "utf8") + 1 + Buffer.byteLength(prefix, "utf8") + Buffer.byteLength(suffix, "utf8");
  const patterns = Math.ceil((TARGET_RAW_BYTES - overhead) / rawPatternBytes);
  const blockPatterns = 2048;
  const block = rawPattern.repeat(blockPatterns);

  const hash = createHash("sha256");
  hash.update(decodedPatternBytes); // the pattern embedded in `prefix`
  decodedBytes = decodedPatternBytes.length;

  const fd = fs.openSync(file, "w");
  try {
    fs.writeSync(fd, header + "\n" + prefix);
    let written = 0;
    while (written < patterns) {
      const count = Math.min(blockPatterns, patterns - written);
      fs.writeSync(fd, count === blockPatterns ? block : rawPattern.repeat(count));
      for (let index = 0; index < count; index += 1) hash.update(decodedPatternBytes);
      written += count;
      decodedBytes += count * decodedPatternBytes.length;
    }
    fs.writeSync(fd, suffix);
    // The lone surrogate becomes U+FFFD under UTF-8 encoding, like P1.
    hash.update(Buffer.from("\uD800", "utf8"));
    decodedBytes += Buffer.byteLength("\uD800", "utf8");
  } finally {
    fs.closeSync(fd);
  }
  decodedDigest = hash.digest("hex");
  rawLineBytes = fs.statSync(file).size;
  expect(rawLineBytes).toBeGreaterThan(TARGET_RAW_BYTES - 1024 * 1024);
}, 120_000);

afterAll(() => {
  fixture?.cleanup();
});

function service(): HistoryService {
  return new HistoryService({
    resolveWorkspace: (daemonId) =>
      daemonId === DAEMON ? { daemon_id: daemonId, cwd: fixture.cwd, name: "ws" } : null,
    runtime: () => ({ state: "stopped", session_id: null, ready: false }),
    agentRoot: fixture.root,
    remoteHome: `${fixture.root}/remote-home`,
    reconcileIntervalMs: 0,
    // Materialize synchronously for this test: the FIRST explicit body call is
    // where the O(body) cost must be measured (the async `building` path is
    // covered by the focused body test and the P1 suite).
    bodyEagerMaxBytes: HISTORY_BODY_MAX_TOTAL_BYTES,
    workerPortFactory: () => createInlineHistoryPort(),
  });
}

async function firstPage(svc: HistoryService): Promise<{
  snapshot: string;
  ref: { ref: string; total_bytes: number; digest: string; preview: string | null };
  queryMs: number;
  readBytes: number | null;
}> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const outcome = await svc.read({ type: "history_read", id: `R-${attempt}`, daemon_id: DAEMON, session_id: SESSION });
    if (outcome.reply.type === "history_read_ok") {
      expect(outcome.reply.items).toHaveLength(1);
      const item = outcome.reply.items[0]!;
      expect(item.event_id).toBe("m1");
      if (item.event.type !== "agent_message") throw new Error("expected agent_message");
      expect(item.event.text.length).toBeLessThan(5000);
      const ref = item.body_refs?.[0];
      if (ref === undefined) throw new Error("missing body ref");
      expect(ref.total_bytes).toBe(decodedBytes);
      return {
        snapshot: outcome.reply.snapshot,
        ref: { ref: ref.ref, total_bytes: ref.total_bytes, digest: ref.digest, preview: ref.preview },
        queryMs: outcome.metrics.query_ms ?? 0,
        readBytes: outcome.metrics.read_bytes,
      };
    }
    expect(outcome.reply).toMatchObject({ type: "history_error", code: "building" });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("giant session never became readable");
}

async function bodyUntilMaterialized(
  svc: HistoryService,
  snapshot: string,
  ref: string,
  offset: number,
  timeoutMs: number,
): Promise<Awaited<ReturnType<HistoryService["body"]>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const outcome = await svc.body({
      type: "history_body",
      id: `B-${offset}-${Date.now()}`,
      daemon_id: DAEMON,
      session_id: SESSION,
      snapshot,
      body_ref: ref,
      offset_bytes: offset,
    });
    if (outcome.reply.type !== "history_error" || outcome.reply.code !== "building") return outcome;
    if (Date.now() > deadline) throw new Error("body materialization timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("plan 86 P2 — 100 MiB single entry", () => {
  test("first page is bounded, the body hash matches, later chunks are position reads", async () => {
    expect(HISTORY_BODY_MAX_TOTAL_BYTES).toBeGreaterThan(TARGET_RAW_BYTES);
    const svc = service();
    try {
      const page = await firstPage(svc);
      // The first page did not decode the body: it came from the index summary.
      expect(page.ref.total_bytes).toBe(decodedBytes);
      expect(Buffer.byteLength(page.ref.preview ?? "", "utf8")).toBeLessThanOrEqual(4096);

      // First explicit body: the O(body) decode happens ONCE, here.
      const chunk0 = await bodyUntilMaterialized(svc, page.snapshot, page.ref.ref, 0, 120_000);
      if (chunk0.reply.type !== "history_body_ok") throw new Error(`body ${chunk0.reply.type}`);
      expect(chunk0.reply.total_bytes).toBe(decodedBytes);
      expect(chunk0.reply.offset_bytes).toBe(0);
      expect(chunk0.reply.next_offset_bytes).toBe(65536);
      expect(Buffer.from(chunk0.reply.data, "base64")).toHaveLength(65536);
      expect(chunk0.metrics.body_source_bytes ?? 0).toBeGreaterThan(TARGET_RAW_BYTES - 1024 * 1024);
      expect(chunk0.metrics.body_decode_ms ?? 0).toBeGreaterThan(0);

      // The sidecar is the FULL representation: hash it byte-for-byte.
      const generation = findGeneration();
      expect(generation).not.toBe("");
      const sidecar = findSidecar(generation);
      expect(sidecar).not.toBe("");
      const sidecarHash = createHash("sha256").update(fs.readFileSync(sidecar)).digest("hex");
      expect(sidecarHash).toBe(decodedDigest);
      expect(fs.statSync(sidecar).size).toBe(decodedBytes);

      // Subsequent chunks: position reads of the sidecar, no source re-read.
      const chunk1 = await bodyUntilMaterialized(svc, page.snapshot, page.ref.ref, 65536, 30_000);
      if (chunk1.reply.type !== "history_body_ok") throw new Error(`body ${chunk1.reply.type}`);
      expect(chunk1.reply.offset_bytes).toBe(65536);
      expect(chunk1.reply.next_offset_bytes).toBe(131072);
      expect(chunk1.metrics.body_source_bytes ?? 0).toBe(0);
      expect(chunk1.metrics.body_sidecar_bytes ?? 0).toBe(65536);
      expect(chunk1.metrics.read_bytes ?? 0).toBeLessThan(256 * 1024);

      const sidecarBytes = fs.readFileSync(sidecar).subarray(0, 131072);
      expect(Buffer.concat([
        Buffer.from(chunk0.reply.data, "base64"),
        Buffer.from(chunk1.reply.data, "base64"),
      ]).equals(sidecarBytes)).toBe(true);

      // A warm page (no body) reads no transcript bytes at all.
      const warm = await firstPage(svc);
      expect(warm.readBytes === null || warm.readBytes < 64 * 1024).toBe(true);
      expect(warm.queryMs).toBeGreaterThanOrEqual(0);
    } finally {
      await svc.dispose();
    }
  }, 240_000);
});

function findGeneration(): string {
  const root = historyBodiesRoot(`${fixture.root}/remote-home`);
  try {
    const dirs = fs.readdirSync(root).filter((name) => name.startsWith("g-"));
    return dirs.length === 1 ? dirs[0]!.slice(2) : "";
  } catch {
    return "";
  }
}

function findSidecar(generation: string): string {
  const dir = path.join(historyBodiesRoot(`${fixture.root}/remote-home`), `g-${generation}`);
  try {
    const files = fs.readdirSync(dir).filter((name) => name.endsWith(".bin"));
    return files.length === 1 ? path.join(dir, files[0]!) : "";
  } catch {
    return "";
  }
}
