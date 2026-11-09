/**
 * Plan/67 — list AgentSessions for a workspace cwd via the public SDK.
 * Isolated so handlers stay fakeable (no SDK import).
 *
 * Passo 6: served through the SQLite index when it is available. The index is
 * a pure cache, so ANY problem with it degrades to the direct SDK call — a
 * broken cache means a slow list, never a wrong or empty one.
 */

import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ListedSession } from "./handlers.js";
import { lastIndexStats, listSessionsIndexed } from "./session_index.js";

/**
 * Direct SDK path — the reference behaviour, and the fallback when the index is
 * unusable. Exported so tests can pin the field mapping without the index in
 * the way: these assertions are about the SDK→wire contract, not about which
 * storage answered.
 */
export async function listWorkspaceSessionsDirect(cwd: string): Promise<ListedSession[]> {
  const rows = await SessionManager.list(cwd);
  return rows.map((s) => ({
    id: s.id,
    path: s.path,
    name: s.name,
    mtime: s.modified instanceof Date ? s.modified.getTime() : Number(s.modified),
    preview: s.firstMessage ? s.firstMessage.slice(0, 200) : undefined,
    cwd: s.cwd || cwd,
  }));
}

export async function listWorkspaceSessions(cwd: string): Promise<ListedSession[]> {
  try {
    const indexed = await listSessionsIndexed(cwd);
    if (indexed !== null) return indexed;
  } catch {
    // Fall through: the index must never be able to break the list.
  }
  return listWorkspaceSessionsDirect(cwd);
}

/** Exposed so a probe/test can report whether the last call used the index. */
export { lastIndexStats };

/** Pull cwd / session id / switchSession off a live ExtensionContext. */
export function sessionFieldsFromRaw(raw: unknown): {
  cwd?: string;
  switchSession?: (path: string, options?: object) => Promise<{ cancelled: boolean }>;
  getSessionId?: () => string | undefined;
  getSessionFile?: () => string | undefined;
} {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as {
    cwd?: string;
    switchSession?: (path: string, options?: object) => Promise<{ cancelled: boolean }>;
    sessionManager?: {
      getSessionId?: () => string;
      getSessionFile?: () => string | undefined;
    };
  };
  return {
    cwd: r.cwd,
    switchSession: r.switchSession,
    getSessionId: () => r.sessionManager?.getSessionId?.(),
    getSessionFile: () => r.sessionManager?.getSessionFile?.(),
  };
}
