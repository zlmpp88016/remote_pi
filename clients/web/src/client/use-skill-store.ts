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
import type { WirePackage } from "@/lib/remote-pi/protocol";

/** One in-flight `pi_surface`, correlated by (room + id). */
interface SurfaceRequest {
  id: string;
  room: string;
}

/** One in-flight package/skill mutation, correlated by (room + id).
 *  The host acks these with the generic action_ok/action_error, so the id is the
 *  only thing that ties a result to the row that started it. */
interface PendingMutation {
  id: string;
  room: string;
  /** Which mutation this is, so a confirmation can be attributed. */
  op?: "install" | "remove" | "update" | "set_enabled" | "skill";
}

interface InvokeRequest {
  id: string;
  room: string;
}

export interface SkillState {
  readonly byRoom: Record<string, readonly SkillOption[]>;
  /** Installed packages per room (`pi_surface_ok.packages`). An absent wire list
   *  is stored as an EMPTY array, so "this Pi has no packages" and "the host did
   *  not report any" render identically instead of one looking like a failure. */
  readonly packagesByRoom: Record<string, readonly WirePackage[]>;
  readonly busy: boolean;
  readonly notice: string | null;
}

export interface SkillActions {
  readonly setBusy: (busy: boolean) => void;
  readonly setNotice: (notice: string | null) => void;
  /** Records an install list for `room`. */
  readonly applySkills: (
    room: string,
    rows: readonly SkillOption[],
    packages: readonly WirePackage[],
  ) => void;
  /** Raw per-room package setter, for the container's projection step. */
  readonly setPackagesByRoom: (
    update: (
      prev: Record<string, readonly WirePackage[]>,
    ) => Record<string, readonly WirePackage[]>,
  ) => void;
  readonly surfaceReq: React.MutableRefObject<SurfaceRequest | null>;
  readonly invokeReq: React.MutableRefObject<InvokeRequest | null>;
  /**
   * The one in-flight package/skill mutation.
   *
   * Needed because the host answers these with the GENERIC action_ok /
   * action_error, not a dedicated frame. Without tracking the id, a failure
   * (untrusted project, bad source, npm error) had nothing to correlate to and
   * the panel stayed on "Installing…" forever, with every control disabled.
   */
  readonly packageReq: React.MutableRefObject<PendingMutation | null>;
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
  const [packagesByRoom, setPackagesByRoom] = useState<Record<string, readonly WirePackage[]>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const surfaceReq = useRef<SurfaceRequest | null>(null);
  const invokeReq = useRef<InvokeRequest | null>(null);
  const packageReq = useRef<PendingMutation | null>(null);
  const fetched = useRef<Set<string>>(new Set());

  return {
    state: { byRoom, packagesByRoom, busy, notice },
    actions: {
      setBusy,
      setNotice,
      applySkills: (room, rows, packages) => {
        setByRoom((prev) => ({ ...prev, [room]: rows }));
        setPackagesByRoom((prev) => ({ ...prev, [room]: packages }));
      },
      setPackagesByRoom,
      surfaceReq,
      invokeReq,
      packageReq,
      fetched,
      setByRoom,
    },
  };
}
