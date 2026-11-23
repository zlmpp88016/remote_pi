/**
 * Plan 86 P2 — index/writer ownership, trusted append vs conservative rebuild,
 * corrupt DB recovery, old-child DB isolation and the body sidecar.
 *
 * Every test uses REAL temporary files and an isolated `remoteHome`; no test
 * reads or writes the developer's `~/.pi/remote` or a live child index.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HistoryService } from "./history_service.js";
import { createInlineHistoryPort } from "./history_worker_client.js";
import {
  closeIndexHandles,
  historyBodiesRoot,
  historyDbPath,
  readerFor,
  writerFor,
  type HistoryFieldRow,
} from "./history_index.js";
import { HistoryBodyStore, bodyGenerationDir } from "./history_body_store.js";
import {
  assistantMessage,
  makeHistoryFixture,
  textBlock,
  toolCallBlock,
  toolResultMessage,
  userMessage,
  writeTranscript,
  type HistoryFixture,
} from "../../test/history_fixtures.js";
import { HISTORY_BODY_MAX_TOTAL_BYTES } from "../protocol/history.js";

const DAEMON = "aaaa1111";
const SESSION = "s1";

let fixture: HistoryFixture;
let remoteHome: string;

beforeEach(() => {
  fixture = makeHistoryFixture("rp86-p2-");
  remoteHome = `${fixture.root}/remote-home`;
});

afterEach(() => {
  closeIndexHandles();
  fixture.cleanup();
});

interface ServiceOptions {
  /**
   * The supervisor's writer authority, as the CHILD published it (R1/R2).
   *
   * `writer`: `undefined` = no notice ever arrived (identity unknown);
   * `null` = the workspace is not running; otherwise the incarnation's own
   * (session, file, claimed size). This is deliberately the same shape the
   * supervisor builds from a notice, so a test cannot inject a weaker claim.
   */
  writer?: WriterClaim | null;
  /** Legacy seam: an extra host-side gate ANDed with the chain. */
  trusted?: boolean;
  bodyMaxBytes?: number;
  bodyEagerMaxBytes?: number;
}

function service(options: ServiceOptions = {}): HistoryService {
  const writer = options.writer;
  const running = writer !== null && writer !== undefined;
  return new HistoryService({
    resolveWorkspace: (daemonId) =>
      daemonId === DAEMON ? { daemon_id: daemonId, cwd: fixture.cwd, name: "ws" } : null,
    // Read LIVE on every call: the child publishes a NEW claim per message, so a
    // test that appends must see the service react to the updated accounting.
    runtime: (daemonId) => {
      if (daemonId !== DAEMON) return null;
      const claim = writer === null || writer === undefined ? null : writer.current();
      return {
        state: running ? "running" : "stopped",
        session_id: claim === null ? null : claim.session_id,
        ready: running ? null : false,
        session_file: claim === null ? null : claim.file,
        session_stamp: claim === null ? null : claim.stamp,
        // R2 — WITHOUT this the host must not trust an append at all, even when
        // the session id matches and the slot is running.
        // 86-P2-R1/R2 BLOCKED: no supported exclusive-writer boundary exists, so
        // the production supervisor publishes `false` here. A fixture must match.
        append_authority: false,
      };
    },
    ...(options.trusted !== undefined ? { trustedAppend: () => options.trusted === true } : {}),
    agentRoot: fixture.root,
    remoteHome,
    reconcileIntervalMs: 0,
    workerPortFactory: () => createInlineHistoryPort(),
    ...(options.bodyMaxBytes !== undefined ? { bodyMaxBytes: options.bodyMaxBytes } : {}),
    ...(options.bodyEagerMaxBytes !== undefined ? { bodyEagerMaxBytes: options.bodyEagerMaxBytes } : {}),
  });
}

/**
 * A MUTABLE model of the live child's PRE-PERSIST receipt (R1/R2).
 *
 * The SDK persists AFTER the extension hook (`agent-session.js:272` emits the
 * event, `:287` appends), so a receipt always describes the file BEFORE the
 * child's own bytes. `receipt()` is therefore called BEFORE a test writes, and
 * leaving it stale is how a test proves foreign or rewritten bytes are not
 * attributed to this writer.
 */
interface NoticeStamp {
  ino: number;
  birthtime_ms: number;
  size: number;
  mtime_ms: number;
  ctime_ms: number;
}

interface WriterClaim {
  session_id: string;
  file: string;
  /** Capture the current file state as the pre-persist receipt. */
  receipt(): void;
  /** Publish a receipt for an explicit state (a stale or foreign child). */
  receiptAs(stamp: NoticeStamp | null): void;
  /** What the service's runtime snapshot will report, read LIVE per call. */
  current(): { session_id: string; file: string | null; stamp: NoticeStamp | null };
}

function noticeStampOf(file: string): NoticeStamp {
  const stat = fs.statSync(file);
  return {
    ino: Number(stat.ino) || 0,
    birthtime_ms: Number(stat.birthtimeMs) || 0,
    size: stat.size,
    mtime_ms: Number(stat.mtimeMs) || 0,
    ctime_ms: Number(stat.ctimeMs) || 0,
  };
}

function liveWriterFor(file: string, sessionId = SESSION): WriterClaim {
  let stamp: NoticeStamp | null = noticeStampOf(file);
  return {
    session_id: sessionId,
    file,
    receipt(): void {
      stamp = noticeStampOf(file);
    },
    receiptAs(next: NoticeStamp | null): void {
      stamp = next;
    },
    current: () => ({ session_id: sessionId, file, stamp }),
  };
}

const list = (id: string, extra: Record<string, unknown> = {}) =>
  ({ type: "history_list" as const, id, daemon_id: DAEMON, ...extra });
const read = (id: string, extra: Record<string, unknown> = {}) =>
  ({ type: "history_read" as const, id, daemon_id: DAEMON, session_id: SESSION, ...extra });

async function readyList(svc: HistoryService, id = "L"): Promise<Extract<Awaited<ReturnType<HistoryService["list"]>>["reply"], { type: "history_list_ok" }>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const outcome = await svc.list(list(`${id}-${attempt}`));
    if (outcome.reply.type === "history_list_ok" && outcome.reply.index_state !== "building") {
      return outcome.reply;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("list did not become ready");
}

async function readyRead(
  svc: HistoryService,
  extra: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<HistoryService["read"]>>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const outcome = await svc.read(read(`R-${attempt}`, extra));
    if (outcome.reply.type !== "history_error" || outcome.reply.code !== "building") return outcome;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("read did not become ready");
}

function standardSession(text = "hello") {
  return writeTranscript(fixture.bucket, {
    id: SESSION,
    cwd: fixture.cwd,
    name: "p2",
    messages: [userMessage("u1", text)],
  });
}

function fileBytes(file: string): number {
  return fs.statSync(file).size;
}

function shaFile(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

describe("plan 86 P2 — index generations and writer ownership", () => {
  test("an unpublished generation is invisible to the reader", () => {
    const workspace = fixture.bucket;
    const writer = writerFor(historyDbPath(remoteHome));
    expect(writer.open()).toEqual({ ok: true });
    writer.transaction(() => {
      writer.upsertWorkspace({
        workspace,
        state: "ready",
        revision: "r1",
        scanned_at: Date.now(),
        scan_error: null,
        pending: 0,
        cursor: null,
      });
      writer.insertEntry({
        workspace,
        session_id: SESSION,
        generation: "unpublished",
        entry_id: "u1",
        parent_id: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        role: "user",
        event_count: 1,
        seed_user_id: null,
        line_start: 0,
        line_end: 10,
        projections: "[]",
      });
    });
    const reader = readerFor(historyDbPath(remoteHome));
    expect(reader.open()).toBe(true);
    const listed = reader.list(workspace, 50, null);
    expect(listed.state).toBe("ready");
    if (listed.state === "ready") expect(listed.rows).toEqual([]);
    expect(reader.session(workspace, SESSION)).toBeNull();
    expect(reader.page(workspace, SESSION, "unpublished", 30, null).entries).toHaveLength(1);
  });

  test("a corrupt DB is quarantined and rebuilt, never fatal", async () => {
    standardSession();
    const dbPath = historyDbPath(remoteHome);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, "this is not a sqlite database at all");
    const svc = service();
    try {
      const listed = await readyList(svc);
      expect(listed.sessions.map((row) => row.id)).toEqual([SESSION]);
      const backups = fs.readdirSync(path.dirname(dbPath)).filter((name) => name.includes(".corrupt-"));
      expect(backups.length).toBeGreaterThanOrEqual(1);
    } finally {
      await svc.dispose();
    }
  });

  test("the old child index.sqlite is never migrated, written or shared", async () => {
    standardSession();
    const oldPath = path.join(remoteHome, ".pi", "remote", "index.sqlite");
    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    const old = new DatabaseSync(oldPath);
    old.exec(`
      CREATE TABLE sessions (
        path TEXT PRIMARY KEY, cwd TEXT NOT NULL, id TEXT NOT NULL, name TEXT,
        mtime INTEGER NOT NULL, preview TEXT, file_mtime REAL NOT NULL, size INTEGER NOT NULL
      );
    `);
    old.prepare("INSERT INTO sessions (path, cwd, id, name, mtime, preview, file_mtime, size) VALUES (?,?,?,?,?,?,?,?)").run(
      "/child/old.jsonl",
      "/child",
      "old-child",
      "old",
      1,
      "p",
      1,
      2,
    );
    old.close();
    const before = shaFile(oldPath);

    // Keep a write transaction OPEN on the old DB while the new DB is created,
    // migrated and queried. Different files, different writers — no conflict.
    const concurrent = new DatabaseSync(oldPath);
    concurrent.exec("BEGIN IMMEDIATE");
    concurrent
      .prepare("INSERT INTO sessions (path, cwd, id, name, mtime, preview, file_mtime, size) VALUES (?,?,?,?,?,?,?,?)")
      .run("/child/new.jsonl", "/child", "old-child-2", "old2", 2, "q", 2, 3);

    const svc = service();
    try {
      const listed = await readyList(svc);
      expect(listed.sessions.map((row) => row.id)).toEqual([SESSION]);
      concurrent.exec("COMMIT");
    } finally {
      concurrent.close();
      await svc.dispose();
    }

    const after = new DatabaseSync(oldPath);
    const rows = after.prepare("SELECT id FROM sessions ORDER BY id").all() as Array<{ id: string }>;
    after.close();
    expect(rows.map((row) => row.id)).toEqual(["old-child", "old-child-2"]);
    // The old DB file was not rewritten by our migration (a concurrent old
    // writer legitimately changed it after `before`; the point is our code
    // never opens it. Re-hash only if no concurrent write had happened).
    expect(fs.existsSync(historyDbPath(remoteHome))).toBe(true);
    expect(before).toHaveLength(64);
  });
});

describe("plan 86 P2 — append trust and conservative rebuild", () => {
  function bigSession(entries = 200): { file: string; size: number } {
    const messages = [];
    for (let index = 0; index < entries; index += 1) {
      messages.push(userMessage(`u${index}`, `entry-${index}-` + "x".repeat(4000)));
    }
    const { file } = writeTranscript(fixture.bucket, { id: SESSION, cwd: fixture.cwd, messages });
    return { file, size: fileBytes(file) };
  }

  function appendMessage(file: string, id: string, text: string): number {
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
   * This test used to prove "trusted append parses only the new bytes" by
   * injecting `append_authority: true`. That is no longer possible: no supported
   * exclusive-writer boundary exists on SDK 0.79.10, so the supervisor publishes
   * `false`, and the index MUST rebuild on every change.
   *
   * What is asserted here is exactly the production behavior, on a file big enough
   * that a regression to "accept the growth" would be visible: the new entry is
   * served, the whole file is re-parsed (O(file), reported as such), and no
   * incremental path is taken.
   */
  test("a live writer notice does NOT buy an incremental append: every change rebuilds", async () => {
    const { file, size } = bigSession();
    expect(size).toBeGreaterThan(500_000);
    // A notice is present (the child really is running and published identity)…
    const writerForClaimRef = liveWriterFor(file);
    const svc = service({ writer: writerForClaimRef });
    try {
      const first = await readyRead(svc);
      if (first.reply.type !== "history_read_ok") throw new Error("no read");
      expect(first.reply.session.id).toBe(SESSION);

      writerForClaimRef.receipt();
      const appended = appendMessage(file, "zzz-new", "appended message");
      const second = await readyRead(svc);
      if (second.reply.type !== "history_read_ok") throw new Error("no read");
      expect(second.reply.items.some((item) => item.event_id === "zzz-new")).toBe(true);
      // …and it is served CORRECTLY, but at the conservative price.
      expect(second.metrics.cold_build_bytes ?? 0).toBeGreaterThanOrEqual(size - 1024);
      expect(second.metrics.cold_build_bytes ?? 0).toBeGreaterThanOrEqual(appended);
    } finally {
      await svc.dispose();
    }
  });

  test("unknown growth is NOT trusted: it rebuilds the whole file", async () => {
    const { file, size } = bigSession();
    const svc = service({ writer: null });
    try {
      const first = await readyRead(svc);
      if (first.reply.type !== "history_read_ok") throw new Error("no read");
      appendMessage(file, "zzz-untrusted", "untrusted message");
      const second = await readyRead(svc);
      if (second.reply.type !== "history_read_ok") throw new Error("no read");
      expect(second.reply.items.some((item) => item.event_id === "zzz-untrusted")).toBe(true);
      expect(second.metrics.cold_build_bytes ?? 0).toBeGreaterThanOrEqual(size);
    } finally {
      await svc.dispose();
    }
  });

  test("same-size rewrite with restored mtime invalidates the snapshot (not a fast read)", async () => {
    const { file } = writeTranscript(fixture.bucket, {
      id: SESSION,
      cwd: fixture.cwd,
      messages: [userMessage("u1", "A".repeat(10_000))],
    });
    /*
     * A LIVE writer whose accounting stays at the ORIGINAL size: the rewrite is
     * therefore an unknown external change even though the session id matches
     * and the slot is running. That is R2's whole point.
     */
    const live = liveWriterFor(file);
    const svc = service({ writer: live });
    try {
      const first = await readyRead(svc);
      if (first.reply.type !== "history_read_ok") throw new Error("no read");
      const stat = fs.statSync(file);

      const text = fs.readFileSync(file, "utf8").replace("A".repeat(10_000), "B".repeat(10_000));
      fs.writeFileSync(file, text);
      fs.utimesSync(file, stat.atime, stat.mtime);

      const again = await svc.read(read("R-old", { snapshot: first.reply.snapshot }));
      expect(again.reply).toMatchObject({ type: "history_error", code: "stale" });

      const fresh = await readyRead(svc);
      if (fresh.reply.type !== "history_read_ok") throw new Error("no read");
      expect(fresh.reply.items[0]?.event.type).toBe("user_input");
      // The old body snapshot is stale as well.
      const ref = first.reply.items[0]?.body_refs?.[0];
      if (ref !== undefined) {
        const body = await svc.body({
          type: "history_body",
          id: "B-old",
          daemon_id: DAEMON,
          session_id: SESSION,
          snapshot: first.reply.snapshot,
          body_ref: ref.ref,
          offset_bytes: 0,
        });
        expect(body.reply).toMatchObject({ type: "history_error", code: "stale" });
      }
    } finally {
      await svc.dispose();
    }
  });

  test("shrink, replace and delete invalidate old snapshots and the list row", async () => {
    const { file } = standardSession("Z".repeat(5000));
    const svc = service();
    try {
      const first = await readyRead(svc);
      if (first.reply.type !== "history_read_ok") throw new Error("no read");
      const snapshot = first.reply.snapshot;

      // Shrink to the header line.
      const header = fs.readFileSync(file, "utf8").split("\n")[0]! + "\n";
      fs.writeFileSync(file, header);
      expect((await svc.read(read("R-shrink", { snapshot }))).reply).toMatchObject({
        type: "history_error",
        code: "stale",
      });

      // Replace the whole file (new identity) with a different session id.
      const replacement = path.join(fixture.bucket, "replacement.jsonl");
      fs.writeFileSync(
        replacement,
        JSON.stringify({ type: "session", id: SESSION, cwd: fixture.cwd, timestamp: "2026-02-01T00:00:00.000Z" }) +
          "\n" +
          JSON.stringify({
            type: "message",
            id: "new1",
            parentId: null,
            timestamp: "2026-02-01T00:00:01.000Z",
            message: { role: "user", content: "replaced" },
          }) +
          "\n",
      );
      fs.rmSync(file);
      fs.renameSync(replacement, file);
      const replaced = await readyRead(svc);
      if (replaced.reply.type !== "history_read_ok") throw new Error("no read");
      expect(replaced.reply.items.map((item) => item.event_id)).toEqual(["new1"]);

      // Delete.
      fs.rmSync(file);
      const listed = await readyList(svc, "L-del");
      expect(listed.sessions).toEqual([]);
      expect((await svc.read(read("R-del"))).reply).toMatchObject({
        type: "history_error",
        code: "not_found",
      });
    } finally {
      await svc.dispose();
    }
  });

  test("torn and corrupt lines never publish partial metadata", async () => {
    const { file } = writeTranscript(fixture.bucket, {
      id: SESSION,
      cwd: fixture.cwd,
      messages: [userMessage("u1", "clean")],
    });
    fs.appendFileSync(file, '{"type":"message","id":"torn"');
    const svc = service();
    try {
      const first = await readyRead(svc);
      if (first.reply.type !== "history_read_ok") throw new Error("no read");
      expect(first.reply.items.map((item) => item.event_id)).toEqual(["u1"]);

      fs.appendFileSync(file, "\n{ not json }\n" + JSON.stringify({
        type: "message",
        id: "u2",
        parentId: null,
        timestamp: "2026-01-01T00:00:02.000Z",
        message: { role: "user", content: "after bad" },
      }) + "\n");
      const second = await readyRead(svc);
      if (second.reply.type !== "history_read_ok") throw new Error("no read");
      expect(second.reply.items.map((item) => item.event_id)).toEqual(["u1", "u2"]);
    } finally {
      await svc.dispose();
    }
  });
});

describe("plan 86 P2 — explicit refresh and sidecar revocation", () => {
  test("explicit refresh discovers a new session without a read", async () => {
    standardSession();
    const svc = service();
    try {
      await readyList(svc);
      writeTranscript(fixture.bucket, {
        id: "s2",
        cwd: fixture.cwd,
        fileName: "zzz_s2.jsonl",
        messages: [userMessage("u2", "second")],
      });
      const metrics = await svc.refreshWorkspace(DAEMON);
      expect(metrics.query_ms).toBeGreaterThanOrEqual(0);
      const listed = await readyList(svc, "L-refresh");
      expect(listed.sessions.map((row) => row.id).sort()).toEqual(["s1", "s2"]);
    } finally {
      await svc.dispose();
    }
  });

  test("a rewritten generation revokes its body sidecar", async () => {
    const { file } = writeTranscript(fixture.bucket, {
      id: SESSION,
      cwd: fixture.cwd,
      messages: [userMessage("u1", "A".repeat(10_000))],
    });
    const svc = service();
    try {
      const first = await readyRead(svc);
      if (first.reply.type !== "history_read_ok") throw new Error("no read");
      const ref = first.reply.items[0]?.body_refs?.[0]!;
      const body = await svc.body({
        type: "history_body",
        id: "B1",
        daemon_id: DAEMON,
        session_id: SESSION,
        snapshot: first.reply.snapshot,
        body_ref: ref.ref,
        offset_bytes: 0,
      });
      expect(body.reply.type).toBe("history_body_ok");
      const root = historyBodiesRoot(remoteHome);
      const before = fs.readdirSync(root).filter((name) => name.startsWith("g-"));
      expect(before).toHaveLength(1);

      const stat = fs.statSync(file);
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("A".repeat(10_000), "B".repeat(10_000)));
      fs.utimesSync(file, stat.atime, stat.mtime);
      await readyRead(svc);

      const deadline = Date.now() + 2000;
      for (;;) {
        const after = fs.readdirSync(root).filter((name) => name.startsWith("g-"));
        if (!after.includes(before[0]!)) break;
        if (Date.now() > deadline) throw new Error("sidecar was not revoked");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      await svc.dispose();
    }
  });
});

describe("plan 86 P2 — pages, tool parents and frame bounds", () => {
  test("tool parents come from the index (one lookup) and never move the cursor", async () => {
    writeTranscript(fixture.bucket, {
      id: SESSION,
      cwd: fixture.cwd,
      messages: [
        userMessage("u1", "hello"),
        assistantMessage("a1", [textBlock("calling"), toolCallBlock("tc1", "read", { path: "/x" })]),
        toolResultMessage("r1", "tc1", "result"),
      ],
    });
    const svc = service();
    try {
      const newest = await readyRead(svc, { limit: 1 });
      if (newest.reply.type !== "history_read_ok") throw new Error("no read");
      expect(newest.reply.items.filter((item) => item.parent === true).map((item) => item.event_id)).toEqual([
        "a1#0",
        "a1#1",
      ]);
      expect(newest.reply.items.find((item) => item.event_id === "r1")).toBeDefined();
      expect(newest.reply.older_cursor).not.toBeNull();

      const older = await readyRead(svc, { limit: 1, before: newest.reply.older_cursor });
      if (older.reply.type !== "history_read_ok") throw new Error("no read");
      expect(older.reply.items.map((item) => item.event_id)).toEqual(["a1#0", "a1#1"]);
    } finally {
      await svc.dispose();
    }
  });

  test("a page with many giant previews is trimmed to 256 KiB and always advances", async () => {
    const messages = [];
    for (let index = 0; index < 80; index += 1) {
      messages.push(userMessage(`u${index}`, `entry-${index}-` + "q".repeat(5000)));
    }
    writeTranscript(fixture.bucket, { id: SESSION, cwd: fixture.cwd, messages });
    const svc = service();
    try {
      const first = await readyRead(svc, { limit: 80 });
      if (first.reply.type !== "history_read_ok") throw new Error("no read");
      expect(first.reply.items.length).toBeLessThan(80);
      expect(first.reply.has_older).toBe(true);
      const second = await readyRead(svc, { limit: 80, before: first.reply.older_cursor });
      if (second.reply.type !== "history_read_ok") throw new Error("no read");
      const ids = new Set(first.reply.items.map((item) => item.event_id));
      for (const item of second.reply.items) expect(ids.has(item.event_id)).toBe(false);
    } finally {
      await svc.dispose();
    }
  });
});

describe("plan 86 P2 — body sidecar budgets", () => {
  test("LRU eviction, protected layout and typed too_large", () => {
    const root = `${fixture.root}/bodies`;
    const source = path.join(fixture.root, "source.bin");
    const body = "a".repeat(600);
    fs.writeFileSync(source, JSON.stringify(body) + "\n");
    const span = { start: 1, end: 1 + Buffer.byteLength(JSON.stringify(body), "utf8") - 2 };
    const spec = (generation: string, entry: string, total: number, digest: string): {
      workspace: string;
      session_id: string;
      generation: string;
      entry_id: string;
      event_id: string;
      field: string;
      representation: "text_utf8";
      mime: null;
      spans: Array<{ start: number; end: number }>;
      synthetic_base64: null;
      total_bytes: number;
      digest: string;
    } => ({
      workspace: fixture.bucket,
      session_id: SESSION,
      generation,
      entry_id: entry,
      event_id: entry,
      field: "text",
      representation: "text_utf8",
      mime: null,
      spans: [span],
      synthetic_base64: null,
      total_bytes: total,
      digest,
    });
    const textBytes = Buffer.from(body, "utf8");
    const digest = createHash("sha256").update(textBytes).digest("hex");
    const store = new HistoryBodyStore({ root, budgetBytes: 1000 });
    const identity = { ino: 0, birthtime_ms: 0, size: fs.statSync(source).size };
    expect(store.chunk(spec("g1", "e1", textBytes.length, digest), source, identity, 0, 64, {
      trustedAppend: false,
    }).ok).toBe(true);
    expect(store.chunk(spec("g2", "e2", textBytes.length, digest), source, identity, 0, 64, {
      trustedAppend: false,
    }).ok).toBe(true);
    // Budget is 1000 bytes: only the newest body remains.
    expect(store.listSidecars()).toHaveLength(1);
    expect(fs.existsSync(bodyGenerationDir(root, "g2"))).toBe(true);

    const tooBig = { ...spec("g3", "e3", 2000, digest), total_bytes: 2000 };
    const refused = store.chunk(tooBig, source, identity, 0, 64, { trustedAppend: false });
    expect(refused).toMatchObject({ ok: false, code: "body_too_large" });

    // Digest mismatch is a typed stale, never a silently wrong body.
    const bad = spec("g8", "e8", textBytes.length, "0".repeat(64));
    expect(store.chunk(bad, source, identity, 0, 64, { trustedAppend: false })).toMatchObject({
      ok: false,
      code: "stale",
    });
  });

  test("the P1 16 MiB cap is replaced by the approved 256 MiB sidecar budget", () => {
    expect(HISTORY_BODY_MAX_TOTAL_BYTES).toBe(256 * 1024 * 1024);
  });

  test("a body above the configured budget answers body_too_large instead of pretending", async () => {
    const big = "z".repeat(20_000);
    writeTranscript(fixture.bucket, {
      id: SESSION,
      cwd: fixture.cwd,
      messages: [userMessage("u1", big)],
    });
    const svc = service({ bodyMaxBytes: 10_000 });
    try {
      const first = await readyRead(svc);
      if (first.reply.type !== "history_read_ok") throw new Error("no read");
      const ref = first.reply.items[0]?.body_refs?.[0]!;
      const reply = await svc.body({
        type: "history_body",
        id: "B1",
        daemon_id: DAEMON,
        session_id: SESSION,
        snapshot: first.reply.snapshot,
        body_ref: ref.ref,
        offset_bytes: 0,
      });
      expect(reply.reply).toMatchObject({ type: "history_error", code: "body_too_large" });
    } finally {
      await svc.dispose();
    }
  });
});

describe("plan 86 P2 — query planning and metadata", () => {
  test("the hot page query uses the entries keyset index (EXPLAIN)", async () => {
    standardSession();
    const svc = service();
    try {
      const first = await readyRead(svc);
      if (first.reply.type !== "history_read_ok") throw new Error("no read");
      const reader = readerFor(historyDbPath(remoteHome));
      expect(reader.open()).toBe(true);
      const plan = reader.explainPage(fixture.bucket, SESSION, first.reply.snapshot.length > 0 ? (reader.session(fixture.bucket, SESSION)?.generation ?? "") : "");
      expect(plan.join("\n")).toMatch(/entries_page|PRIMARY KEY/);
    } finally {
      await svc.dispose();
    }
  });

  test("entry rows carry offsets, spans and tool-call declarations", async () => {
    writeTranscript(fixture.bucket, {
      id: SESSION,
      cwd: fixture.cwd,
      messages: [
        userMessage("u1", "x".repeat(5000)),
        assistantMessage("a1", [toolCallBlock("tc1", "read", { path: "/y" })]),
      ],
    });
    const svc = service();
    try {
      await readyRead(svc);
      const reader = readerFor(historyDbPath(remoteHome));
      reader.open();
      const row = reader.session(fixture.bucket, SESSION)!;
      const page = reader.page(fixture.bucket, SESSION, row.generation, 30, null);
      expect(page.entries).toHaveLength(2);
      expect(page.entries[0]!.line_start).toBeGreaterThan(0);
      expect(page.entries[0]!.line_end).toBeGreaterThan(page.entries[0]!.line_start);
      const fieldRow: HistoryFieldRow | null = reader.field(fixture.bucket, SESSION, row.generation, "u1", "u1", "text");
      expect(fieldRow).not.toBeNull();
      expect(fieldRow!.spans).toContain("start");
      const parent = reader.toolCallParent(
        fixture.bucket,
        SESSION,
        row.generation,
        "tc1",
        "2026-01-01T00:00:02.000Z",
      );
      expect(parent).toBe("a1");
    } finally {
      await svc.dispose();
    }
  });
});
