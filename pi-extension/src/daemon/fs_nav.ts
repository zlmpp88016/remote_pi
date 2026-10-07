import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
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
