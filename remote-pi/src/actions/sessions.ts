/**
 * Plan/67 — list AgentSessions for a workspace cwd via the public SDK.
 * Isolated so handlers stay fakeable (no SDK import).
 */

import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ListedSession } from "./handlers.js";

export async function listWorkspaceSessions(cwd: string): Promise<ListedSession[]> {
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
