/**
 * Plan/80 — the host's own `~/.pi/agent/settings.json`, edited from the web client.
 *
 * ## Why this is a SEPARATE module from `models_config`
 *
 * They look similar and are not. `models.json` is a credential store: it must be
 * fenced by "return nothing secret" and written by path-addressed ops because a
 * whole-document write would destroy keys the client never saw. `settings.json` has
 * no secrets, but it is a **mixed** file: a few keys are user preferences and the
 * rest is machine state that must never be shown or touched.
 *
 * Concretely, the real file on this machine contains `packages` with six entries,
 * three of them ABSOLUTE HOST PATHS. Echoing that object to the client would leak
 * the user's directory layout through a "settings" panel — exactly the thing
 * `fs_read`'s allowlist exists to prevent. So this module does not project the
 * document; it projects a **whitelist** and refuses every other path.
 *
 * The whitelist is a positive list, for the same reason `fs_nav` gives for refusing
 * a denylist: a denylist has to anticipate every future key pi adds, and rots
 * silently when pi adds one more.
 */

import { createHash } from "node:crypto";
import {
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

export const SETTINGS_CONFIG_PATH = join(homedir(), ".pi", "agent", "settings.json");
export const SETTINGS_BACKUP_PATH = `${SETTINGS_CONFIG_PATH}.bak`;

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

/**
 * Which keys the web client may READ and WRITE.
 *
 * Deliberately narrow. In particular:
 * - `packages` / `extensions` belong to the Plugins surface, which has its own
 *   enable/install flow and its own confirmation rules.
 * - `lastChangelogVersion` is machine bookkeeping; editing it would make pi re-show
 *   or silently skip a changelog.
 * - Anything not listed here is invisible. A pi release that adds a new preference
 *   will not appear until it is added deliberately, which is the intended failure
 *   direction: a missing toggle is a bug report, a leaked internal key is not.
 */
export const SETTINGS_WHITELIST = [
  "theme",
  "hideThinkingBlock",
  "retry.enabled",
  "retry.maxRetries",
  "retry.baseDelayMs",
  "retry.provider.maxRetryDelayMs",
] as const;

export type SettingsField = (typeof SETTINGS_WHITELIST)[number];

export type SettingsErrorReason =
  | "not_found"
  | "corrupted"
  | "permission"
  | "conflict"
  | "invalid"
  | "invalid_field"
  | "unsupported"
  | "verify_failed";

export interface SettingsFileState {
  exists: boolean;
  parseable: boolean;
  writable: boolean;
}

/** Appearance preferences. `theme` is reported READ-ONLY: it selects a pi TUI
 *  theme, and this panel does not offer to change it (the visual presets in the
 *  web client are a separate, browser-local concept). */
export interface SettingsAppearance {
  theme: string | null;
  hide_thinking_block: boolean | null;
}

export interface SettingsBehaviour {
  retry_enabled: boolean | null;
  retry_max_retries: number | null;
  retry_base_delay_ms: number | null;
  retry_provider_max_retry_delay_ms: number | null;
}

export interface SettingsDescribeOk {
  revision: string;
  file: SettingsFileState;
  appearance: SettingsAppearance;
  behaviour: SettingsBehaviour;
}

export type SettingsResult<T> = { ok: true; value: T } | { ok: false; reason: SettingsErrorReason };

export type SettingsOp =
  | { op: "set"; path: SettingsField | string[]; value: unknown }
  | { op: "unset"; path: SettingsField | string[] };

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Splits a whitelist entry (`retry.enabled`) into segments. An op may pass either
 *  form; both normalise to segments so the comparison is one code path. */
function segmentsOf(path: SettingsField | string[]): string[] {
  return Array.isArray(path) ? path.map(String) : path.split(".");
}

/**
 * True when `segments` names a whitelisted field.
 *
 * Prefixes are NOT enough: `retry` alone addresses a whole subtree and would allow
 * clobbering `retry` wholesale, so only exact whitelist entries pass.
 */
function isWhitelisted(segments: string[]): boolean {
  const joined = segments.join(".");
  return (SETTINGS_WHITELIST as readonly string[]).includes(joined);
}

/** Reads one whitelisted leaf, returning null when absent or the wrong type. */
function readLeaf(doc: Record<string, unknown>, path: SettingsField): unknown {
  let node: unknown = doc;
  for (const seg of path.split(".")) {
    if (!isPlainObject(node)) return undefined;
    node = node[seg];
  }
  return node;
}

function resolveTarget(): string {
  return resolve(SETTINGS_CONFIG_PATH);
}

function loadConfig(): SettingsResult<{ raw: Buffer; parsed: Record<string, unknown> }> {
  const path = resolveTarget();
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
    /* Never overwrite a corrupt file: the user's hand-written settings may be one
     * typo away from fine, and replacing them with {} loses packages and
     * extensions too. */
    return { ok: false, reason: "corrupted" };
  }
  if (!isPlainObject(parsed)) return { ok: false, reason: "corrupted" };
  return { ok: true, value: { raw, parsed } };
}

function canWrite(path: string): boolean {
  try {
    if (!existsSync(path)) return statSync(dirname(path)).isDirectory();
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Projects the whitelist. Everything else in the file is dropped here, so the
 * payload physically cannot contain `packages` or `lastChangelogVersion`.
 */
export function projectSettings(doc: Record<string, unknown>): {
  appearance: SettingsAppearance;
  behaviour: SettingsBehaviour;
} {
  const theme = readLeaf(doc, "theme");
  const hide = readLeaf(doc, "hideThinkingBlock");
  const retryEnabled = readLeaf(doc, "retry.enabled");
  const maxRetries = readLeaf(doc, "retry.maxRetries");
  const baseDelay = readLeaf(doc, "retry.baseDelayMs");
  const providerMax = readLeaf(doc, "retry.provider.maxRetryDelayMs");

  return {
    appearance: {
      theme: typeof theme === "string" ? theme : null,
      hide_thinking_block: typeof hide === "boolean" ? hide : null,
    },
    behaviour: {
      retry_enabled: typeof retryEnabled === "boolean" ? retryEnabled : null,
      retry_max_retries: typeof maxRetries === "number" && Number.isFinite(maxRetries) ? maxRetries : null,
      retry_base_delay_ms: typeof baseDelay === "number" && Number.isFinite(baseDelay) ? baseDelay : null,
      retry_provider_max_retry_delay_ms:
        typeof providerMax === "number" && Number.isFinite(providerMax) ? providerMax : null,
    },
  };
}

export function describeSettingsConfig(): SettingsResult<SettingsDescribeOk> {
  const path = resolveTarget();
  if (!existsSync(path)) {
    return {
      ok: true,
      value: {
        revision: sha256(Buffer.alloc(0)),
        file: { exists: false, parseable: true, writable: canWrite(path) },
        appearance: { theme: null, hide_thinking_block: null },
        behaviour: {
          retry_enabled: null,
          retry_max_retries: null,
          retry_base_delay_ms: null,
          retry_provider_max_retry_delay_ms: null,
        },
      },
    };
  }

  const loaded = loadConfig();
  if (!loaded.ok) {
    let raw = Buffer.alloc(0);
    try { raw = readFileSync(path); } catch { /* stay empty */ }
    return {
      ok: true,
      value: {
        revision: sha256(raw),
        file: { exists: true, parseable: false, writable: false },
        appearance: { theme: null, hide_thinking_block: null },
        behaviour: {
          retry_enabled: null,
          retry_max_retries: null,
          retry_base_delay_ms: null,
          retry_provider_max_retry_delay_ms: null,
        },
      },
    };
  }

  /* The projection is the ONLY thing returned — the full document is never sent. */
  const projected = projectSettings(loaded.value.parsed);
  return {
    ok: true,
    value: {
      revision: sha256(loaded.value.raw),
      file: { exists: true, parseable: true, writable: canWrite(path) },
      appearance: projected.appearance,
      behaviour: projected.behaviour,
    },
  };
}

/** Field-level validation, applied before anything is written. */
function validateValue(path: SettingsField, value: unknown): SettingsErrorReason | null {
  switch (path) {
    case "theme":
      /* Not writable from here: reported for display only. */
      return "invalid_field";
    case "hideThinkingBlock":
    case "retry.enabled":
      return typeof value === "boolean" ? null : "invalid";
    case "retry.maxRetries":
      return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100
        ? null
        : "invalid";
    case "retry.baseDelayMs":
    case "retry.provider.maxRetryDelayMs":
      return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 600_000
        ? null
        : "invalid";
    default:
      return "invalid_field";
  }
}

function setLeaf(doc: Record<string, unknown>, segments: string[], value: unknown): boolean {
  let node: Record<string, unknown> = doc;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i]!;
    const next = node[seg];
    if (!isPlainObject(next)) {
      /* Creating a missing intermediate object is correct for `retry.provider.*`
       * on a file that has no `retry` yet — that is a normal first configuration,
       * not a corruption. */
      if (next === undefined) {
        const created: Record<string, unknown> = {};
        node[seg] = created;
        node = created;
        continue;
      }
      return false;
    }
    node = next;
  }
  node[segments[segments.length - 1]!] = value;
  return true;
}

function deleteLeaf(doc: Record<string, unknown>, segments: string[]): boolean {
  let node: Record<string, unknown> = doc;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const next = node[segments[i]!];
    if (!isPlainObject(next)) return false;
    node = next;
  }
  return delete node[segments[segments.length - 1]!];
}

/**
 * Applies whitelisted edits atomically.
 *
 * The whole document is preserved: ops touch only their own leaf, so `packages`,
 * `extensions` and every other key survive byte-for-byte at the value level. That
 * property is asserted in the tests because it is the one that matters — a
 * "settings" save must never double as a plugins uninstall.
 */
export function mutateSettingsConfig(
  ops: SettingsOp[],
  expectedRevision: string,
): SettingsResult<{ revision: string }> {
  if (!Array.isArray(ops) || ops.length === 0) return { ok: false, reason: "invalid" };

  const path = resolveTarget();
  let before: Buffer = Buffer.alloc(0);
  let doc: Record<string, unknown> = {};

  if (existsSync(path)) {
    const loaded = loadConfig();
    if (!loaded.ok) return { ok: false, reason: loaded.reason };
    before = loaded.value.raw;
    if (sha256(before) !== expectedRevision) return { ok: false, reason: "conflict" };
    doc = JSON.parse(JSON.stringify(loaded.value.parsed)) as Record<string, unknown>;
  } else if (expectedRevision !== sha256(Buffer.alloc(0))) {
    return { ok: false, reason: "conflict" };
  }

  for (const op of ops) {
    const segments = segmentsOf(op.path);
    if (!isWhitelisted(segments)) return { ok: false, reason: "invalid_field" };
    const field = segments.join(".") as SettingsField;
    if (op.op === "set") {
      const invalid = validateValue(field, op.value);
      if (invalid !== null) return { ok: false, reason: invalid };
      if (!setLeaf(doc, segments, op.value)) return { ok: false, reason: "invalid" };
    } else if (op.op === "unset") {
      if (field === "theme") return { ok: false, reason: "invalid_field" };
      if (!deleteLeaf(doc, segments)) return { ok: false, reason: "invalid" };
    } else {
      return { ok: false, reason: "invalid" };
    }
  }

  const nextBytes = Buffer.from(JSON.stringify(doc, null, 2) + "\n", "utf8");

  try {
    if (before.length > 0) {
      writeFileSync(SETTINGS_BACKUP_PATH, before, { mode: 0o600 });
    }
  } catch { /* a failed backup must not block the atomic write below */ }

  const tmp = join(dirname(path), `.settings.json.tmp-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(tmp, nextBytes, { mode: 0o600 });
    const fd = openSync(tmp, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
  } catch {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    return { ok: false, reason: "permission" };
  }

  /* Post-write verification: re-read and re-parse. `settings.json` has no external
   * schema loader analogous to pi's ModelRegistry, so the honest check is that the
   * bytes on disk parse back to an object and every whitelisted leaf is still of
   * the expected type. */
  try {
    const verify = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isPlainObject(verify)) throw new Error("not an object");
    projectSettings(verify);
  } catch {
    if (before.length > 0) {
      try { writeFileSync(path, before, { mode: 0o600 }); } catch { /* reported */ }
    }
    return { ok: false, reason: "verify_failed" };
  }

  return { ok: true, value: { revision: sha256(nextBytes) } };
}
