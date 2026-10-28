/**
 * Connection + pairing surface state.
 *
 * The connection LIFECYCLE itself lives in `@/lib/remote-pi/adapter` (one adapter
 * per mount, sole owner of the credential). This store only holds the view
 * state the launcher and the header render: the last snapshot, the two pairing
 * inputs, the in-flight action label, the dismissible local error and the
 * two-click unpair arming flag.
 */

import { useRef, useState } from "react";

import type { AdapterSnapshot } from "@/lib/remote-pi/adapter";

export interface ConnectionState {
  readonly snapshot: AdapterSnapshot | null;
  readonly address: string;
  readonly code: string;
  /** Human label of the action in flight, or null. */
  readonly actionBusy: string | null;
  /** A client-authored error that the user may dismiss. */
  readonly localError: string | null;
  readonly unpairArmed: boolean;
  /** The workspace room whose transcript is on screen. */
  readonly activeRoom: string | null;
}

export interface ConnectionActions {
  readonly setSnapshot: (snapshot: AdapterSnapshot | null) => void;
  readonly setAddress: (address: string) => void;
  readonly setCode: (code: string) => void;
  readonly setActionBusy: (label: string | null) => void;
  readonly setLocalError: (error: string | null) => void;
  readonly setUnpairArmed: (armed: boolean) => void;
  readonly setActiveRoom: (room: string | null) => void;
  /** Monotonic owner token for pairing attempts. */
  readonly pairSeq: React.MutableRefObject<number>;
}

export interface ConnectionStore {
  readonly state: ConnectionState;
  readonly actions: ConnectionActions;
}

export function useConnectionStore(): ConnectionStore {
  const [snapshot, setSnapshot] = useState<AdapterSnapshot | null>(null);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [unpairArmed, setUnpairArmed] = useState(false);
  const [activeRoom, setActiveRoom] = useState<string | null>(null);
  const pairSeq = useRef(0);

  return {
    state: { snapshot, address, code, actionBusy, localError, unpairArmed, activeRoom },
    actions: {
      setSnapshot,
      setAddress,
      setCode,
      setActionBusy,
      setLocalError,
      setUnpairArmed,
      setActiveRoom,
      pairSeq,
    },
  };
}
