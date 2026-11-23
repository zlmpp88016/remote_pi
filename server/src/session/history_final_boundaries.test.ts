import { afterEach, beforeEach, expect, test } from "vitest";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { HistoryService } from "./history_service.js";
import { createInlineHistoryPort } from "./history_worker_client.js";
import { closeIndexHandles, historyDbPath, readerFor, writerFor, sourceStampOf } from "./history_index.js";
import { handleHistoryWorkerRequest } from "./history_worker.js";
import { decodeHistorySnapshot, decodeHistoryReadCursor, fitsHistoryEncodedFrame } from "../protocol/history.js";
import { makeHistoryFixture, writeTranscript, imageBlock, userMessage, assistantMessage, textBlock, toolCallBlock, toolResultMessage, type HistoryFixture } from "../../test/history_fixtures.js";
let fixture: HistoryFixture;
let home: string;
let svc: HistoryService;
const daemon = "aaaa1111";
beforeEach(() => {
  fixture = makeHistoryFixture("rp86-final-"); home = `${fixture.root}/remote`;
  svc = new HistoryService({ resolveWorkspace: () => ({ daemon_id: daemon, cwd: fixture.cwd, name: "ws" }), runtime: () => null,
    agentRoot: fixture.root, remoteHome: home, reconcileIntervalMs: 0, workerPortFactory: () => createInlineHistoryPort() });
});
afterEach(async () => { await svc.dispose(); closeIndexHandles(); fixture.cleanup(); });
async function read(extra: Record<string, unknown> = {}) {
  for (let i = 0; i < 100; i++) {
    const out = await svc.read({ type: "history_read", id: "r", daemon_id: daemon, session_id: "s1", ...extra });
    if (out.reply.type === "history_error" && out.reply.code === "building") { await new Promise(r => setTimeout(r, 5)); continue; }
    if (out.reply.type !== "history_read_ok") throw Error(JSON.stringify(out.reply));
    return out.reply;
  }
  throw Error("build timeout");
}
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
test("R1/R2: runtime authority claims cannot enable service append trust", async () => {
  const claimed = new HistoryService({ resolveWorkspace: () => ({ daemon_id: daemon, cwd: fixture.cwd, name: "ws" }),
    runtime: () => ({ state: "running", session_id: "s1", ready: true, session_file: `${fixture.bucket}/claimed.jsonl`, append_authority: true }),
    agentRoot: fixture.root, remoteHome: home, workerPortFactory: () => createInlineHistoryPort() });
  try {
    const gates = claimed as unknown as { trustedWriters(id: string): unknown[]; trustedWriterFor(id: string, session: string): unknown };
    expect(gates.trustedWriters(daemon)).toEqual([]);
    expect(gates.trustedWriterFor(daemon, "s1")).toBeNull();
  } finally { await claimed.dispose(); }
});
test.each([200, 1025])("F1/F2: %i inline images and text have public handles, without holes or duplicates", async count => {
  const data = Array.from({ length: count }, (_, i) => Buffer.alloc(2048, i % 251));
  writeTranscript(fixture.bucket, { id: "s1", cwd: fixture.cwd, messages: [{ id: "wide", message: { role: "user", content: [textBlock("retained inline text"), ...data.map(b => imageBlock(b.toString("base64"), "image/png"))] } }] });
  const seen = new Set<string>(); const cursors = new Set<string>(); let before: string | undefined; let snapshot: string | undefined;
  let pages = 0;
  do {
    const page = await read(before ? { before } : {});
    expect(fitsHistoryEncodedFrame(page)).toBe(true);
    snapshot ??= page.snapshot; expect(page.snapshot).toBe(snapshot);
    for (const item of page.items) {
      expect(item.event_id).toBe("wide"); expect(item.body_refs?.length ?? 0).toBeLessThanOrEqual(16);
      for (const ref of item.body_refs ?? []) {
        expect(seen.has(ref.field), `duplicate ${ref.field}`).toBe(false); seen.add(ref.field);
        const body = await svc.body({ type: "history_body", id: "b", daemon_id: daemon, session_id: "s1", snapshot: page.snapshot, body_ref: ref.ref, offset_bytes: 0 });
        if (body.reply.type !== "history_body_ok") throw Error(JSON.stringify(body.reply));
        expect(body.reply.representation).toBe(ref.field === "text" ? "text_utf8" : "binary");
        const bytes = Buffer.from(body.reply.data, "base64");
        const expected = ref.field === "text" ? Buffer.from("retained inline text") : data[Number(ref.field.slice(7))]!;
        expect(hash(bytes)).toBe(hash(expected)); expect(bytes.length).toBe(expected.length);
      }
    }
    expect(++pages).toBeLessThan(100);
    before = page.older_cursor ?? undefined;
    expect(page.has_older).toBe(before !== undefined);
    if (before) { expect(cursors.has(before)).toBe(false); cursors.add(before); }
  } while (before);
  expect(seen.size).toBe(count + 1);
  for (let i = 0; i < count; i++) expect(seen.has(`images.${i}`)).toBe(true);
}, 30000);

test("F3: same-generation primary, tool parent, seed and reply/cursor water are fenced", async () => {
  const { file } = writeTranscript(fixture.bucket, { id: "s1", cwd: fixture.cwd, messages: [
    userMessage("u1", "old user"), assistantMessage("a1", [textBlock("old assistant")]), toolResultMessage("r1", "late-tool", "old result"),
  ] });
  const first = await read({ limit: 1 });
  const decoded = decodeHistorySnapshot(first.snapshot, { daemon_id: daemon, session_id: "s1" });
  if (!decoded.ok) throw Error("snapshot");
  const { generation, high_water: water } = decoded.value;
  const reader = readerFor(historyDbPath(home)); expect(reader.open()).toBe(true);
  const oldRow = reader.session(fixture.bucket, "s1")!;
  // Synthetic index publication under the SAME generation exercises the reader
  // independently of the intentionally disabled production append authority.
  fs.appendFileSync(file, '{}\n');
  const writer = writerFor(historyDbPath(home)); expect(writer.open().ok).toBe(true);
  writer.insertEntry({ workspace: fixture.bucket, session_id: "s1", generation, entry_id: "late", parent_id: null,
    timestamp: "2026-01-01T00:00:01.500Z", role: "user", event_count: 0, seed_user_id: null, line_start: water, line_end: water + 2, projections: "[]" });
  writer.insertToolCall(fixture.bucket, "s1", generation, "late-tool", "late", "2026-01-01T00:00:01.500Z");
  writer.recomputeSeeds(fixture.bucket, "s1", generation);
  const stat = fs.statSync(file); const identity = { ino: Number(stat.ino), birthtime_ms: stat.birthtimeMs, size: stat.size, mtime_ms: stat.mtimeMs, ctime_ms: stat.ctimeMs };
  writer.publishSession({ ...oldRow, ...identity, high_water: stat.size - 1, source_stamp: sourceStampOf(identity) });
  expect(reader.page(fixture.bucket, "s1", generation, 30, null, { highWater: water }).entries.map(e => e.entry_id)).not.toContain("late");
  expect(reader.toolCallParent(fixture.bucket, "s1", generation, "late-tool", "2026-01-01T00:00:03.000Z", water)).toBeNull();
  const assistant = reader.entry(fixture.bucket, "s1", generation, "a1")!;
  expect(assistant.seed_user_id).toBe("late");
  expect(reader.seedAt(fixture.bucket, "s1", generation, assistant, water)).toBe("u1");
  // Public service is allowed to read an unchanged, synthetically published row;
  // neither a writer notice nor production append authority is injected.
  const page = await read({ snapshot: first.snapshot, limit: 1 });
  expect(page.snapshot).toBe(first.snapshot);
  const cursor = decodeHistoryReadCursor(page.older_cursor, { daemon_id: daemon, session_id: "s1" });
  expect(cursor.ok && cursor.value.high_water).toBe(water);
  let older = page.older_cursor;
  const seen = new Set(page.items.map(item => item.event_id));
  let pages = 1;
  while (older !== null) {
    const next = await read({ before: older, limit: 1 });
    expect(next.snapshot).toBe(first.snapshot);
    for (const item of next.items) seen.add(item.event_id);
    if (next.older_cursor !== null) {
      const token = decodeHistoryReadCursor(next.older_cursor, { daemon_id: daemon, session_id: "s1" });
      expect(token.ok && token.value.high_water).toBe(water);
    }
    older = next.older_cursor;
    expect(++pages).toBeLessThan(10);
  }
  expect([...seen].sort()).toEqual(["a1", "r1", "u1"]);
  const workerRead = async (high_water: number) => handleHistoryWorkerRequest({ id: 77, kind: "read", remote_home: home, bucket: fixture.bucket, session_id: "s1", generation, high_water, limit: 30, before: null, trusted: null }, "reader");
  expect(await workerRead(stat.size)).toMatchObject({ ok: true, value: { status: "stale" } });
  expect(await workerRead(water - 1)).toMatchObject({ ok: true, value: { status: "stale" } });
  const valid = await workerRead(water);
  expect(valid).toMatchObject({ ok: true, value: { status: "ready" } });
  if (!valid?.ok || !("items" in valid.value)) throw Error("reader");
  const items = valid.value.items as Array<{ event_id: string; event: Record<string, unknown> }>;
  expect(items.map(i => i.event_id)).not.toContain("late");
  expect(items.find(i => i.event_id === "a1")?.event.in_reply_to).toBe("u1");
});
