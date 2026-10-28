/**
 * Skills surface state (plan/68: `pi_surface` → `pi_surface_ok{skills}`,
 * `skill_invoke` → `skill_invoke_ok` | `action_error`).
 *
 * Per room, like the model catalogue: two workspaces are two different Pi
 * installs, so their skill lists must never be mixed.
 *
 * The `fetched` set is a REF, not state: asking a room once per connection is
 * bookkeeping, not something the UI renders. A skill RUNNING does not change the
 * install list, so one fetch per room is enough.
 */

import { useRef, useState } from "react";

import type { SkillOption } from "@/components/remote-pi/chat";

/** One in-flight `pi_surface`, correlated by (room + id). */
interface SurfaceRequest {
  id: string;
  room: string;
}

/** One in-flight `skill_invoke`, correlated by (room + id). */
interface InvokeRequest {
  id: string;
  room: string;
}

export interface SkillState {
  readonly byRoom: Record<string, readonly SkillOption[]>;
  readonly busy: boolean;
  readonly notice: string | null;
}

export interface SkillActions {
  readonly setBusy: (busy: boolean) => void;
  readonly setNotice: (notice: string | null) => void;
  /** Records an install list for `room`. */
  readonly applySkills: (room: string, rows: readonly SkillOption[]) => void;
  readonly surfaceReq: React.MutableRefObject<SurfaceRequest | null>;
  readonly invokeReq: React.MutableRefObject<InvokeRequest | null>;
  /** Rooms already asked on this connection. */
  readonly fetched: React.MutableRefObject<Set<string>>;
  /** Raw per-room setter, for the container's projection step. */
  readonly setByRoom: (
    update: (prev: Record<string, readonly SkillOption[]>) => Record<string, readonly SkillOption[]>,
  ) => void;
}

export interface SkillStore {
  readonly state: SkillState;
  readonly actions: SkillActions;
}

export function useSkillStore(): SkillStore {
  const [byRoom, setByRoom] = useState<Record<string, readonly SkillOption[]>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const surfaceReq = useRef<SurfaceRequest | null>(null);
  const invokeReq = useRef<InvokeRequest | null>(null);
  const fetched = useRef<Set<string>>(new Set());

  return {
    state: { byRoom, busy, notice },
    actions: {
      setBusy,
      setNotice,
      applySkills: (room, rows) => setByRoom((prev) => ({ ...prev, [room]: rows })),
      surfaceReq,
      invokeReq,
      fetched,
      setByRoom,
    },
  };
}
