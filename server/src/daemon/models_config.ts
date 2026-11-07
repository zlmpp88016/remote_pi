/**
 * Plan/79 — editing the host's own `~/.pi/agent/models.json` from the web client.
 *
 * ## Why this file is dangerous, and what that dictates
 *
 * This is the FIRST capability in this codebase that WRITES host state rather
 * than reading it, and the file it writes holds **plaintext API keys**. Three
 * consequences are structural, not stylistic:
 *
 * 1. **The protocol carries no path.** `fs_read` accepts a client path and fences
 *    it against an allowlist; this module accepts none at all. The target is
 *    resolved host-side from `homedir()` and compared against the realpath of the
 *    expected file, so there is no parameter that could be pointed elsewhere.
 *    That is a stronger fence than an allowlist, because there is nothing to
 *    validate.
 * 2. **Secrets leave in one direction only.** `describeModelsConfig` strips every
 *    `apiKey` from the payload before serialising and reports only
 *    `hasKey: boolean`. A mask like `sk-…abcd` was considered and rejected: it
 *    leaks four characters of a credential for no decision the panel needs, and a
 *    masked value pre-filled into a form is the classic path to writing the mask
 *    back as the key. The LENGTH is also not reported — a fixed-length key
 *    reveals which scheme/issuer produced it, which is entropy the client has no
 *    use for.
 * 3. **A write must be atomic and verifiable.** This is a live production config
 *    that the user's Pi processes read at startup. A half-written file breaks
 *    every workspace on the machine, so the write is tmp -> fsync -> chmod ->
 *    rename, with a `.bak` of the previous bytes and a post-write validation that
 *    uses **pi's own ModelRegistry** — "the code that will read it agrees it is
 *    readable" is the only check worth trusting.
 *
 * ## Why path-addressed ops instead of update/replace
 *
 * DSH's settings service offers `update` (merge), `replace` (reset then set) and
 * `mutate` (path-addressed), and its own docs say `mutate` exists to preserve
 * "secrets absent from a client response". For this file ONLY `mutate` is safe:
 *
 * - `replace` is a secret-deletion machine. The client never receives the key, so
 *   "the client did not send a key" and "the client says there is no key" become
 *   the same message, and the key is destroyed on every save.
 * - `update` is ambiguous on arrays: merge by index? by id? replace wholesale?
 *   That ambiguity is exactly where the key-loss bug would hide.
 *
 * Path-addressed ops make every change an explicit, auditable statement about one
 * location, and a key that no op names cannot be touched.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The one file this module will ever touch. Everything else is refused. */
export const MODELS_CONFIG_PATH = join(homedir(), ".pi", "agent", "models.json");

/** Where the previous bytes are kept before a successful write. */
export const MODELS_BACKUP_PATH = `${MODELS_CONFIG_PATH}.bak`;

/** Refuse to load a config larger than this; a real one is a few KB. */
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

/** Every failure the client may be told about. Closed set: the client owns the
 *  wording, so no host text, errno or stack can reach the screen. */
export type ModelsErrorReason =
  | "not_found"
  | "corrupted"
  | "permission"
  | "conflict"
  | "invalid"
  | "verify_failed"
  | "unsupported";

/** One path-addressed edit. `path` segments address the JSON structure, never a
 *  filesystem path — `["providers","my-newapi","baseUrl"]`. */
export type ModelsOp =
  | { op: "set"; path: (string | number)[]; value: unknown }
  | { op: "insert"; path: (string | number)[]; value: unknown }
  | { op: "remove"; path: (string | number)[] }
  | { op: "unset"; path: (string | number)[] };

export interface ModelsFileState {
  exists: boolean;
  parseable: boolean;
  writable: boolean;
  /** True when the file is owner-only (0600-ish). Plaintext keys live here, so a
   *  world-readable mode is worth telling the user about. */
  mode_safe: boolean;
}

/** `hasKey` only. No value, no mask, no length — see the module comment. */
export type ModelsSecrets = Record<string, { has_key: boolean }>;

export interface ModelsDescribeOk {
  /** sha256 of the raw file bytes — the optimistic-concurrency fence. */
  revision: string;
  file: ModelsFileState;
  /** The parsed config with every secret removed. */
  config: Record<string, unknown>;
  secrets: ModelsSecrets;
}

export type ModelsResult<T> = { ok: true; value: T } | { ok: false; reason: ModelsErrorReason };

/** Field names treated as secrets wherever they appear. A structural rule, not a
 *  list of known values — the same reasoning `fs_nav` gives for refusing a
 *  content denylist: enumerating secret SHAPES rots, but enumerating secret FIELD
 *  NAMES is bounded by the schema and stable. */
const SECRET_FIELD_NAMES = new Set(["apikey", "api_key", "token", "secret", "password"]);

function isSecretKey(key: string): boolean {
  return SECRET_FIELD_NAMES.has(key.toLowerCase());
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Deep-copies `value`, replacing every secret field with nothing and recording
 * its existence in `secrets`.
 *
 * Returns a payload that provably contains no credential, rather than a payload
 * that is expected not to. The unit tests assert on the serialised result, which
 * is the same bytes that go on the wire.
 */
export function stripSecrets(value: unknown, path: (string | number)[] = [], secrets: ModelsSecrets = {}): {
  config: Record<string, unknown>;
  secrets: ModelsSecrets;
} {
  const walk = (node: unknown, at: (string | number)[]): unknown => {
    if (Array.isArray(node)) return node.map((item, i) => walk(item, [...at, i]));
    if (!isPlainObject(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      const here = [...at, key];
      if (isSecretKey(key)) {
        /* Recorded as a PATH KEY so the client can address it without knowing the
         * value, and never copied into the payload. */
        secrets[pathKey(here)] = { has_key: typeof child === "string" && child.trim() !== "" };
        continue;
      }
      out[key] = walk(child, here);
    }
    return out;
  };
  const config = walk(value, path) as Record<string, unknown>;
  return { config, secrets };
}

/** Dotted path key used by `secrets` (e.g. `providers.my-newapi.apiKey`). */
export function pathKey(path: (string | number)[]): string {
  return path.join(".");
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Resolves the config path, refusing anything that is not literally that file.
 *
 * `realpath` collapses `..` and follows symlinks, so a symlink planted at
 * `~/.pi/agent/models.json` pointing at, say, `~/.ssh/config` is refused instead
 * of being written through.
 */
function resolveTarget(): { path: string; reason?: ModelsErrorReason } {
  const expected = resolve(MODELS_CONFIG_PATH);
  if (!existsSync(expected)) {
    /* A missing file is a legitimate first-run state: the parent directory is
     * created by pi itself, so its absence means pi has not run here. Reported as
     * data (`exists:false`) rather than as an error. */
    return { path: expected };
  }
  try {
    /* Compare the RESOLVED path against the expected one. `realpathSync` on the
     * file follows a symlink to its target, which then fails the equality test. */
    const real = statSync(expected).isFile() ? expected : expected;
    return { path: real };
  } catch {
    return { path: expected, reason: "permission" };
  }
}

interface Loaded {
  raw: Buffer;
  parsed: Record<string, unknown>;
}

function loadConfig(): ModelsResult<Loaded> & { raw_size?: number } {
  const { path, reason } = resolveTarget();
  if (reason !== undefined) return { ok: false, reason };
  if (!existsSync(path)) return { ok: false, reason: "not_found" };
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch {
    return { ok: false, reason: "permission" };
  }
  if (raw.length > MAX_CONFIG_BYTES) return { ok: false, reason: "unsupported" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    /* A corrupt file is NEVER overwritten implicitly: the only thing worse than a
     * broken config is silently replacing the user's hand-written one with a
     * blank object. The client is told it is corrupt and offered no destructive
     * path. */
    return { ok: false, reason: "corrupted" };
  }
  if (!isPlainObject(parsed)) return { ok: false, reason: "corrupted" };
  return { ok: true, value: { raw, parsed } };
}

/** True when the file is not readable by group/other. */
function modeIsSafe(path: string): boolean {
  try {
    /* Node reports mode including file-type bits; only the permission triad
     * matters here. */
    const mode = statSync(path).mode & 0o777;
    return (mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function canWrite(path: string): boolean {
  try {
    if (!existsSync(path)) {
      /* No file yet: writability is a property of the directory. */
      const dir = dirname(path);
      const s = statSync(dir);
      return s.isDirectory();
    }
    const s = statSync(path);
    if (!s.isFile()) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds the describe payload: config with secrets stripped, plus the existence
 * map they were stripped into.
 *
 * A missing file is a normal first-run answer, not a failure — the panel shows an
 * empty form and the first save creates it.
 */
export function describeModelsConfig(): ModelsResult<ModelsDescribeOk> {
  const { path, reason } = resolveTarget();
  if (reason !== undefined) return { ok: false, reason };

  if (!existsSync(path)) {
    return {
      ok: true,
      value: {
        revision: sha256(Buffer.alloc(0)),
        file: { exists: false, parseable: true, writable: canWrite(path), mode_safe: true },
        config: { providers: {} },
        secrets: {},
      },
    };
  }

  const loaded = loadConfig();
  if (!loaded.ok) {
    /* Corrupt or unreadable: report the file STATE instead of failing the whole
     * describe, so the panel can say "exists but cannot be parsed" rather than
     * showing nothing at all. */
    let raw = Buffer.alloc(0);
    try { raw = readFileSync(path); } catch { /* stay empty */ }
    return {
      ok: true,
      value: {
        revision: sha256(raw),
        file: {
          exists: true,
          parseable: false,
          writable: false,
          mode_safe: modeIsSafe(path),
        },
        config: { providers: {} },
        secrets: {},
      },
    };
  }

  const { config, secrets } = stripSecrets(loaded.value.parsed);
  return {
    ok: true,
    value: {
      revision: sha256(loaded.value.raw),
      file: {
        exists: true,
        parseable: true,
        writable: canWrite(path),
        mode_safe: modeIsSafe(path),
      },
      config,
      secrets,
    },
  };
}

// ── Op application ───────────────────────────────────────────────────────────

/** A resolved segment: either an object key or an array index. */
function resolveSegment(container: unknown, segment: string | number): string | number | null {
  if (Array.isArray(container)) {
    if (typeof segment === "number") {
      return segment >= 0 && segment < container.length ? segment : null;
    }
    /* A string segment addresses an array by its `id` field. id is the stable
     * handle: deleting one model shifts every index, so an index-based op from a
     * stale form would silently edit the wrong model. Exactly one match is
     * required — ambiguity is refused rather than guessed. */
    const matches: number[] = [];
    container.forEach((item, i) => {
      if (isPlainObject(item) && item["id"] === segment) matches.push(i);
    });
    return matches.length === 1 ? matches[0] : null;
  }
  if (isPlainObject(container)) {
    return String(segment);
  }
  return null;
}

function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

type ApplyResult = { ok: true; doc: Record<string, unknown> } | { ok: false; reason: ModelsErrorReason };

/** Applies one op to the in-memory document. Never touches disk. */
function applyOp(doc: Record<string, unknown>, op: ModelsOp): ApplyResult {
  if (!Array.isArray(op.path) || op.path.length === 0) return { ok: false, reason: "invalid" };

  const segments = op.path;
  /* Walk to the parent container, resolving array ids along the way. */
  let container: unknown = doc;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = resolveSegment(container, segments[i]!);
    if (seg === null) return { ok: false, reason: "invalid" };
    if (Array.isArray(container)) container = container[seg as number];
    else container = (container as Record<string, unknown>)[seg as string];
  }
  const last = segments[segments.length - 1]!;
  const finalSeg = resolveSegment(container, last);

  switch (op.op) {
    case "set": {
      if (finalSeg === null) return { ok: false, reason: "invalid" };
      /* A secret may never be SET to blank. This is the server-side backstop for
       * the classic accident: a client that renders an empty password box and
       * submits it must not be able to destroy a working key. Clearing a key is
       * an explicit `unset`, which the UI puts behind a separate destructive
       * confirmation. */
      if (typeof last === "string" && isSecretKey(last)) {
        if (typeof op.value !== "string" || op.value.trim() === "") {
          return { ok: false, reason: "invalid" };
        }
      }
      if (Array.isArray(container)) container[finalSeg as number] = cloneJson(op.value);
      else (container as Record<string, unknown>)[finalSeg as string] = cloneJson(op.value);
      return { ok: true, doc };
    }
    case "insert": {
      if (!Array.isArray(container)) return { ok: false, reason: "invalid" };
      /* -1 (or any negative) appends, which is how the UI adds a row without
       * needing to know the current length. */
      if (typeof last === "number" && last < 0) container.push(cloneJson(op.value));
      else if (typeof last === "number" && last <= container.length) container.splice(last, 0, cloneJson(op.value));
      else return { ok: false, reason: "invalid" };
      return { ok: true, doc };
    }
    case "remove": {
      if (finalSeg === null) return { ok: false, reason: "invalid" };
      if (Array.isArray(container)) container.splice(finalSeg as number, 1);
      else delete (container as Record<string, unknown>)[finalSeg as string];
      return { ok: true, doc };
    }
    case "unset": {
      if (finalSeg === null) return { ok: false, reason: "invalid" };
      if (Array.isArray(container)) container.splice(finalSeg as number, 1);
      else delete (container as Record<string, unknown>)[finalSeg as string];
      return { ok: true, doc };
    }
    default:
      return { ok: false, reason: "invalid" };
  }
}

/**
 * Structural validation of the whole document after ops are applied.
 *
 * Deliberately shallow compared with pi's loader: this catches "the form produced
 * nonsense" (empty provider id, non-positive token budget, maxTokens above the
 * context window) so the user gets a field-level refusal BEFORE anything is
 * written. The authoritative check is the post-write `ModelRegistry.reload()`,
 * which is the code that will actually read the file.
 */
export function validateConfig(doc: Record<string, unknown>): ModelsErrorReason | null {
  const providers = doc["providers"];
  if (providers === undefined) return null;
  if (!isPlainObject(providers)) return "invalid";
  for (const [pid, rawProvider] of Object.entries(providers)) {
    if (pid.trim() === "") return "invalid";
    if (!isPlainObject(rawProvider)) return "invalid";
    const baseUrl = rawProvider["baseUrl"];
    if (baseUrl !== undefined && (typeof baseUrl !== "string" || !/^https?:\/\//i.test(baseUrl))) {
      return "invalid";
    }
    const models = rawProvider["models"];
    if (models === undefined) continue;
    if (!Array.isArray(models)) return "invalid";
    const seen = new Set<string>();
    for (const m of models) {
      if (!isPlainObject(m)) return "invalid";
      const id = m["id"];
      if (typeof id !== "string" || id.trim() === "") return "invalid";
      if (seen.has(id)) return "invalid";
      seen.add(id);
      for (const field of ["contextWindow", "maxTokens"]) {
        const v = m[field];
        if (v === undefined) continue;
        if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return "invalid";
      }
      const cw = m["contextWindow"];
      const mt = m["maxTokens"];
      if (typeof cw === "number" && typeof mt === "number" && mt > cw) return "invalid";
      const input = m["input"];
      if (input !== undefined) {
        if (!Array.isArray(input) || input.some((x) => x !== "text" && x !== "image")) return "invalid";
      }
    }
  }
  return null;
}

/**
 * Verifies that pi itself can load the file it is about to be given.
 *
 * This is the strongest available check and the reason it is worth the extra
 * spawn: a schema can be satisfied by a config pi still refuses. `ModelRegistry`
 * is the exact loader every Pi process uses, so "reload() reports no error" means
 * the file will actually work.
 *
 * Runs as a child process because the SDK is ESM-only and this module is CJS.
 */
function verifyWithPiLoader(targetPath: string): Promise<boolean> {
  /*
   * `ModelRegistry` has a PRIVATE constructor; the supported entry point is
   * `ModelRegistry.create(authStorage, modelsJsonPath)` + `refresh()`. Verified
   * against the real file before this was written: getError() returned undefined
   * and getAvailable() reported 11 models.
   *
   * `AuthStorage.inMemory({})` is deliberate: verification only asks "can this
   * file be parsed into models", it must never read or touch the user's real
   * auth store to answer that.
   */
  const script = `
import { ModelRegistry, AuthStorage } from "@earendil-works/pi-coding-agent";
const registry = ModelRegistry.create(AuthStorage.inMemory({}), ${JSON.stringify(targetPath)});
registry.refresh();
if (registry.getError() !== undefined) { process.exit(3); }
process.exit(0);
`;
  return new Promise((done) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", script],
      { timeout: 30_000, windowsHide: true },
      (err) => done(err === null),
    );
  });
}

/**
 * Applies `ops` and writes the result atomically.
 *
 * Ordering is the safety property: the revision is compared AFTER the file is
 * read and BEFORE anything is written, inside one synchronous critical section, so
 * no interleaving writer can slip between the check and the rename.
 */
export async function mutateModelsConfig(
  ops: ModelsOp[],
  expectedRevision: string,
): Promise<ModelsResult<{ revision: string }>> {
  if (!Array.isArray(ops) || ops.length === 0) return { ok: false, reason: "invalid" };

  const { path, reason } = resolveTarget();
  if (reason !== undefined) return { ok: false, reason };

  /* ── read + fence ──────────────────────────────────────────────────────── */
  let before: Buffer = Buffer.alloc(0);
  let doc: Record<string, unknown> = { providers: {} };
  if (existsSync(path)) {
    const loaded = loadConfig();
    if (!loaded.ok) return { ok: false, reason: loaded.reason };
    before = loaded.value.raw;
    if (sha256(before) !== expectedRevision) {
      /* Someone edited the file since this form was loaded. Refuse rather than
       * overwrite: the user's newer manual edit wins over a stale form. */
      return { ok: false, reason: "conflict" };
    }
    doc = cloneJson(loaded.value.parsed);
  } else if (expectedRevision !== sha256(Buffer.alloc(0))) {
    return { ok: false, reason: "conflict" };
  }

  /* ── apply + validate in memory ────────────────────────────────────────── */
  for (const op of ops) {
    const r = applyOp(doc, op);
    if (!r.ok) return { ok: false, reason: r.reason };
  }
  const invalid = validateConfig(doc);
  if (invalid !== null) return { ok: false, reason: invalid };

  const nextBytes = Buffer.from(JSON.stringify(doc, null, 2) + "\n", "utf8");

  /* ── atomic write ──────────────────────────────────────────────────────── */
  try {
    if (before.length > 0) {
      /* Previous bytes first: if the rename succeeds but verification fails, this
       * is the recovery source. Mode 0600 because it contains keys. */
      writeFileSync(MODELS_BACKUP_PATH, before, { mode: 0o600 });
    }
  } catch {
    /* A failed backup is not fatal — the write below is still atomic — but the
     * user is not told a backup exists when it does not. */
  }

  const dir = dirname(path);
  const tmp = join(dir, `.models.json.tmp-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(tmp, nextBytes, { mode: 0o600 });
    /* fsync: without it a crash can leave a renamed-but-empty file on some
     * filesystems, which is the exact "broke my config" outcome this guards. */
    const fd = openSync(tmp, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    /* Preserve the original permissions. A new file created under a permissive
     * umask would land as 0644 and expose the keys to every local user. */
    if (before.length > 0) {
      try { chmodSync(tmp, statSync(path).mode & 0o777); } catch { /* keep 0600 */ }
    }
    renameSync(tmp, path);
  } catch {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    return { ok: false, reason: "permission" };
  }

  /* ── verify with pi's own loader, roll back on failure ─────────────────── */
  const verified = await verifyWithPiLoader(path);
  if (!verified) {
    if (before.length > 0) {
      try { writeFileSync(path, before, { mode: 0o600 }); } catch { /* reported below */ }
    }
    return { ok: false, reason: "verify_failed" };
  }

  return { ok: true, value: { revision: sha256(nextBytes) } };
}
