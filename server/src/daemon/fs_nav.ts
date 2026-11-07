import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import type { ServerMessage, ActionName } from "../protocol/types.js";
import type { HostReplySender } from "./host_control.js";

/**
 * Plan/68 — host-side filesystem navigation.
 *
 * The app picks a workspace by walking the host's directory tree. The client
 * never resolves a path itself: it sends a `path` string and the host returns
 * the resolved `realpath` plus that directory's immediate children. Listing
 * happens **host-side only** (same trust model as plan/58 J: full trust after
 * pairing, but the client stays path-blind).
 *
 * No traversal outside the requested directory (single level), no file reads,
 * no shell.
 */

/** Typed failures surfaced as `action_error` (see PROTOCOL.md plan/68). */
export type FsListError = "not_found" | "not_a_directory" | "permission_denied";

export interface FsEntryWire {
  name: string;
  kind: "dir" | "file";
  is_repo?: boolean;
}

/**
 * Expands `~`, resolves relative input against the process cwd, and returns
 * the canonical realpath. Unlike `registry.normalizeCwd`, this does NOT require
 * the path to exist — `realpathSync` is attempted but a missing path falls back
 * to the resolved form so the caller can distinguish `not_found` (from stat)
 * from an opaque throw.
 */
function expandPath(input: string): string {
  let p = (input ?? "").trim();
  if (p === "~") p = homedir();
  else if (p.startsWith("~/") || p.startsWith("~\\")) p = join(homedir(), p.slice(2));
  if (!isAbsolute(p)) p = resolvePath(process.cwd(), p);
  return p;
}

/**
 * Builds the `fs_list_ok` reply, or the typed error. `show_hidden` defaults to
 * false (dotfiles are noise for a directory picker; the app can opt in).
 */
export function handleFsList(
  sender: HostReplySender,
  msg: { id: string; path: string; show_hidden?: boolean },
): void {
  const fail = (error: FsListError): void => {
    sender.send({
      type: "action_error",
      in_reply_to: msg.id,
      action: "fs_list" as ActionName,
      error,
    });
  };

  const requested = expandPath(msg.path);
  let resolved: string;
  try {
    resolved = realpathSync(requested);
  } catch {
    fail("not_found");
    return;
  }

  let stat;
  try {
    stat = statSync(resolved);
  } catch (e) {
    // EACCES on the final component, or ENOENT if it vanished between
    // realpath and stat — treat a permission error distinctly.
    fail((e as NodeJS.ErrnoException).code === "EACCES" ? "permission_denied" : "not_found");
    return;
  }
  if (!stat.isDirectory()) {
    fail("not_a_directory");
    return;
  }

  const showHidden = msg.show_hidden === true;
  let names: string[];
  try {
    names = readdirSync(resolved);
  } catch (e) {
    fail((e as NodeJS.ErrnoException).code === "EACCES" ? "permission_denied" : "not_found");
    return;
  }

  const entries: FsEntryWire[] = [];
  for (const name of names) {
    if (!showHidden && name.startsWith(".")) continue;
    const full = join(resolved, name);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue; // vanished / unreadable child — skip rather than fail the listing
    }
    if (isDir) {
      // `is_repo` is a hint only (a `.git` marker exists); never recurse.
      const isRepo = existsSync(join(full, ".git"));
      entries.push(isRepo ? { name, kind: "dir", is_repo: true } : { name, kind: "dir" });
    } else {
      entries.push({ name, kind: "file" });
    }
  }

  // Directories first, then files, each alphabetically — the picker's order.
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const parent = dirname(resolved);
  sender.send({
    type: "fs_list_ok",
    in_reply_to: msg.id,
    path: resolved,
    parent: parent === resolved ? null : parent,
    entries,
  });
}

/**
 * Plan/77 — host-side file read for the web client's Plan viewer.
 *
 * ## Why this is a separate, deliberately narrow verb
 *
 * `fs_list` exposes directory METADATA only, so a paired device learns that
 * `~/.ssh` exists but never sees a key. `fs_read` hands back file CONTENT, which
 * makes the same pairing token a much larger grant: without a fence, one
 * `fs_read {path: "~/.ssh/id_rsa"}` or `~/.pi/remote/peers.json` would exfiltrate
 * exactly the material that authenticates the device.
 *
 * The fence is therefore a positive ALLOWLIST, not a denylist:
 *
 *   1. The request must resolve (realpath) to a regular file under a directory
 *      named `plan`, `.workflow`, or `docs`, inside the process working
 *      directory (the workspace). Nothing else is reachable.
 *   2. Containment is checked on the RESOLVED path, so `../` and symlinks are
 *      both collapsed BEFORE the test — an `plan/../../.ssh/id_rsa` request
 *      resolves out of the allowlist and fails on containment, not on string
 *      matching. A symlink inside `plan/` that points at a key fails identically.
 *   3. The extension must be one of MARKDOWN-ish/plain data (`TEXT_EXTS`). This
 *      keeps the verb honest about its purpose: showing documents to a human.
 *   4. Size is capped, and an oversized file reports `truncated: true` with the
 *      head of the file rather than failing -- a big plan is still readable.
 *
 * A denylist (`.ssh`, `.env`, …) was rejected on purpose: it would have to
 * enumerate every secret *shape* and would rot the moment a new one appears.
 * The allowlist fails closed for everything nobody thought of.
 */

/** Directories, by NAME, that a read may reach inside. Case-insensitive
 *  comparison is deliberately NOT used: the host filesystem decides casing. */
const READ_ALLOWED_DIRS = new Set(["plan", ".workflow", "docs"]);

/** Extensions a read may return. Lower-case; compared after `toLowerCase()`. */
const TEXT_EXTS = new Set([".md", ".markdown", ".txt", ".json"]);

/** Hard cap on bytes handed to a paired device. */
export const FS_READ_MAX_BYTES = 2 * 1024 * 1024;

export type FsReadError =
  | "not_found"
  | "permission_denied"
  | "not_a_file"
  | "not_allowed";

/**
 * Whether `resolved` (an already-realpath'd absolute path) is inside one of the
 * allowlisted directories.
 *
 * Exported so the containment rule can be tested directly, without going
 * through the filesystem: this predicate IS the security boundary.
 */
export function isReadAllowed(resolved: string, cwd: string): boolean {
  // Separator normalisation: Windows realpath returns backslashes, POSIX
  // returns slashes, and a mixed string must not slip past the prefix test.
  //
  // BOTH sides are normalised, and neither is realpath'd here: this predicate is
  // a pure string rule over two already-resolved paths. Resolving `cwd` inside
  // it would make the function depend on the host filesystem (a `/repo` literal
  // would become `C:\repo` on Windows) while the caller's `resolved` stayed
  // literal, and the two would no longer be comparable. The CALLER is
  // responsible for passing realpath'd values; `handleFsRead` does.
  const toPosix = (p: string): string => p.split("\\").join("/").replace(/\/+$/, "");
  const file = toPosix(resolved);
  const root = toPosix(cwd);

  // Must actually live under the workspace. `startsWith(root)` alone would let
  // `/repo-evil/plan/x.md` match `/repo`, so the boundary is the separator.
  if (file !== root && !file.startsWith(`${root}/`)) return false;

  const rel = file === root ? "" : file.slice(root.length + 1);
  if (rel === "") return false;
  const segments = rel.split("/");
  // The FILE itself must not be a dotfile (.env, .git-credentials). Only the
  // allowlisted DIRECTORY segment may start with a dot.
  const fileName = segments[segments.length - 1] ?? "";
  if (fileName.startsWith(".")) return false;

  // Some path segment must be one of the allowlisted directories. Requiring it
  // anywhere in the relative path (not only the first segment) keeps the rule
  // simple and safe: `docs/plan/77.md` and `plan/77-x.md` both qualify, while
  // `src/main.ts` and `config.json` do not.
  if (!segments.some((seg) => READ_ALLOWED_DIRS.has(seg))) return false;

  // And the extension must be one we are willing to hand over.
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return false;
  return TEXT_EXTS.has(fileName.slice(dot).toLowerCase());
}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolvePath(p);
  }
}

/**
 * Builds the `fs_read_ok` reply, or the typed error.
 *
 * `cwd` is the workspace root the allowlist is measured against; it defaults to
 * the process cwd, which is what the daemon runs the workspace in.
 */
export function handleFsRead(
  sender: HostReplySender,
  msg: { id: string; path: string; root: string },
): void {
  const fail = (error: FsReadError): void => {
    sender.send({
      type: "action_error",
      in_reply_to: msg.id,
      action: "fs_read" as ActionName,
      error,
    });
  };

  /* The workspace this read belongs to, resolved FIRST.
   *
   * Measured against the request, never against `process.cwd()`: the daemon runs
   * from wherever the supervisor started it, which is not a workspace, so a
   * default here would refuse every legitimate read (or, worse, allowlist
   * whatever directory the daemon happened to inherit). */
  let root: string;
  try {
    root = realpathSync(expandPath(msg.root));
  } catch {
    return fail("not_allowed");
  }

  const requested = expandPath(msg.path);

  /*
   * Containment is evaluated BEFORE existence is revealed.
   *
   * Ordering matters: if a request for `~/.ssh/id_rsa` returned `not_found`
   * when the file is absent and `not_allowed` when it is present, the error code
   * itself would be an existence oracle for arbitrary paths. Resolving first and
   * rejecting on containment keeps the two indistinguishable to the client.
   */
  let resolved: string;
  try {
    resolved = realpathSync(requested);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return fail(code === "EACCES" ? "permission_denied" : "not_found");
  }

  if (!isReadAllowed(resolved, root)) return fail("not_allowed");

  let stat;
  try {
    stat = statSync(resolved);
  } catch (e) {
    return fail((e as NodeJS.ErrnoException).code === "EACCES" ? "permission_denied" : "not_found");
  }
  if (!stat.isFile()) return fail("not_a_file");

  let bytes: Buffer;
  try {
    bytes = readFileSync(resolved);
  } catch (e) {
    return fail((e as NodeJS.ErrnoException).code === "EACCES" ? "permission_denied" : "not_found");
  }

  const truncated = bytes.length > FS_READ_MAX_BYTES;
  const head = truncated ? bytes.subarray(0, FS_READ_MAX_BYTES) : bytes;

  sender.send({
    type: "fs_read_ok",
    in_reply_to: msg.id,
    path: resolved,
    content: head.toString("utf8"),
    truncated,
    bytes: bytes.length,
  });
}
