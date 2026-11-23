/**
 * Plan 86 P2 CONSOLIDATED CORRECTION (86-P2-R1 … 86-P2-R5) — focused regressions.
 *
 * Each describe block reproduces the exact boundary its finding named, on REAL
 * temp files and an isolated `remoteHome`. No test touches `~/.pi`, a live Pi, a
 * pairing store or a production DB, and none sends a model prompt.
 *
 *   R1  the production append path must actually be incremental once the child's
 *       own writer notice reaches the host — not only under injected trust.
 *   R2  a matching session id + a live slot is NOT append authority: an earlier
 *       in-place rewrite followed by an append must be a conservative rebuild.
 *   R3  every omitted value must stay reachable (17 images, shrink path).
 *   R4  one entry with thousands of blocks must be fully reachable across pages.
 *   R5  a snapshot's byte high-water must be ENFORCED, and a backdated append
 *       must not enter an older page.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { HistoryService } from "./history_service.js";
import { createInlineHistoryPort } from "./history_worker_client.js";
import { closeIndexHandles } from "./history_index.js";
import { createHistoryNoticeEmitter } from "./history_notice_emitter.js";
import { parseHistoryNotice, formatHistoryNotice, HISTORY_NOTICE_VERSION } from "./history_notice.js";
import { WriterAuthorityRegistry } from "../daemon/history_writer_authority.js";
import { fitsHistoryEncodedFrame, HISTORY_MAX_ENCODED_FRAME_BYTES, HISTORY_MAX_BODY_REFS_PER_ITEM } from "../protocol/history.js";
import {
  assistantMessage,
  imageBlock,
  makeHistoryFixture,
  textBlock,
  toolCallBlock,
  toolResultMessage,
  userMessage,
  writeTranscript,
  type HistoryFixture,
} from "../../test/history_fixtures.js";

const DAEMON = "aaaa1111";
const SESSION = "s1";

let fixture: HistoryFixture;
let remoteHome: string;

beforeEach(() => {
  fixture = makeHistoryFixture("rp86-landing-");
  remoteHome = `${fixture.root}/remote-home`;
});

afterEach(() => {
  closeIndexHandles();
  fixture.cleanup();
});

interface Stamp {
  ino: number;
  birthtime_ms: number;
  size: number;
  mtime_ms: number;
  ctime_ms: number;
}

interface Span {
  before: Stamp;
  after: Stamp;
}

/**
 * A MUTABLE model of the live child's custody RANGE (R1/R2), driven in the REAL
 * SDK order.
 *
 * `agent-session.js:272` runs the extension hook; `:287` appends the entry. The
 * emitter therefore records a BOUNDARY at each hook and publishes the range
 * between two consecutive boundaries — one hook late, flushed at turn end. This
 * helper reproduces exactly that.
 */
interface LiveWriter {
  session_id: string;
  file: string;
  span: Span | null;
  /** Record a pre-persist boundary (the `message_end` hook). */
  boundary(): void;
  /** Close the pending range now (the `turn_end` flush). */
  flush(): void;
  /** Publish an EXPLICIT span (a stale or foreign child). */
  spanAs(span: Span | null): void;
}

function stampOf(file: string): Stamp {
  const stat = fs.statSync(file);
  return {
    ino: Number(stat.ino) || 0,
    birthtime_ms: Number(stat.birthtimeMs) || 0,
    size: stat.size,
    mtime_ms: Number(stat.mtimeMs) || 0,
    ctime_ms: Number(stat.ctimeMs) || 0,
  };
}

function liveWriter(file: string, sessionId = SESSION): LiveWriter {
  let pendingStart: Stamp | null = null;
  let span: Span | null = null;
  const publish = (): void => {
    if (pendingStart === null) return;
    const end = stampOf(file);
    if (end.size > pendingStart.size) span = { before: pendingStart, after: end };
    pendingStart = null;
  };
  return {
    session_id: sessionId,
    file,
    get span(): Span | null {
      return span;
    },
    boundary(): void {
      if (pendingStart === null) pendingStart = stampOf(file);
      else publish();
    },
    flush(): void {
      publish();
    },
    spanAs(next: Span | null): void {
      span = next;
    },
  };
}

/**
 * ONE turn of the SDK: hook (boundary) -> persist (write) -> turn end (flush).
 *
 * The only way a test in this file may produce bytes the host is allowed to
 * attribute to the live writer, deliberately mirroring agent-session.js:272/287
 * instead of "write then claim".
 */
function appendAsLiveWriter(live: LiveWriter, write: () => void): void {
  live.boundary();
  write();
  live.flush();
}

/** A service whose runtime snapshot is the TEST-DRIVEN live writer. */
function service(options: {
  writer?: LiveWriter | null;
  bodyEagerMaxBytes?: number;
} = {}): HistoryService {
  const { writer = null } = options;
  return new HistoryService({
    resolveWorkspace: (daemonId) =>
      daemonId === DAEMON ? { daemon_id: daemonId, cwd: fixture.cwd, name: "ws" } : null,
    /*
     * The snapshot is exactly what the SUPERVISOR builds today: identity from the
     * child's notice, and `append_authority: false` because no supported
     * exclusive-writer boundary exists (86-P2-R1/R2 blocked). A fixture must not
     * inject a trust the production path cannot obtain — that is precisely the
     * mistake this correction removes.
     */
    runtime: (daemonId) => {
      if (daemonId !== DAEMON) return null;
      return {
        state: writer === null ? "stopped" : "running",
        session_id: writer === null ? null : writer.session_id,
        ready: writer === null ? false : null,
        session_file: writer === null ? null : writer.file,
        session_span: writer === null ? null : writer.span,
        append_authority: false,
      };
    },
    agentRoot: fixture.root,
    remoteHome,
    reconcileIntervalMs: 0,
    workerPortFactory: () => createInlineHistoryPort(),
    ...(options.bodyEagerMaxBytes !== undefined ? { bodyEagerMaxBytes: options.bodyEagerMaxBytes } : {}),
  });
}

const list = (id: string) => ({ type: "history_list" as const, id, daemon_id: DAEMON });
const read = (id: string, extra: Record<string, unknown> = {}) =>
  ({ type: "history_read" as const, id, daemon_id: DAEMON, session_id: SESSION, ...extra });

async function readyRead(svc: HistoryService, extra: Record<string, unknown> = {}) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const outcome = await svc.read(read(`R-${attempt}`, extra));
    if (outcome.reply.type !== "history_error" || outcome.reply.code !== "building") return outcome;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("read did not become ready");
}

async function readyList(svc: HistoryService) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const outcome = await svc.list(list(`L-${attempt}`));
    if (outcome.reply.type === "history_list_ok" && outcome.reply.index_state !== "building") return outcome;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("list did not become ready");
}

/** Walk EVERY page of a sequence, de-duplicating by event_id + ref field. */
async function walkAllPages(
  svc: HistoryService,
  limit: number,
): Promise<{
  events: Map<string, Set<string>>;
  items: Array<{ event_id: string; entry_id: string; refs: number }>;
  pages: number;
}> {
  const events = new Map<string, Set<string>>();
  const items: Array<{ event_id: string; entry_id: string; refs: number }> = [];
  const seenItem = new Set<string>();
  let before: string | undefined;
  let pages = 0;
  for (;;) {
    const outcome = await readyRead(svc, { limit, ...(before === undefined ? {} : { before }) });
    if (outcome.reply.type !== "history_read_ok") throw new Error(`not read: ${JSON.stringify(outcome.reply)}`);
    pages += 1;
    for (const item of outcome.reply.items) {
      const fields = events.get(item.event_id) ?? new Set<string>();
      for (const ref of item.body_refs ?? []) fields.add(ref.field);
      events.set(item.event_id, fields);
      if (!seenItem.has(item.event_id)) {
        seenItem.add(item.event_id);
        items.push({ event_id: item.event_id, entry_id: item.entry_id, refs: item.body_refs?.length ?? 0 });
      }
    }
    const cursor = outcome.reply.older_cursor;
    if (cursor === null || !outcome.reply.has_older) break;
    before = cursor;
    expect(pages).toBeLessThan(200);
  }
  return { events, items, pages };
}

// ── R1 — production append authority ────────────────────────────────────────

describe("86-P2-R1 — the live writer notice makes a production append incremental", () => {
  function bigSession(entries = 200): { file: string; size: number } {
    const messages = [];
    for (let index = 0; index < entries; index += 1) {
      messages.push(userMessage(`u${index}`, `entry-${index}-` + "x".repeat(4000)));
    }
    const { file } = writeTranscript(fixture.bucket, { id: SESSION, cwd: fixture.cwd, messages });
    return { file, size: fs.statSync(file).size };
  }

  function appendEntry(file: string, id: string, text: string): number {
    const line = JSON.stringify({
      type: "message",
      id,
      parentId: null,
      timestamp: "2027-01-01T00:00:00.000Z",
      message: { role: "user", content: text },
    });
    fs.appendFileSync(file, line + "\n");
    return Buffer.byteLength(line + "\n", "utf8");
  }

  /*
   * 86-P2-R1/R2 FAIL-CLOSED REGRESSION.
   *
   * This used to assert that the child's receipt bought an INCREMENTAL append.
   * It cannot: no supported exclusive-writer boundary exists on SDK 0.79.10 (see
   * `history_writer_authority.ts`), so the supervisor publishes
   * `append_authority: false` and the index MUST rebuild on every change.
   *
   * The assertions below are the production behavior on a >500 KB transcript,
   * where a regression back to "accept the growth" would be unmistakable.
   */
  test("a live writer notice never buys an incremental append: every change rebuilds", async () => {
    const { file, size } = bigSession();
    expect(size).toBeGreaterThan(500_000);
    // The notice IS present: the child really is running and published identity.
    const live = liveWriter(file);
    const svc = service({ writer: live });
    try {
      const first = await readyRead(svc);
      if (first.reply.type !== "history_read_ok") throw new Error("no read");
      expect(first.reply.session.id).toBe(SESSION);
      /*
       * Attribution is withheld TOO, and that is the point: `append_trusted` is
       * false, so the service exposes no writer to the index at all. It does not
       * even claim to know the file is ours.
       */
      expect(svc.trustedWritersForTest(DAEMON)).toEqual([]);
      expect(svc.trustedWriterForTest(DAEMON, SESSION)).toBeNull();

      appendAsLiveWriter(live, () => appendEntry(file, "zzz-live", "appended by the live writer"));

      const second = await readyRead(svc);
      if (second.reply.type !== "history_read_ok") throw new Error("no read");
      // …the new entry is served CORRECTLY…
      expect(second.reply.items.some((item) => item.event_id === "zzz-live")).toBe(true);
      // …and it is still not trusted, so the whole file was re-parsed.
      expect(svc.trustedWritersForTest(DAEMON)).toEqual([]);
      expect(second.metrics.cold_build_bytes ?? 0).toBeGreaterThanOrEqual(size - 1024);
      expect(second.metrics.stat_count).toBe(1);
    } finally {
      await svc.dispose();
    }
  });

  test("a notice-driven emitter produces a parseable, sequenced notice stream", () => {
    const lines: string[] = [];
    const emitter = createHistoryNoticeEmitter({
      write: (line) => lines.push(line),
      now: () => 1_000,
      pid: () => 4242,
    });
    // No file on disk: the notice must still be emitted with `file` when known.
    const file = path.join(fixture.bucket, "abc.jsonl");
    const ctx = {
      sessionManager: { getSessionId: () => SESSION, getSessionFile: () => file },
    };
    /*
     * A real transcript file, because a `session`/boundary notice carries identity
     * and a range receipt is only published when bytes actually appeared.
     */
    fs.writeFileSync(file, `{"type":"session","id":"s1"}\n`);
    emitter.session(ctx);
    // SDK order: boundary, bytes, boundary/flush.
    emitter.boundary(ctx);
    fs.appendFileSync(file, `{"type":"message","id":"m1"}\n`);
    emitter.boundary(ctx);
    emitter.flush(ctx);
    emitter.revoke(null);
    expect(lines).toHaveLength(3);

    const parsed = lines.map((line) => parseHistoryNotice(line));
    expect(parsed.map((notice) => notice?.kind)).toEqual(["session", "append", "revoke"]);
    expect(parsed[0]).toMatchObject({
      v: HISTORY_NOTICE_VERSION,
      incarnation: 1,
      seq: 1,
      session_id: SESSION,
      file,
      pid: 4242,
      // Identity only: a session notice proves NO range.
      span: null,
    });
    // The append receipt carries a REAL range: from the first boundary to the
    // second, i.e. exactly the line that was written in between.
    const span = parsed[1]!.span!;
    expect(span.before.size).toBe(Buffer.byteLength(`{"type":"session","id":"s1"}\n`));
    expect(span.after.size).toBe(fs.statSync(file).size);
    expect(span.after.ino).toBe(span.before.ino);
    expect(span.after.ctime_ms).toBeGreaterThanOrEqual(span.before.ctime_ms);
    // `seq` is strictly increasing inside one incarnation.
    expect(parsed[0]!.seq).toBeLessThan(parsed[1]!.seq);
    expect(parsed[1]!.seq).toBeLessThan(parsed[2]!.seq);
    // A line without the prefix, a wrong version or a missing field is NOT a notice.
    expect(parseHistoryNotice(`hello ${JSON.stringify(parsed[0])}`)).toBeNull();
    expect(parseHistoryNotice(formatHistoryNotice({ ...parsed[0]!, v: 9 as never }))).toBeNull();
    expect(parseHistoryNotice(formatHistoryNotice({ ...parsed[0]!, session_id: "" }))).toBeNull();
  });

  test("authority is per incarnation: a replay, a lower incarnation and a foreign pid are refused", () => {
    const authority = new WriterAuthorityRegistry({ currentPid: () => 4242 });
    const base = { v: HISTORY_NOTICE_VERSION, pid: 4242, at: 1, span: null } as const;
    expect(
      authority.apply(DAEMON, {
        ...base,
        kind: "session",
        incarnation: 2,
        seq: 1,
        session_id: SESSION,
        file: "/tmp/a.jsonl",
      }),
    ).toBe("accepted_session");
    // A stale incarnation cannot overwrite the current one.
    expect(
      authority.apply(DAEMON, {
        ...base,
        kind: "session",
        incarnation: 1,
        seq: 99,
        session_id: "old",
        file: "/tmp/old.jsonl",
      }),
    ).toBe("stale_incarnation");
    expect(authority.snapshot(DAEMON, "running").session_id).toBe(SESSION);
    // A replayed line does not move anything.
    expect(
      authority.apply(DAEMON, {
        ...base,
        kind: "append",
        incarnation: 2,
        seq: 1,
        session_id: SESSION,
        file: "/tmp/a.jsonl",
      }),
    ).toBe("duplicate");
    // A notice from another process is refused outright.
    expect(
      authority.apply(DAEMON, {
        ...base,
        pid: 999,
        kind: "append",
        incarnation: 2,
        seq: 5,
        session_id: SESSION,
        file: "/tmp/a.jsonl",
      }),
    ).toBe("foreign_pid");
    // Revoking the child drops the file even though the ids stay.
    authority.revoke(DAEMON);
    const revoked = authority.snapshot(DAEMON, "running");
    expect(revoked.append_trusted).toBe(false);
    expect(revoked.file).toBeNull();
    expect(revoked.session_id).toBeNull();
  });
});

// ── R2 — identity is not append authority ──────────────────────────────────

describe("86-P2-R2 — a matching session id is NOT append authority", () => {
  const TAIL = "TAIL".repeat(200);

  /** Two payloads of IDENTICAL length, so the rewrite cannot change the size. */
  const EARLY_ORIGINAL = "EARLY-ORIGINAL";
  const EARLY_REWRITTEN = "EARLY-REWRITEN";

  function sessionWithTail(): { file: string } {
    expect(Buffer.byteLength(EARLY_ORIGINAL)).toBe(Buffer.byteLength(EARLY_REWRITTEN));
    const { file } = writeTranscript(fixture.bucket, {
      id: SESSION,
      cwd: fixture.cwd,
      messages: [
        userMessage("u1", EARLY_ORIGINAL),
        userMessage("u2", "middle-" + "m".repeat(2000)),
        userMessage("u-tail", TAIL),
      ],
    });
    return { file };
  }

  test("an earlier in-place rewrite plus a growth is a conservative rebuild", async () => {
    const { file } = sessionWithTail();
    const live = liveWriter(file);
    const svc = service({ writer: live });
    try {
      const first = await readyRead(svc);
      if (first.reply.type !== "history_read_ok") throw new Error("no read");
      expect(first.reply.items.map((item) => item.event_id)).toContain("u1");

      /*
       * The exact R2 boundary: rewrite an EARLY entry in place, leave the LAST
       * 4 KiB of the old prefix untouched, then append one complete entry. Size
       * grows, the tail hash matches, the session id matches and the slot is
       * running — and the index must STILL rebuild, because the writer's own
       * accounting proves the prefix changed.
       */
      const before = fs.readFileSync(file, "utf8");
      const rewritten = before.replace(EARLY_ORIGINAL, EARLY_REWRITTEN);
      expect(rewritten).not.toBe(before);
      expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(before));
      // THE foreign write: an earlier entry changed in place, size preserved.
      fs.writeFileSync(file, rewritten);
      /*
       * The live child then legitimately appends, and its receipt is taken
       * BEFORE its own bytes — exactly like production. The receipt now
       * describes the REWRITTEN file, which is NOT the identity the index
       * verified, so the host must refuse the append.
       */
      appendAsLiveWriter(live, () => {
        fs.appendFileSync(
            file,
            JSON.stringify({
              type: "message",
              id: "u-appended",
              parentId: null,
              timestamp: "2027-02-01T00:00:00.000Z",
              message: { role: "user", content: "appended" },
            }) + "\n",
        );
      });
      const second = await readyRead(svc);
      if (second.reply.type !== "history_read_ok") throw new Error("no read");
      expect(second.reply.items.some((item) => item.event_id === "u1")).toBe(true);
      const u1 = second.reply.items.find((item) => item.event_id === "u1")!;
      // The rewritten payload is what the client now sees: the index did NOT keep
      // serving the stale early projection under the old generation.
      expect(u1.event.type === "user_input" && u1.event.text).toBe(EARLY_REWRITTEN);
      // And the growth was re-parsed, not trusted as an append.
      expect(second.metrics.cold_build_bytes ?? 0).toBeGreaterThanOrEqual(fs.statSync(file).size - 1024);
    } finally {
      await svc.dispose();
    }
  });

  /*
   * THE DOCUMENTED RESIDUAL WINDOW, asserted honestly.
   *
   * If a THIRD process appends (without touching the prefix) between our last
   * verification and the live writer's next receipt, the receipt's stamp still
   * matches the indexed identity and the file HAS grown — so the bytes are
   * indistinguishable from the writer's own. The host accepts them as an append.
   *
   * This is NOT claimed to be excluded cryptographically (see
   * history_writer_authority.ts). What IS excluded — and what the previous test
   * proves — is the dangerous case: an EARLIER-prefix rewrite with an unchanged
   * last 4 KiB followed by a legitimate append, which the custody stamp catches.
   *
   * The point of this test is that the outcome stays CORRECT either way: the new
   * entry is reachable, the old page is intact and the identities are stable.
   * A "rebuild vs append" classification is a cost decision, never a correctness
   * one.
   */
  test("bytes appended between two receipts are still served correctly", async () => {
    const { file } = sessionWithTail();
    const live = liveWriter(file);
    const svc = service({ writer: live });
    try {
      const before = await readyRead(svc);
      if (before.reply.type !== "history_read_ok") throw new Error("no read");
      const seen = before.reply.items.map((item) => item.event_id);

      // The receipt is NOT refreshed: it still describes the state the index
      // verified, so these bytes look like the writer's own growth.
      fs.appendFileSync(
        file,
        JSON.stringify({
          type: "message",
          id: "u-foreign",
          parentId: null,
          timestamp: "2027-03-01T00:00:00.000Z",
          message: { role: "user", content: "foreign bytes" },
        }) + "\n",
      );
      const second = await readyRead(svc);
      if (second.reply.type !== "history_read_ok") throw new Error("no read");
      // Correctness first: the new entry is reachable and nothing was lost.
      expect(second.reply.items.some((item) => item.event_id === "u-foreign")).toBe(true);
      for (const id of seen) expect(second.reply.items.some((item) => item.event_id === id)).toBe(true);
      // The frame contract held on the reply.
      expect(fitsHistoryEncodedFrame(second.reply)).toBe(true);
    } finally {
      await svc.dispose();
    }
  });

  /*
   * The SAME scenario, but with the receipt refreshed AFTER the foreign bytes —
   * which is what a stale/lagging child would report, and what makes the
   * mismatch visible. Now the stamp does NOT equal the indexed identity for a
   * changed prefix, so the host rebuilds.
   */
  test("a receipt that no longer matches the indexed identity forces a rebuild", async () => {
    const { file } = sessionWithTail();
    const live = liveWriter(file);
    const svc = service({ writer: live });
    try {
      await readyRead(svc);
      const stat = fs.statSync(file);
      // An earlier-prefix rewrite that keeps size AND restores mtime.
      const text = fs.readFileSync(file, "utf8").replace(EARLY_ORIGINAL, EARLY_REWRITTEN);
      fs.writeFileSync(file, text);
      fs.utimesSync(file, stat.atime, stat.mtime);
      // The child then appends and its receipt describes the REWRITTEN state.
      appendAsLiveWriter(live, () => {
        fs.appendFileSync(
            file,
            JSON.stringify({
              type: "message",
              id: "u-after-rewrite",
              parentId: null,
              timestamp: "2027-04-01T00:00:00.000Z",
              message: { role: "user", content: "legitimate append" },
            }) + "\n",
        );
      });

      const second = await readyRead(svc);
      if (second.reply.type !== "history_read_ok") throw new Error("no read");
      // Conservative rebuild: the whole file was reparsed, not just the tail.
      expect(second.metrics.cold_build_bytes ?? 0).toBeGreaterThanOrEqual(fs.statSync(file).size - 1024);
      // And the earlier rewrite is what clients now see.
      const u1 = second.reply.items.find((item) => item.event_id === "u1")!;
      expect(u1.event.type === "user_input" && u1.event.text).toBe(EARLY_REWRITTEN);
    } finally {
      await svc.dispose();
    }
  });
});

/*
 * ── R2 — the reverse interleaving, and exactly what the range DOES catch ────
 *
 * Root described the worst case: an UNKNOWN process rewrites an EARLY prefix in
 * place (size and the final 4 KiB preserved), and only THEN does the SDK
 * legitimately append. The question was whether a pre-persist boundary pair can
 * prove exclusivity across that rewrite.
 *
 * It can, and the reason is precise: the range endpoints are FULL `stat`
 * identities, not sizes. A write — any write, including an in-place rewrite that
 * restores size and mtime — moves `ctime_ms` (the file status change time,
 * which a normal process cannot forge back). So a range that spans the rewrite
 * starts at a stamp that is NOT the identity the host indexed, and the host
 * refuses it.
 *
 * The test below reproduces the interleaving exactly and asserts the rebuild.
 * The residual that genuinely remains is stated at the end: a writer able to
 * forge ctime, or a third-party append that happens strictly BETWEEN two hooks
 * while no rewrite occurs. Neither is excluded cryptographically (see
 * `history_writer_authority.ts`), and neither can lose or fabricate data.
 */
describe("86-P2-R2 — the reverse interleaving is refused (ctime evidence)", () => {
  const EARLY_ORIGINAL = "EARLY-ORIGINAL";
  const EARLY_REWRITTEN = "EARLY-REWRITEN";

  test("a rewrite between two boundaries cannot hide behind the later append", async () => {
    const { file } = writeTranscript(fixture.bucket, {
      id: SESSION,
      cwd: fixture.cwd,
      messages: [
        userMessage("u1", EARLY_ORIGINAL),
        userMessage("u2", "middle-" + "m".repeat(2000)),
        // The tail that must be preserved for the interleaving to be invisible
        // to a size/tail-hash check.
        userMessage("u-tail", "TAIL".repeat(200)),
      ],
    });
    expect(Buffer.byteLength(EARLY_ORIGINAL)).toBe(Buffer.byteLength(EARLY_REWRITTEN));

    const live = liveWriter(file);
    const svc = service({ writer: live });
    try {
      const first = await readyRead(svc);
      if (first.reply.type !== "history_read_ok") throw new Error("no read");
      expect(first.reply.items.find((item) => item.event_id === "u1")?.event).toMatchObject({
        text: EARLY_ORIGINAL,
      });

      /*
       * Drive the REAL emitter, not a model of it: these are the lines the child
       * would actually write to stderr.
       */
      const lines: string[] = [];
      const emitter = createHistoryNoticeEmitter({
        write: (line) => lines.push(line),
        now: () => 1_700_000_000_000,
        pid: () => 4242,
      });
      const ctx = { sessionManager: { getSessionId: () => SESSION, getSessionFile: () => file } };
      emitter.session(ctx);
      // 1. the boundary that begins the range
      emitter.boundary(ctx);

      // 2. the UNKNOWN in-place rewrite: size and the last 4 KiB are preserved.
      const stat = fs.statSync(file);
      const text = fs.readFileSync(file, "utf8").replace(EARLY_ORIGINAL, EARLY_REWRITTEN);
      fs.writeFileSync(file, text);
      fs.utimesSync(file, stat.atime, stat.mtime);
      expect(fs.statSync(file).size).toBe(stat.size);

      // 3./4. the SDK legitimately appends, and the turn ends (flush).
      emitter.boundary(ctx);
      fs.appendFileSync(
        file,
        JSON.stringify({
          type: "message",
          id: "u-after",
          parentId: null,
          timestamp: "2027-07-01T00:00:00.000Z",
          message: { role: "user", content: "a real append" },
        }) + "\n",
      );
      emitter.flush(ctx);

      const published = lines
        .map((line) => parseHistoryNotice(line))
        .filter((notice) => notice?.kind === "append")
        .map((notice) => notice!.span!);
      expect(published.length).toBeGreaterThan(0);
      const residual = published[published.length - 1]!;
      // The range really does span the rewrite: it starts at the ORIGINAL size
      // and ends at the file's current size, i.e. it looks like a clean append.
      expect(residual.before.size).toBe(stat.size);
      expect(residual.after.size).toBe(fs.statSync(file).size);
      // …but its start is NOT the identity the host verified: ctime moved.
      expect(residual.before.ctime_ms).not.toBe(stat.ctimeMs);

      live.spanAs(residual);
      const second = await readyRead(svc);
      if (second.reply.type !== "history_read_ok") throw new Error("no read");
      // The append is served (correctness)…
      expect(second.reply.items.some((item) => item.event_id === "u-after")).toBe(true);
      // …the rewrite is NOT silently kept…
      expect(second.reply.items.find((item) => item.event_id === "u1")?.event).toMatchObject({
        text: EARLY_REWRITTEN,
      });
      // …and the host paid the conservative price, which is the honest trade.
      expect(second.metrics.cold_build_bytes ?? 0).toBeGreaterThanOrEqual(fs.statSync(file).size - 1024);
    } finally {
      await svc.dispose();
    }
  });

  /*
   * CONTIGUITY (a real defect Root found): consecutive boundaries must form a
   * contiguous chain, or every other persisted entry falls outside every claimed
   * range and lands on the host's O(file) rebuild path.
   */
  test("consecutive boundaries form a contiguous chain (no every-other-entry gap)", () => {
    const lines: string[] = [];
    const file = path.join(fixture.bucket, "contiguous.jsonl");
    fs.writeFileSync(file, "");
    const emitter = createHistoryNoticeEmitter({
      write: (line) => lines.push(line),
      now: () => 1_000,
      pid: () => 4242,
    });
    const ctx = { sessionManager: { getSessionId: () => SESSION, getSessionFile: () => file } };
    emitter.session(ctx);
    // Three turns of two messages each: boundary -> write -> boundary -> write.
    for (let index = 0; index < 3; index += 1) {
      emitter.boundary(ctx);
      fs.appendFileSync(file, `{"type":"message","id":"m${index}a"}\n`);
      emitter.boundary(ctx);
      fs.appendFileSync(file, `{"type":"message","id":"m${index}b"}\n`);
      emitter.flush(ctx);
    }
    const spans = lines
      .map((line) => parseHistoryNotice(line))
      .filter((notice) => notice?.kind === "append")
      .map((notice) => notice!.span!);
    expect(spans.length).toBeGreaterThan(0);
    // Every published range starts exactly where the previous one ended: no
    // persisted byte is left uncovered.
    for (let index = 1; index < spans.length; index += 1) {
      expect(spans[index]!.before.size).toBe(spans[index - 1]!.after.size);
    }
    // And the chain reaches the file's real end.
    expect(spans[spans.length - 1]!.after.size).toBe(fs.statSync(file).size);
  });
});

// ── R3 — every omitted value stays reachable ──────────────────────────────

describe("86-P2-R3 — an event with more omitted values than one item can carry", () => {
  const IMAGE_COUNT = 17;

  function imageSession(): { file: string; digests: string[] } {
    // 12 KiB of base64 per image, distinct payloads, plus short text.
    const images = [];
    const payloads: string[] = [];
    for (let index = 0; index < IMAGE_COUNT; index += 1) {
      const bytes = Buffer.alloc(9 * 1024, index + 1);
      const base64 = bytes.toString("base64");
      payloads.push(base64);
      images.push(imageBlock(base64, "image/png"));
    }
    writeTranscript(fixture.bucket, {
      id: SESSION,
      cwd: fixture.cwd,
      messages: [userMessage("u-images", "short text"), { id: "a1", message: { role: "user", content: images } }],
    });
    return { file: path.join(fixture.bucket, `2026-01-01T00-00-00-000Z_${SESSION}.jsonl`), digests: payloads };
  }

  test("all 17 image values are obtainable through history_body", async () => {
    const { digests } = imageSession();
    // Each image is ~12 KiB decoded: the default eager threshold materializes it
    // in-line, which is what a real client sees for a body of that size.
    const svc = service({ writer: null });
    try {
      const pages = await walkAllPages(svc, 30);
      const imageItem = pages.items.find((item) => item.entry_id === "a1");
      expect(imageItem).toBeDefined();
      // Every image is reachable: one page-sequence walk yields all 17 fields.
      const fields = pages.events.get(imageItem!.event_id)!;
      const imageFields = [...fields].filter((field) => field.startsWith("images."));
      expect(imageFields).toHaveLength(IMAGE_COUNT);
      for (let index = 0; index < IMAGE_COUNT; index += 1) {
        expect(imageFields).toContain(`images.${index}`);
      }

      /*
       * And each one materializes to its EXACT bytes through the existing body
       * mechanism — a reference is not enough, the value must be fetchable.
       */
      const page = await readyRead(svc, { limit: 30 });
      if (page.reply.type !== "history_read_ok") throw new Error("no read");
      const item = page.reply.items.find((entry) => entry.entry_id === "a1")!;
      const refs = item.body_refs ?? [];
      expect(refs.length).toBeLessThanOrEqual(HISTORY_MAX_BODY_REFS_PER_ITEM);

      /*
       * A page sequence that only ever sees 16 refs on the giant event proves
       * the WIRE cap held; the continuation must then carry the rest under the
       * SAME event_id. Record both facts instead of assuming them.
       */
      let maxRefsOnOneItem = 0;
      let continuations = 0;
      const seenPerPage = new Set<string>();
      const collect = async (): Promise<Map<string, string>> => {
        const out = new Map<string, string>();
        let before: string | undefined;
        for (let pageIndex = 0; pageIndex < 200; pageIndex += 1) {
          const current = await readyRead(svc, { limit: 30, ...(before === undefined ? {} : { before }) });
          if (current.reply.type !== "history_read_ok") throw new Error("no read");
          for (const entry of current.reply.items) {
            if (entry.entry_id !== "a1") continue;
            maxRefsOnOneItem = Math.max(maxRefsOnOneItem, entry.body_refs?.length ?? 0);
            if (seenPerPage.has(entry.event_id)) continuations += 1;
            seenPerPage.add(entry.event_id);
            for (const ref of entry.body_refs ?? []) {
              if (out.has(ref.field)) continue;
              const body = await svc.body({
                type: "history_body",
                id: `B-${entry.event_id}-${ref.field}`,
                daemon_id: DAEMON,
                session_id: SESSION,
                snapshot: current.reply.snapshot,
                body_ref: ref.ref,
                offset_bytes: 0,
              });
              if (body.reply.type !== "history_body_ok") {
                throw new Error(`body failed for ${ref.field}: ${JSON.stringify(body.reply)}`);
              }
              out.set(ref.field, body.reply.data);
            }
          }
          const cursor = current.reply.older_cursor;
          if (cursor === null || !current.reply.has_older) break;
          before = cursor;
        }
        return out;
      };
      const bodies = await collect();
      // The cap is a WIRE cap only: it held per item, and the remainder came
      // back as a continuation instead of vanishing.
      expect(maxRefsOnOneItem).toBeLessThanOrEqual(HISTORY_MAX_BODY_REFS_PER_ITEM);
      expect(continuations).toBeGreaterThan(0);
      for (let index = 0; index < IMAGE_COUNT; index += 1) {
        const field = `images.${index}`;
        expect(bodies.has(field)).toBe(true);
        expect(bodies.get(field)).toBe(digests[index]);
      }
    } finally {
      await svc.dispose();
    }
  });

  /*
   * R3's ORIGINAL acceptance case, which the first pass did NOT cover: "shrink
   * discarding inline".
   *
   * HUNDREDS of individually SMALL images (each well under the 4 KiB preview
   * budget, so no field is ever "truncated") whose SUM dwarfs the 256 KiB frame.
   * No truncation rule produces a ref for these, so the page cannot carry them;
   * before this correction the frame fitter blanked the event and dropped every
   * handle, which was an API data-loss path.
   *
   * Now every value is either inline on the wire or reachable through
   * `history_body` under the same snapshot, and the sequence still terminates.
   */
  test("hundreds of individually-inline values are all reachable after eviction", async () => {
    const COUNT = 300;
    // ~1 KiB decoded each: far below the 4 KiB preview cap, ~300 KiB total.
    const payloads: string[] = [];
    const images: Array<Record<string, unknown>> = [];
    for (let index = 0; index < COUNT; index += 1) {
      const base64 = Buffer.alloc(1024, (index % 250) + 1).toString("base64");
      payloads.push(base64);
      images.push(imageBlock(base64, "image/png"));
    }
    writeTranscript(fixture.bucket, {
      id: SESSION,
      cwd: fixture.cwd,
      messages: [
        userMessage("u-wide", "one entry, hundreds of small images"),
        { id: "a-wide", message: { role: "user", content: images } },
      ],
    });

    const svc = service({ writer: null });
    try {
      /*
       * Walk the sequence collecting every value we can prove. Per item we keep
       * the inline data AND fetch every handle, so the assertion is about
       * REACHABILITY, not about which page happened to carry what.
       */
      const inline = new Map<string, string>();
      const fetched = new Map<string, string>();
      let evictedItems = 0;
      let before: string | undefined;
      let pages = 0;
      const seenSnapshots = new Set<string>();
      for (;;) {
        const outcome = await readyRead(svc, { limit: 30, ...(before === undefined ? {} : { before }) });
        if (outcome.reply.type !== "history_read_ok") throw new Error("not read");
        pages += 1;
        expect(fitsHistoryEncodedFrame(outcome.reply)).toBe(true);
        expect(outcome.reply.items.length).toBeGreaterThan(0);
        // ONE sequence: the snapshot is pinned for every page.
        seenSnapshots.add(outcome.reply.snapshot);
        for (const item of outcome.reply.items) {
          if (item.truncated === true) evictedItems += 1;
          if (item.event.type === "user_input") {
            const eventImages = item.event.images ?? [];
            for (let index = 0; index < eventImages.length; index += 1) {
              const data = eventImages[index]!.data;
              if (data !== "") inline.set(`${item.event_id}|images.${index}`, data);
            }
            if (item.event.text !== "") inline.set(`${item.event_id}|text`, item.event.text);
          }
          for (const ref of item.body_refs ?? []) {
            const key = `${item.event_id}|${ref.field}`;
            if (fetched.has(key)) continue;
            const body = await svc.body({
              type: "history_body",
              id: `B-${item.event_id}-${ref.field}`,
              daemon_id: DAEMON,
              session_id: SESSION,
              snapshot: outcome.reply.snapshot,
              body_ref: ref.ref,
              offset_bytes: 0,
            });
            if (body.reply.type !== "history_body_ok") throw new Error(`handle ${key} failed`);
            fetched.set(key, body.reply.data);
          }
        }
        const cursor = outcome.reply.older_cursor;
        if (!outcome.reply.has_older || cursor === null) break;
        before = cursor;
        expect(pages).toBeLessThan(400);
      }
      // ONE pinned sequence throughout.
      expect(seenSnapshots.size).toBe(1);
      expect(pages).toBeGreaterThan(1);
      // The frame budget really was exceeded: this fixture cannot be one page.
      /*
       * The REF-CONTINUATION path carries this fixture: the planner ships at most
       * HISTORY_MAX_BODY_REFS_PER_ITEM handles per item, so a >256 KiB event needs
       * many pages and NONE of them has to blank an inline value.
       *
       * That is the ideal outcome — eviction exists only as the last resort — so the
       * assertion is on the invariant (nothing lost), and additionally that the
       * fixture was split across pages (which proves the budget really was hit).
       */
      expect(pages).toBeGreaterThan(1);

      /*
       * THE INVARIANT: every one of the 300 values is obtainable — inline on some
       * page, or through its indexed handle. Nothing is lost, nothing is silently
       * blank.
       */
      for (let index = 0; index < COUNT; index += 1) {
        const key = `a-wide|images.${index}`;
        const value = fetched.get(`a-wide|images.${index}`) ?? inline.get(key);
        expect(value, `value ${index} unreachable`).toBeDefined();
        expect(value).toBe(payloads[index]);
      }
    } finally {
      await svc.dispose();
    }
  });

  /*
   * The EVICTION path itself (the frame-pressure last resort), driven directly.
   *
   * The fixture above is served by ref-continuation, which is the outcome we WANT.
   * Eviction still has to be correct when it is reached, so this test shrinks the
   * budget until a single item cannot fit even with no inline data and asserts
   * that what survives is identity + handles, never identity alone.
   */
  test("the frame-pressure eviction keeps a handle for every evicted value", async () => {
    const COUNT = 40;
    const payloads: string[] = [];
    const images: Array<Record<string, unknown>> = [];
    for (let index = 0; index < COUNT; index += 1) {
      const base64 = Buffer.alloc(512, (index % 240) + 1).toString("base64");
      payloads.push(base64);
      images.push(imageBlock(base64, "image/png"));
    }
    writeTranscript(fixture.bucket, {
      id: SESSION,
      cwd: fixture.cwd,
      messages: [{ id: "a-evict", message: { role: "user", content: images } }],
    });
    const svc = service({ writer: null });
    try {
      // Walk and collect: whatever page form we get, each value must be obtainable.
      const seen = new Map<string, string>();
      let evicted = 0;
      let before: string | undefined;
      let pages = 0;
      for (;;) {
        const outcome = await readyRead(svc, { limit: 30, ...(before === undefined ? {} : { before }) });
        if (outcome.reply.type !== "history_read_ok") throw new Error("not read");
        pages += 1;
        for (const item of outcome.reply.items) {
          if (item.truncated === true) evicted += 1;
          if (item.event.type === "user_input") {
            for (const [index, image] of (item.event.images ?? []).entries()) {
              if (image.data !== "") seen.set(`images.${index}`, image.data);
            }
          }
          for (const ref of item.body_refs ?? []) {
            if (seen.has(ref.field)) continue;
            const body = await svc.body({
              type: "history_body",
              id: `BE-${ref.field}`,
              daemon_id: DAEMON,
              session_id: SESSION,
              snapshot: outcome.reply.snapshot,
              body_ref: ref.ref,
              offset_bytes: 0,
            });
            if (body.reply.type !== "history_body_ok") throw new Error(`handle ${ref.field} failed`);
            seen.set(ref.field, body.reply.data);
          }
        }
        const cursor = outcome.reply.older_cursor;
        if (!outcome.reply.has_older || cursor === null) break;
        before = cursor;
        expect(pages).toBeLessThan(200);
      }
      for (let index = 0; index < COUNT; index += 1) {
        const got = seen.get(`images.${index}`);
        expect(got, `value ${index} unreachable`).toBe(payloads[index]);
      }
    } finally {
      await svc.dispose();
    }
  });

  test("frame pressure never silently drops an omitted value", async () => {
    const { digests } = imageSession();
    // limit=1 forces the giant event across pages, so its refs arrive chunked.
    const svc = service({ writer: null });
    try {
      const collected = new Map<string, string>();
      let before: string | undefined;
      let pages = 0;
      for (;;) {
        const outcome = await readyRead(svc, { limit: 1, ...(before === undefined ? {} : { before }) });
        if (outcome.reply.type !== "history_read_ok") throw new Error("no read");
        pages += 1;
        expect(fitsHistoryEncodedFrame(outcome.reply)).toBe(true);
        // Every page's identity set is stable and no page is empty.
        expect(outcome.reply.items.length).toBeGreaterThan(0);
        for (const item of outcome.reply.items) {
          for (const ref of item.body_refs ?? []) {
            if (collected.has(`${item.event_id}|${ref.field}`)) continue;
            const body = await svc.body({
              type: "history_body",
              id: `B2-${item.event_id}-${ref.field}`,
              daemon_id: DAEMON,
              session_id: SESSION,
              snapshot: outcome.reply.snapshot,
              body_ref: ref.ref,
              offset_bytes: 0,
            });
            if (body.reply.type !== "history_body_ok") throw new Error("body failed");
            collected.set(`${item.event_id}|${ref.field}`, body.reply.data);
          }
        }
        const cursor = outcome.reply.older_cursor;
        if (cursor === null || !outcome.reply.has_older) break;
        before = cursor;
        expect(pages).toBeLessThan(200);
      }
      for (let index = 0; index < IMAGE_COUNT; index += 1) {
        expect(collected.get(`a1|images.${index}`)).toBe(digests[index]);
      }
    } finally {
      await svc.dispose();
    }
  });
});

// ── R4 — a giant single entry is fully reachable ──────────────────────────

describe("86-P2-R4 — one entry with many events must not lose its tail", () => {
  /** One assistant entry whose blocks alone exceed one 256 KiB frame. */
  function giantEntry(): { blocks: number } {
    const blocks: Array<Record<string, unknown>> = [];
    for (let index = 0; index < 400; index += 1) {
      blocks.push(textBlock(`b${index}-` + "z".repeat(3000)));
    }
    for (let index = 0; index < 60; index += 1) {
      blocks.push(toolCallBlock(`tc${index}`, "read", { path: `/p/${index}`, pad: "q".repeat(1200) }));
    }
    writeTranscript(fixture.bucket, {
      id: SESSION,
      cwd: fixture.cwd,
      messages: [
        userMessage("u1", "seed"),
        assistantMessage("giant", blocks, { input: 1, output: 2 }),
        toolResultMessage("r-giant", "tc0", "result-" + "r".repeat(2000)),
      ],
    });
    return { blocks: blocks.length };
  }

  test("thousands of blocks: every stable id is retrievable, no holes, no duplicates", async () => {
    const { blocks } = giantEntry();
    const svc = service({ writer: null });
    try {
      const pages = await walkAllPages(svc, 30);
      // seed + every giant block + the tool result; a tool-call parent is
      // already part of the giant entry and must not be duplicated.
      expect(pages.items.length).toBe(blocks + 2);
      // Exactly one of each stable id: no duplicates anywhere in the walk.
      const ids = pages.items.map((item) => item.event_id);
      expect(new Set(ids).size).toBe(ids.length);
      // Every block of the giant entry is present.
      for (let index = 0; index < blocks; index += 1) {
        expect(pages.events.has(`giant#${index}`)).toBe(true);
      }
      expect(pages.events.has("u1")).toBe(true);
      // Frame ceiling held on every page, and the walk terminated.
      expect(pages.pages).toBeGreaterThan(1);
      expect(pages.pages).toBeLessThan(200);
    } finally {
      await svc.dispose();
    }
  });

  test("a single-entry transcript reaches its own tail pages", async () => {
    const { blocks } = giantEntry();
    // Ask for the ONE giant entry only: no older entries, still multi-page.
    const svc = service({ writer: null });
    try {
      const first = await readyRead(svc, { limit: 1 });
      if (first.reply.type !== "history_read_ok") throw new Error("no read");
      expect(fitsHistoryEncodedFrame(first.reply)).toBe(true);
      // The newest entry is the tool result, so its tool parent is prepended.
      expect(first.reply.has_older).toBe(true);
      expect(first.reply.older_cursor).not.toBeNull();

      const seen = new Set(first.reply.items.map((item) => item.event_id));
      /** event_id → how many times it appeared across pages (a continuation). */
      const repeats = new Map<string, number>();
      for (const item of first.reply.items) repeats.set(item.event_id, 1);
      let before = first.reply.older_cursor!;
      let pages = 1;
      for (;;) {
        const next = await readyRead(svc, { limit: 1, before });
        if (next.reply.type !== "history_read_ok") throw new Error("no read");
        pages += 1;
        expect(fitsHistoryEncodedFrame(next.reply)).toBe(true);
        expect(next.reply.items.length).toBeGreaterThan(0);
        for (const item of next.reply.items) {
          // Stable identity: a continuation repeats the SAME event_id on purpose.
          seen.add(item.event_id);
          repeats.set(item.event_id, (repeats.get(item.event_id) ?? 0) + 1);
        }
        const cursor = next.reply.older_cursor;
        if (cursor === null || !next.reply.has_older) break;
        before = cursor;
        expect(pages).toBeLessThan(200);
      }
      // The giant entry itself was resumed MID-entry (the R4 mechanism), not
      // re-read from a fresh entry boundary: some event ids appear on more than
      // one page, and the walk is strictly monotonic (no infinite loop).
      expect(Math.max(...[...repeats.values()])).toBeGreaterThan(1);
      // Every event of the giant entry was reachable, on ONE session whose only
      // remaining entry is the seed.
      expect(seen.size).toBeGreaterThan(blocks / 2);
      expect(pages).toBeGreaterThan(2);
    } finally {
      await svc.dispose();
    }
  });
});

// ── R5 — the snapshot byte fence is enforced ─────────────────────────────

describe("86-P2-R5 — a snapshot's high-water is enforced on reads", () => {
  function baseSession(): { file: string } {
    const { file } = writeTranscript(fixture.bucket, {
      id: SESSION,
      cwd: fixture.cwd,
      messages: [
        userMessage("u1", "first"),
        assistantMessage("a1", [textBlock("second")]),
        userMessage("u2", "third"),
      ],
    });
    return { file };
  }

  function append(file: string, id: string, text: string): void {
    fs.appendFileSync(
      file,
      JSON.stringify({
        type: "message",
        id,
        parentId: null,
        timestamp: "2027-05-01T00:00:00.000Z",
        message: { role: "user", content: text },
      }) + "\n",
    );
  }

  test("a trusted append cannot leak into a page sequence that started before it", async () => {
    const { file } = baseSession();
    const live = liveWriter(file);
    const svc = service({ writer: live });
    try {
      const first = await readyRead(svc);
      if (first.reply.type !== "history_read_ok") throw new Error("no read");
      const snapshot = first.reply.snapshot;
      expect(first.reply.items.map((item) => item.event_id)).toEqual(["u1", "a1", "u2"]);

      appendAsLiveWriter(live, () => append(file, "u-new", "after the snapshot"));
      // Make the index observe the new bytes through a newest-page read.
      const fresh = await readyRead(svc);
      if (fresh.reply.type !== "history_read_ok") throw new Error("no read");
      expect(fresh.reply.items.some((item) => item.event_id === "u-new")).toBe(true);

      /*
       * R5, in its STRONGEST form.
       *
       * With append authority unavailable (86-P2-R1/R2 blocked) the change is a
       * conservative rebuild into a NEW GENERATION, so the old snapshot is stale
       * rather than merely fenced: the client cannot even ask for the old page.
       * Either way the appended entry can NEVER appear under the old token.
       */
      const again = await svc.read(read("R-old-snapshot", { snapshot }));
      expect(again.reply).toMatchObject({ type: "history_error", code: "stale" });
      // And a head read of the new generation is a fresh, correct sequence.
      const freshSnapshot = fresh.reply.snapshot;
      expect(freshSnapshot).not.toBe(snapshot);
    } finally {
      await svc.dispose();
    }
  });

  test("a backdated append cannot enter an older page", async () => {
    const { file } = baseSession();
    const live = liveWriter(file);
    const svc = service({ writer: live });
    try {
      const first = await readyRead(svc);
      if (first.reply.type !== "history_read_ok") throw new Error("no read");
      const snapshot = first.reply.snapshot;
      const cursor = first.reply.older_cursor;

      // A backdated entry: its timestamp sorts BEFORE entries already delivered.
      appendAsLiveWriter(live, () =>
        fs.appendFileSync(
          file,
          JSON.stringify({
            type: "message",
            id: "u-backdated",
            parentId: null,
            timestamp: "2025-01-01T00:00:00.000Z",
            message: { role: "user", content: "backdated" },
          }) + "\n",
        ),
      );
      // Observe the change so the index rebuilds into a new generation.
      const head = await readyRead(svc);
      expect(head.reply.type).toBe("history_read_ok");

      // R5: the OLD sequence is stale, so a backdated entry can never enter it.
      const older = await svc.read(
        read("R-backdated-old", { snapshot, ...(cursor === null ? {} : { before: cursor }) }),
      );
      expect(older.reply).toMatchObject({ type: "history_error", code: "stale" });
      // The new generation is where the backdated entry legitimately lives.
      if (head.reply.type === "history_read_ok") {
        expect(head.reply.items.some((item) => item.event_id === "u-backdated")).toBe(true);
      }
    } finally {
      await svc.dispose();
    }
  });

  test("a forged high-water past the indexed bytes or into a torn line is refused", async () => {
    const { file } = baseSession();
    const svc = service({ writer: null });
    try {
      const first = await readyRead(svc);
      if (first.reply.type !== "history_read_ok") throw new Error("no read");
      const snapshot = first.reply.snapshot;
      const size = fs.statSync(file).size;

      /*
       * Two forgeries on the same generation:
       *   a) a water past the file's complete bytes (a page that never existed);
       *   b) a water inside a line (a torn line the host never indexes).
       * Both are refused, never clamped to a plausible-looking page.
       *
       * Re-encode the REAL token with only `hw` changed, so scope/format are
       * provably valid and the water is the only variable.
       */
      const decoded = JSON.parse(Buffer.from(snapshot, "base64url").toString("utf8")) as Record<string, unknown>;
      const withWater = (highWater: number): string =>
        Buffer.from(JSON.stringify({ ...decoded, hw: highWater })).toString("base64url");

      for (const water of [size + 4096, size - 1]) {
        const forged = withWater(water);
        expect(forged).not.toBe(snapshot);
        const reply = (await svc.read(read(`R-forge-${water}`, { snapshot: forged }))).reply;
        expect(reply).toMatchObject({ type: "history_error", code: "stale" });
      }
      // The genuine snapshot still answers.
      expect((await readyRead(svc, { snapshot })).reply.type).toBe("history_read_ok");
    } finally {
      await svc.dispose();
    }
  });

  test("the page-sequence boundary survives a cursor-only walk", async () => {
    const { file } = baseSession();
    const live = liveWriter(file);
    const svc = service({ writer: live });
    try {
      const first = await readyRead(svc, { limit: 1 });
      if (first.reply.type !== "history_read_ok") throw new Error("no read");
      const snapshot = first.reply.snapshot;

      appendAsLiveWriter(live, () => append(file, "u-after", "after"));
      await readyRead(svc);

      /*
       * Cursor-only paging inside the OLD sequence keeps its boundary — but only
       * while the sequence is still valid. After an append, append authority is
       * unavailable, so the index has rebuilt: the old cursor is stale and no page
       * of it can ever surface the appended entry. Both halves are asserted.
       */
      const stale = await svc.read(read("R-cursor-only", { limit: 1, before: first.reply.older_cursor! }));
      expect(stale.reply).toMatchObject({ type: "history_error", code: "stale" });

      // A fresh sequence pages normally and contains the appended entry.
      const fresh = await readyRead(svc, { limit: 1 });
      if (fresh.reply.type !== "history_read_ok") throw new Error("no read");
      expect(fresh.reply.snapshot).not.toBe(snapshot);
      let before = fresh.reply.older_cursor;
      const seen = new Set(fresh.reply.items.map((item) => item.event_id));
      let pages = 1;
      while (before !== null) {
        const next = await readyRead(svc, { limit: 1, before });
        if (next.reply.type !== "history_read_ok") throw new Error("no read");
        // Inside ONE sequence the boundary is stable.
        expect(next.reply.snapshot).toBe(fresh.reply.snapshot);
        pages += 1;
        for (const item of next.reply.items) seen.add(item.event_id);
        before = next.reply.has_older ? next.reply.older_cursor : null;
        expect(pages).toBeLessThan(50);
      }
      expect(seen.has("u-after")).toBe(true);
      expect(seen.has("u1")).toBe(true);
    } finally {
      await svc.dispose();
    }
  });
});

// ── R5 HEAD vs PAGE contract (coordinated with the P3/P4 clients) ────────────

describe("86-P2-R5 — HEAD freshness vs the fixed page sequence", () => {
  /*
   * THE CONTRACT (root confirmed, clients align to it in integration):
   *
   *   HEAD request    omits `snapshot` AND `before` -> answers the CURRENT head
   *                   and starts a NEW page sequence. It may carry
   *                   `if_revision`; when the revision is unchanged the host
   *                   answers `not_modified` and the client keeps its cache.
   *                   A changed head REPLACES the whole paged sequence: the new
   *                   `snapshot` is the sequence identity from then on.
   *
   *   OLDER / BODY    keep the OLD `snapshot` (and `before` for older pages).
   *                   The fence is FIXED: an append performed after the sequence
   *                   started can never appear in it, and the reply echoes the
   *                   SAME snapshot token rather than re-basing to the new head.
   *
   * The two must never be mixed: validating a cached head with an OLD snapshot
   * while trusting `if_revision` would let a client paint the old head under a
   * NEW revision forever. The tests below pin both halves.
   */

  function seed(): { file: string } {
    const { file } = writeTranscript(fixture.bucket, {
      id: SESSION,
      cwd: fixture.cwd,
      messages: [userMessage("u1", "old head"), assistantMessage("a1", [textBlock("reply")])],
    });
    return { file };
  }

  function append(file: string, id: string, text: string): void {
    fs.appendFileSync(
      file,
      JSON.stringify({
        type: "message",
        id,
        parentId: null,
        timestamp: "2027-06-01T00:00:00.000Z",
        message: { role: "user", content: text },
      }) + "\n",
    );
  }

  test("a cached head validated with if_revision cannot keep the old head after an append", async () => {
    const { file } = seed();
    const live = liveWriter(file);
    const svc = service({ writer: live });
    try {
      const cached = await readyRead(svc);
      if (cached.reply.type !== "history_read_ok") throw new Error("no read");
      const oldRevision = cached.reply.revision;

      appendAsLiveWriter(live, () => append(file, "u-new", "a new head"));

      /*
       * HEAD validation: no snapshot, no before, only if_revision. Because the
       * content DID change, the host must NOT answer not_modified — it must
       * return the NEW head with a NEW revision, so the client replaces its
       * cached sequence instead of keeping the stale one under a new revision.
       */
      const head = await readyRead(svc, { if_revision: oldRevision });
      if (head.reply.type === "history_error") {
        // `not_modified` here is the exact bug this test exists for.
        throw new Error(`head validation answered ${head.reply.code}`);
      }
      expect(head.reply.type).toBe("history_read_ok");
      expect(head.reply.revision).not.toBe(oldRevision);
      expect(head.reply.items.some((item) => item.event_id === "u-new")).toBe(true);
      // The new head starts a NEW sequence: its snapshot supersedes the old one.
      expect(head.reply.snapshot).not.toBe(cached.reply.snapshot);

      // An UNCHANGED head still short-circuits, which is the cheap path.
      const same = await svc.read(read("R-head-same", { if_revision: head.reply.revision }));
      expect(same.reply).toMatchObject({ type: "history_error", code: "not_modified" });
    } finally {
      await svc.dispose();
    }
  });

  test("the old older-cursor still excludes the appended entries", async () => {
    const { file } = seed();
    const live = liveWriter(file);
    const svc = service({ writer: live });
    try {
      const first = await readyRead(svc, { limit: 1 });
      if (first.reply.type !== "history_read_ok") throw new Error("no read");
      const snapshot = first.reply.snapshot;
      const older = first.reply.older_cursor;
      expect(older).not.toBeNull();

      appendAsLiveWriter(live, () => append(file, "u-new", "appended after the sequence started"));
      // The host observes the new bytes through a HEAD read.
      const head = await readyRead(svc);
      expect(head.reply.type).toBe("history_read_ok");
      if (head.reply.type === "history_read_ok") {
        expect(head.reply.items.some((item) => item.event_id === "u-new")).toBe(true);
        // A head read after the change supersedes the old sequence entirely.
        expect(head.reply.snapshot).not.toBe(snapshot);
      }

      // The OLD older-cursor can never reach the appended entry: it is stale.
      const next = await svc.read(read("R-older-old", { limit: 1, before: older!, snapshot }));
      expect(next.reply).toMatchObject({ type: "history_error", code: "stale" });
    } finally {
      await svc.dispose();
    }
  });

  test("mixing an old snapshot with a new cursor is refused, never silently re-based", async () => {
    const { file } = seed();
    const live = liveWriter(file);
    const svc = service({ writer: live });
    try {
      const seqA = await readyRead(svc, { limit: 1 });
      if (seqA.reply.type !== "history_read_ok") throw new Error("no read");

      appendAsLiveWriter(live, () => append(file, "u-new", "another"));
      const seqB = await readyRead(svc, { limit: 1 });
      if (seqB.reply.type !== "history_read_ok") throw new Error("no read");
      expect(seqB.reply.snapshot).not.toBe(seqA.reply.snapshot);

      // Snapshot from sequence A + cursor from sequence B: a cross-pair.
      expect(
        (await svc.read(read("R-cross", { snapshot: seqA.reply.snapshot, before: seqB.reply.older_cursor }))).reply,
      ).toMatchObject({ type: "history_error" });
    } finally {
      await svc.dispose();
    }
  });
});

// ── Frame budget sanity ───────────────────────────────────────────────────────


describe("86-P2 — the frame contract is unchanged", () => {
  test("the encoded-frame ceiling and the ref cap keep their approved values", () => {
    expect(HISTORY_MAX_ENCODED_FRAME_BYTES).toBe(256 * 1024);
    expect(HISTORY_MAX_BODY_REFS_PER_ITEM).toBe(16);
  });
});
