/**
 * Workspace catalogue state (plan/67: `workspace_list`, `workspace_start`,
 * `workspace_restart`, `workspace_add`).
 *
 * `seq` is a monotonic owner token: start/refresh/add/restart all write the SAME
 * busy flag, so only the newest owner may clear it. A superseded reply must not
 * touch the UI at all.
 */

import { useRef, useState } from "react";

export interface WorkspaceState {
  /** Filter text for the sidebar. Owned here because the sidebar renders it. */
  readonly query: string;
  readonly error: string | null;
  readonly busy: boolean;
}

export interface WorkspaceActions {
  readonly setQuery: (query: string) => void;
  readonly setError: (error: string | null) => void;
  readonly setBusy: (busy: boolean) => void;
  /** Monotonic owner token shared by every workspace mutation. */
  readonly seq: React.MutableRefObject<number>;
}

export interface WorkspaceStore {
  readonly state: WorkspaceState;
  readonly actions: WorkspaceActions;
}

export function useWorkspaceStore(): WorkspaceStore {
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  return {
    state: { query, error, busy },
    actions: { setQuery, setError, setBusy, seq },
  };
}
