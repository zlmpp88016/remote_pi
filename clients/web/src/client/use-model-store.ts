/**
 * Model surface state (PROTOCOL.md "App actions": `list_models` → `models_list`,
 * `model_set` / `thinking_set` → `action_ok` | `action_error`).
 *
 * WHY PER ROOM: every one of those actions addresses ONE workspace Pi, so its
 * catalogue, confirmed pick and thinking level are keyed by that room. A single
 * shared value would label the room you switched to with the previous room's
 * model — and clearing it instead would lose a pick you already made.
 *
 * `busy` and `switchTo` are deliberately SEPARATE:
 *   • `busy`  — a `list_models` round trip is in flight, the picker has nothing
 *               to show yet;
 *   • `switchTo` — a `model_set` is in flight; the rows are already known, so
 *               the picker stays usable and only marks which model is being
 *               switched to. Collapsing the two is what made picking a model
 *               look like a freeze.
 */

import { useRef, useState } from "react";

import type { ModelOption, ThinkingLevelId } from "@/components/remote-pi/chat";
import type { ConfirmedModel } from "./notices";

/** The model being switched TO, carried from the row the user clicked so the
 *  thinking control reflects the PICKED model immediately. */
export interface ModelSwitchTarget {
  name: string;
  reasoning: boolean;
}

/** One in-flight `list_models`, correlated by (room + id). */
interface ListRequest {
  id: string;
  room: string;
  kind: "list";
}

/** One in-flight `model_set`, correlated by (room + id). */
interface SetRequest {
  id: string;
  room: string;
}

/** One in-flight `thinking_set`, correlated by (room + id). */
interface ThinkingRequest {
  id: string;
  room: string;
}

/** The row the user picked, held until the Pi answers `action_ok`. */
export interface PendingModelChoice {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  vision: boolean;
}

export interface ModelState {
  readonly busy: boolean;
  readonly switchTo: ModelSwitchTarget | null;
  readonly notice: string | null;
  readonly optionsByRoom: Record<string, readonly ModelOption[]>;
  readonly thinkingByRoom: Record<string, ThinkingLevelId>;
  /** The last selection the HOST ACKNOWLEDGED, per room. Never optimistic. */
  readonly confirmedByRoom: Record<string, ConfirmedModel>;
  /** The ACTIVE room's views into the per-room maps. */
  readonly options: readonly ModelOption[];
  readonly thinking: ThinkingLevelId | null;
  readonly confirmed: ConfirmedModel | null;
}

export interface ModelActions {
  readonly setBusy: (busy: boolean) => void;  readonly setSwitchTo: (target: ModelSwitchTarget | null) => void;
  readonly setNotice: (notice: string | null) => void;
  /** Records a catalogue for `room`. */
  readonly applyCatalogue: (
    room: string,
    options: readonly ModelOption[],
    confirmed: ConfirmedModel | null,
  ) => void;
  /** Records a host-confirmed pick and corrects the cached catalogue in place,
   *  so a reopen shows the new `current` without an extra round trip. */
  readonly applyConfirmed: (room: string, choice: ConfirmedModel) => void;
  readonly setThinking: (room: string, level: ThinkingLevelId) => void;
  readonly listReq: React.MutableRefObject<ListRequest | null>;
  readonly setReq: React.MutableRefObject<SetRequest | null>;
  readonly thinkingReq: React.MutableRefObject<ThinkingRequest | null>;
  /** Rooms still to prefetch on this connection, drained one at a time. */
  readonly prefetchQueue: React.MutableRefObject<string[]>;
  /** The pick awaiting `action_ok`; only then does it become confirmed. */
  readonly pendingChoice: React.MutableRefObject<PendingModelChoice | null>;
  /** Raw per-room catalogue setter, for the container's projection step. */
  readonly setOptionsByRoom: (
    update: (prev: Record<string, readonly ModelOption[]>) => Record<string, readonly ModelOption[]>,
  ) => void;
  /** Raw per-room thinking setter, for the container's projection step. */
  readonly setThinkingByRoom: (
    update: (prev: Record<string, ThinkingLevelId>) => Record<string, ThinkingLevelId>,
  ) => void;
  /** Raw per-room confirmed setter. */
  readonly setConfirmedByRoom: (
    update: (prev: Record<string, ConfirmedModel>) => Record<string, ConfirmedModel>,
  ) => void;
}

export interface ModelStore {
  readonly state: ModelState;
  readonly actions: ModelActions;
}

export function useModelStore(activeRoom: string | null): ModelStore {
  const [busy, setBusy] = useState(false);
  const [switchTo, setSwitchTo] = useState<ModelSwitchTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [optionsByRoom, setOptionsByRoom] = useState<Record<string, readonly ModelOption[]>>({});
  const [thinkingByRoom, setThinkingByRoom] = useState<Record<string, ThinkingLevelId>>({});
  const [confirmedByRoom, setConfirmedByRoom] = useState<Record<string, ConfirmedModel>>({});

  const listReq = useRef<ListRequest | null>(null);
  const setReq = useRef<SetRequest | null>(null);
  const thinkingReq = useRef<ThinkingRequest | null>(null);
  const prefetchQueue = useRef<string[]>([]);
  const pendingChoice = useRef<PendingModelChoice | null>(null);

  const applyCatalogue = (
    room: string,
    options: readonly ModelOption[],
    confirmed: ConfirmedModel | null,
  ) => {
    setOptionsByRoom((prev) => ({ ...prev, [room]: options }));
    if (confirmed !== null) {
      setConfirmedByRoom((prev) => ({ ...prev, [room]: confirmed }));
    }
  };

  const applyConfirmed = (room: string, choice: ConfirmedModel) => {
    setConfirmedByRoom((prev) => ({ ...prev, [room]: choice }));
    // Correct the cached `current` marker in place: `action_ok` already proves
    // the switch succeeded, so re-listing would cost a whole extra round trip
    // (~3.4s measured) and re-lock the composer for no information.
    setOptionsByRoom((prev) => {
      const rows = prev[room];
      if (rows === undefined) return prev;
      return {
        ...prev,
        [room]: rows.map((row) => ({
          ...row,
          current: row.provider === choice.provider && row.id === choice.id,
        })),
      };
    });
  };

  const setThinking = (room: string, level: ThinkingLevelId) => {
    setThinkingByRoom((prev) => ({ ...prev, [room]: level }));
  };

  return {
    state: {
      busy,
      switchTo,
      notice,
      optionsByRoom,
      thinkingByRoom,
      confirmedByRoom,
      options: activeRoom === null ? [] : (optionsByRoom[activeRoom] ?? []),
      thinking: activeRoom === null ? null : (thinkingByRoom[activeRoom] ?? null),
      confirmed: activeRoom === null ? null : (confirmedByRoom[activeRoom] ?? null),
    },
    actions: {
      setBusy,
      setSwitchTo,
      setNotice,
      applyCatalogue,
      applyConfirmed,
      setThinking,
      listReq,
      setReq,
      thinkingReq,
      prefetchQueue,
      pendingChoice,
      setOptionsByRoom,
      setThinkingByRoom,
      setConfirmedByRoom,
    },
  };
}
