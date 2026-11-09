/**
 * SQLite index for the session list.
 *
 * Why this exists: `SessionManager.list(cwd)` opens EVERY `.jsonl` in the
 * workspace's session bucket and streams it line by line to derive `preview`
 * and the last-activity timestamp. That cost scales with BYTES, not with the
 * number of sessions, so a directory with one 86 MB transcript is slow no
 * matter how few sessions it has. Measured on this repo: 39 sessions /
 * 371 MB = ~3.9 s, versus 46 sessions / 18 MB = ~290 ms.
 *
 * The index caches what parsing produced, keyed by the file's identity
 * `(path, mtime, size)`. An unchanged file costs one `stat`; a changed one is
 * re-parsed. The filesystem stays the source of truth — the index is a pure
 * cache that can be deleted at any moment and rebuilt.
 *
 * Deliberately NOT here: any notion of a session existing. A file that
 * disappears must vanish from the list even though a row survives in the
 * index, so reconciliation is driven by the directory listing.
 *
 * `node:sqlite` is bundled with Node 22 and prints an ExperimentalWarning on
 * first use. That warning is expected and harmless; it is NOT suppressed
 * app-wide because `--no-warnings=ExperimentalWarning` would also hide
 * unrelated experimental-API warnings. No separate SQLite install is needed.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";

/** Where the index lives. Honours `REMOTE_PI_HOME` like every other state file. */
export function indexDbPath(): string {
  const home = process.env["REMOTE_PI_HOME"] || os.homedir();
  return path.join(home, ".pi", "remote", "index.sqlite");
}

export interface IndexedSession {
  id: string;
  path: string;
  name?: string;
  mtime: number;
  preview?: string;
  cwd?: string;
}

/** What `(path, mtime, size)` is compared against. */
interface FileStamp {
  mtimeMs: number;
  size: number;
}

let _db: DatabaseSync | null = null;
let _dbPath: string | null = null;

/**
 * Opens (and migrates) the index, or returns null when it cannot be used.
 *
 * A failure here must never break the feature: the caller falls back to the
 * direct SDK path. That is why this swallows errors and reports null instead of
 * throwing — an index that cannot open is a slow list, not a broken app.
 */
function openDb(): DatabaseSync | null {
  const wanted = indexDbPath();
  if (_db !== null && _dbPath === wanted) return _db;
  closeIndex();
  try {
    fs.mkdirSync(path.dirname(wanted), { recursive: true });
    const db = new DatabaseSync(wanted);
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        path       TEXT PRIMARY KEY,
        cwd        TEXT NOT NULL,
        id         TEXT NOT NULL,
        name       TEXT,
        mtime      INTEGER NOT NULL,
        preview    TEXT,
        file_mtime REAL NOT NULL,
        size       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_cwd ON sessions(cwd);
    `);
    _db = db;
    _dbPath = wanted;
    return db;
  } catch {
    return null;
  }
}

export function closeIndex(): void {
  if (_db !== null) {
    try {
      _db.close();
    } catch {
      /* closing a cache is best-effort by definition */
    }
  }
  _db = null;
  _dbPath = null;
}

/** Test hook: drop the connection so the next call re-opens (and re-migrates). */
export function resetIndexForTest(): void {
  closeIndex();
}

function statOf(file: string): FileStamp | null {
  try {
    const s = fs.statSync(file);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// JSONL parsing — mirrors what the SDK derives, kept in one place so the
// contract test can compare the two directly.
// ---------------------------------------------------------------------------

/**
 * Parses one session file into the fields the list needs.
 *
 * This intentionally reproduces the SDK's rules rather than inventing new
 * ones, because the index must be indistinguishable from a cold scan. Two
 * details are easy to get wrong and are pinned by tests:
 *
 *  - `mtime` is NOT the file's mtime. It is the newest message timestamp
 *    inside the file, falling back to the header timestamp and only then to
 *    the filesystem mtime.
 *  - the preview is the FIRST *user* message, not the first message overall.
 *
 * Returns null for a file that is not a session (no `type: "session"` header),
 * matching `SessionManager.list`, which drops those silently.
 */
export async function readSessionFile(file: string): Promise<IndexedSession | null> {
  let header: Record<string, unknown> | null = null;
  let lastActivityTime: number | undefined;
  let firstMessage = "";
  let name: string | undefined;

  try {
    const rl = createInterface({
      input: createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (line.trim() === "") continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!header) {
        if (entry["type"] !== "session") return null;
        header = entry;
        continue;
      }
      if (entry["type"] === "session_info") {
        const n = entry["name"];
        name = typeof n === "string" && n.trim() !== "" ? n.trim() : undefined;
        continue;
      }
      if (entry["type"] !== "message") continue;
      const message = entry["message"];
      if (!message || typeof message !== "object") continue;
      const msg = message as Record<string, unknown>;
      const role = msg["role"];
      if (role !== "user" && role !== "assistant") continue;
      if (!("content" in msg)) continue;

      const ts = msg["timestamp"];
      const activity = typeof ts === "number"
        ? ts
        : new Date(String(entry["timestamp"])).getTime();
      if (!Number.isNaN(activity)) {
        lastActivityTime = Math.max(lastActivityTime ?? 0, activity);
      }

      if (firstMessage === "") {
        const text = textOf(msg["content"]);
        if (text !== "" && role === "user") firstMessage = text;
      }
    }
  } catch {
    return null;
  }

  if (!header) return null;

  const headerTime = new Date(String(header["timestamp"])).getTime();
  const fallback = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
  const mtime =
    typeof lastActivityTime === "number" && lastActivityTime > 0
      ? lastActivityTime
      : !Number.isNaN(headerTime)
        ? headerTime
        : fallback;

  const cwd = typeof header["cwd"] === "string" ? header["cwd"] : "";
  const id = typeof header["id"] === "string" ? header["id"] : path.basename(file, ".jsonl");

  return {
    id,
    path: file,
    name,
    mtime,
    preview: firstMessage === "" ? undefined : firstMessage.slice(0, 200),
    cwd,
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text: string } =>
      typeof b === "object" && b !== null && (b as { type?: string }).type === "text")
    .map((b) => b.text)
    .join(" ");
}

// ---------------------------------------------------------------------------
// Directory enumeration — uses the SDK's own bucket derivation so the index can
// never look at a different set of files than the direct path would.
// ---------------------------------------------------------------------------

/**
 * The session bucket for [cwd], derived exactly the way the SDK does it.
 *
 * The SDK does not export this helper, and importing its internal module is
 * blocked by `exports`. So the rule is reproduced here — but from the
 * normalized path, which is the part that bit: `path.resolve` on Windows keeps
 * the backslashes, and feeding those to the substitution produced a bucket name
 * that does not exist (a probe derived
 * `--D:...server\workspacegit_repo\emote_pi--` for this very repo).
 *
 * The rule: resolve → forward slashes → drop the leading separator → replace
 * every `/`, `\` and `:` with `-` → wrap in `--…--`.
 */
export function sessionDirFor(cwd: string, agentDir: string): string {
  const resolved = path.resolve(cwd);
  const safe = `--${resolved
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-")}--`;
  return path.join(agentDir, "sessions", safe);
}

/**
 * Lists the `.jsonl` files belonging to [cwd].
 *
 * Used only to know WHICH files exist; their contents come from the index. A
 * missing bucket yields an empty list, which correctly means "no sessions"
 * rather than "unknown".
 *
 * The bucket is always derived under the SDK's real agent root. It deliberately
 * does NOT follow `REMOTE_PI_HOME`: that variable relocates Remote Pi's own
 * state (config, index, locks), while the transcripts belong to the Pi agent
 * and keep living in its own directory. Conflating the two made an index
 * pointed at a scratch home report an empty session list for a workspace that
 * demonstrably had transcripts.
 */
export async function sessionFilesFor(cwd: string): Promise<string[]> {
  try {
    const dir = sessionDirFor(cwd, agentRoot());
    const entries = await fs.promises.readdir(dir);
    return entries
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/**
 * The Pi agent root that owns the transcripts.
 *
 * Asks the SDK once (it is the authority on its own default) and falls back to
 * the conventional `~/.pi/agent`.
 */
function agentRoot(): string {
  const override = _agentRootOverride;
  if (override !== null) return override;
  return _sdkAgentDir ?? path.join(os.homedir(), ".pi", "agent");
}

let _agentRootOverride: string | null = null;

/**
 * Test hook: point the transcript root at a scratch tree.
 *
 * Tests own their fixtures, and writing into the developer's real `~/.pi/agent`
 * would be both destructive and flaky. Production never calls this.
 */
export function setAgentRootForTest(root: string | null): void {
  _agentRootOverride = root;
}

let _sdkAgentDir: string | null = null;

/**
 * Asks the SDK where its agent root is, once, and remembers it.
 *
 * The SDK does not export its session-bucket helper and blocks deep imports, so
 * the root is the one thing worth borrowing from it; the naming rule is
 * reproduced in [sessionDirFor].
 */
export async function primeAgentDir(): Promise<void> {
  if (_sdkAgentDir !== null) return;
  try {
    const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
    _sdkAgentDir = getAgentDir();
  } catch {
    /* fall back to the homedir guess */
  }
}

// ---------------------------------------------------------------------------
// The indexed list
// ---------------------------------------------------------------------------

/**
 * Lists sessions for [cwd], parsing only files whose `(mtime, size)` changed.
 *
 * Returns null when the index is unavailable, so the caller can fall back to
 * `SessionManager.list` and stay correct at the cost of speed.
 *
 * Reconciliation is driven by the directory: a file present on disk and
 * unchanged is served from the index; changed or unknown files are parsed and
 * upserted; rows whose files are gone are deleted. That ordering is what keeps
 * a deleted transcript from lingering as a ghost session.
 */
export async function listSessionsIndexed(cwd: string): Promise<IndexedSession[] | null> {
  const db = openDb();
  if (db === null) return null;

  await primeAgentDir();
  const files = await sessionFilesFor(cwd);
  if (files.length === 0) {
    // Nothing on disk for this cwd — the answer is empty, not "stale rows".
    try {
      db.prepare("DELETE FROM sessions WHERE cwd = ?").run(cwd);
    } catch {
      return null;
    }
    return [];
  }

  const known = new Map<string, { mtime: number; size: number }>();
  try {
    const rows = db
      .prepare("SELECT path, file_mtime, size FROM sessions WHERE cwd = ?")
      .all(cwd) as Array<{ path: string; file_mtime: number; size: number }>;
    for (const r of rows) known.set(r.path, { mtime: r.file_mtime, size: r.size });
  } catch {
    return null;
  }

  const insert = db.prepare(`
    INSERT INTO sessions (path, cwd, id, name, mtime, preview, file_mtime, size)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      cwd = excluded.cwd,
      id = excluded.id,
      name = excluded.name,
      mtime = excluded.mtime,
      preview = excluded.preview,
      file_mtime = excluded.file_mtime,
      size = excluded.size
  `);

  const result: IndexedSession[] = [];
  const seen = new Set<string>();
  let reParsed = 0;

  try {
    for (const file of files) {
      const stamp = statOf(file);
      if (stamp === null) continue;
      seen.add(file);

      const prev = known.get(file);
      if (prev !== undefined && prev.mtime === stamp.mtimeMs && prev.size === stamp.size) {
        // Unchanged: the expensive part is skipped entirely. The row is read
        // back below with the rest.
        continue;
      }

      const parsed = await readSessionFile(file);
      reParsed++;
      if (parsed === null) {
        // Not a session file (or unreadable). Keep it out of the index and out
        // of the result, exactly like the SDK.
        try {
          db.prepare("DELETE FROM sessions WHERE path = ?").run(file);
        } catch {
          return null;
        }
        continue;
      }
      insert.run(
        parsed.path,
        cwd,
        parsed.id,
        parsed.name ?? null,
        // `mtime` is the newest message timestamp INSIDE the file (the SDK's
        // contract), not `stat().mtimeMs`. Writing the filesystem stamp here
        // made every row's reported time differ from the SDK by minutes.
        parsed.mtime,
        parsed.preview ?? null,
        // The file identity, used only to decide whether to re-parse.
        stamp.mtimeMs,
        stamp.size,
      );
    }

    // Drop rows whose files no longer exist — otherwise a deleted transcript
    // would keep appearing forever.
    for (const p of known.keys()) {
      if (!seen.has(p)) {
        db.prepare("DELETE FROM sessions WHERE path = ?").run(p);
      }
    }

    const rows = db
      .prepare(
        "SELECT id, path, name, mtime, preview, cwd FROM sessions WHERE cwd = ?",
      )
      .all(cwd) as Array<{
        id: string;
        path: string;
        name: string | null;
        mtime: number;
        preview: string | null;
        cwd: string | null;
      }>;

    for (const r of rows) {
      if (!seen.has(r.path)) continue;
      result.push({
        id: r.id,
        path: r.path,
        name: r.name ?? undefined,
        mtime: r.mtime,
        preview: r.preview ?? undefined,
        cwd: r.cwd ?? undefined,
      });
    }
  } catch {
    return null;
  }

  // Same ordering contract as the SDK: newest first.
  result.sort((a, b) => b.mtime - a.mtime);
  _lastStats = { parsed: reParsed, served: result.length };
  return result;
}

let _lastStats = { parsed: 0, served: 0 };

/**
 * How the previous [listSessionsIndexed] call spent its time.
 *
 * `parsed` counts files that had to be re-read; 0 means the call was served
 * entirely from the index. Exposed so tests can prove the hot path stayed
 * cached — a faster stopwatch would not, since the SDK path is also fast when
 * the directory is small.
 */
export function lastIndexStats(): { parsed: number; served: number } {
  return _lastStats;
}
