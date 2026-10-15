import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeCwd } from "./registry.js";
import { defaultAgentName } from "../session/local_config.js";

/**
 * Plan/68 — the *added* workspace catalog.
 *
 * `daemons.json` is the supervisor's own fleet (folders promoted to always-on
 * daemons). This file is the complement: directories the user picked by
 * **navigating the host filesystem from the app** (or by starting a workspace
 * whose cwd was not registered yet). They are persisted so they survive a
 * restart and reappear in `workspace_list_ok` with `source: "added"`.
 *
 * Deliberate non-goal (reaffirmed in plan/68): we never scan the disk. The
 * catalog is exactly { registered daemons } ∪ { explicitly added workspaces }.
 *
 * Schema mirrors `daemons.json`: only the normalized absolute realpath is
 * stored, so two aliases of the same folder collapse to one entry.
 */

/** Resolved at call time so tests can override via `REMOTE_PI_HOME`. The
 *  prod path is always `~/.pi/remote/workspaces.json`. */
function workspacesPathInternal(): string {
  const root = process.env["REMOTE_PI_HOME"] || homedir();
  return join(root, ".pi", "remote", "workspaces.json");
}

export interface WorkspaceRegistry {
  workspaces: Array<{ cwd: string }>;
}

/** Reads the catalog, returning an empty one when the file is absent/corrupt. */
export function loadWorkspaces(): WorkspaceRegistry {
  if (!existsSync(workspacesPathInternal())) return { workspaces: [] };
  try {
    const parsed = JSON.parse(readFileSync(workspacesPathInternal(), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return { workspaces: [] };
    const arr = (parsed as { workspaces?: unknown }).workspaces;
    if (!Array.isArray(arr)) return { workspaces: [] };
    const workspaces: Array<{ cwd: string }> = [];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const cwd = (item as { cwd?: unknown }).cwd;
      if (typeof cwd === "string" && cwd.length > 0) workspaces.push({ cwd });
    }
    return { workspaces };
  } catch {
    return { workspaces: [] };
  }
}

export function saveWorkspaces(reg: WorkspaceRegistry): void {
  mkdirSync(dirname(workspacesPathInternal()), { recursive: true });
  writeFileSync(workspacesPathInternal(), JSON.stringify(reg, null, 2) + "\n");
}

/**
 * Adds a workspace by raw path (expands `~`, resolves + realpaths). Idempotent:
 * adding a cwd that is already present is a no-op rather than an error — the
 * caller (fs navigation) can add the same folder twice without failing.
 * Returns the normalized cwd and whether it was newly inserted.
 */
export function addWorkspace(rawCwd: string): { cwd: string; added: boolean } {
  const cwd = normalizeCwd(rawCwd);
  const reg = loadWorkspaces();
  if (reg.workspaces.some((w) => w.cwd === cwd)) return { cwd, added: false };
  reg.workspaces.push({ cwd });
  saveWorkspaces(reg);
  return { cwd, added: true };
}

/**
 * Removes the added workspace whose normalized cwd matches `path`. Never
 * touches `daemons.json` — a registered daemon stays registered. Returns
 * whether an entry was removed.
 *
 * Normalization is best-effort here: unlike `add`, a stored workspace may
 * point at a directory that has since been deleted, and `normalizeCwd`
 * realpaths (which would throw). Falling back to the trimmed input lets the
 * user still clean up a stale entry.
 */
export function removeWorkspace(rawCwd: string): { cwd: string; removed: boolean } {
  let cwd = rawCwd.trim();
  try {
    cwd = normalizeCwd(rawCwd);
  } catch {
    /* directory gone — match the literal stored form below */
  }
  const reg = loadWorkspaces();
  const idx = reg.workspaces.findIndex((w) => w.cwd === cwd);
  if (idx === -1) return { cwd, removed: false };
  reg.workspaces.splice(idx, 1);
  saveWorkspaces(reg);
  return { cwd, removed: true };
}

/** Snapshot of the added workspaces (normalized cwds, insertion order). */
export function listWorkspaces(): Array<{ cwd: string; name: string }> {
  return loadWorkspaces().workspaces.map((w) => ({
    cwd: w.cwd,
    // Folder-derived display name; added workspaces carry no explicit name.
    name: defaultAgentName(w.cwd),
  }));
}

/** Test/diag-only: on-disk path. */
export function workspacesPath(): string {
  return workspacesPathInternal();
}
