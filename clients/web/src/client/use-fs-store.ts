/**
 * Filesystem dock state (`fs_list` → `fs_list_ok`, plus the `show_hidden` flag).
 *
 * `seq` is a monotonic owner token: a superseded `fs.list` reply must not touch
 * the UI, so each request captures `++seq` and only the newest may commit.
 */

import { useRef, useState } from "react";

import type { FsEntry } from "@/lib/remote-pi/protocol";

export interface FsState {
  readonly path: string;
  readonly entries: readonly FsEntry[];
  readonly parent: string | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly loaded: boolean;
  /** Hidden entries are opt-in on the wire (`fs_list {show_hidden}`); the dock
   *  owns the checkbox and this is the only place the flag is stored. */
  readonly showHidden: boolean;
}

export interface FsActions {
  readonly setPath: (path: string) => void;
  readonly setParent: (parent: string | null) => void;
  readonly setLoading: (loading: boolean) => void;
  readonly setError: (error: string | null) => void;
  readonly setShowHidden: (showHidden: boolean) => void;
  /** Records a listing: entries + the parent the host reported. */
  readonly applyListing: (entries: readonly FsEntry[], parent: string | null) => void;
  readonly reset: () => void;
  /** Monotonic owner token for `fs.list`. */
  readonly seq: React.MutableRefObject<number>;
  /** Raw entries setter, for the container's incremental load path. */
  readonly setEntries: (entries: readonly FsEntry[]) => void;
  /** Raw `loaded` setter. */
  readonly setLoaded: (loaded: boolean) => void;
}

export interface FsStore {
  readonly state: FsState;
  readonly actions: FsActions;
}

export function useFsStore(): FsStore {
  const [path, setPath] = useState("~");
  const [entries, setEntries] = useState<readonly FsEntry[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const seq = useRef(0);

  const applyListing = (next: readonly FsEntry[], nextParent: string | null) => {
    setEntries(next);
    setParent(nextParent);
    setLoaded(true);
    setLoading(false);
    setError(null);
  };

  const reset = () => {
    setEntries([]);
    setParent(null);
    setLoaded(false);
    setLoading(false);
    setError(null);
  };

  return {
    state: { path, entries, parent, loading, error, loaded, showHidden },
    actions: {
      setPath,
      setParent,
      setLoading,
      setError,
      setShowHidden,
      applyListing,
      reset,
      seq,
      setEntries,
      setLoaded,
    },
  };
}
