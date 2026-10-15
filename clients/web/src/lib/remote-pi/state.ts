/**
 * Connection phase state — Wave 2 foundation.
 *
 * A PURE, typed, serializable state machine for the web client's connection
 * lifecycle. No I/O, no timers, no `window`, no DOM: the adapter (Wave 2/3)
 * owns the socket and feeds events in; this module only derives the next
 * state, so the transition table is testable in Node without a relay.
 *
 * WHAT IS ALLOWED TO LIVE HERE: the phase, the generation/attempt counters and
 * a *public, sanitized* diagnostic. WHAT IS NEVER HERE: the pairing token, any
 * private key, any host-supplied error text, any transcript. A diagnostic is a
 * fixed code plus fixed text — there is no field that can carry a secret even
 * by accident, and `PublicDiagnostic` is built only from the table below.
 */

/** Every phase the client can be in. Terminal phases: `closed`, `disabled`. */
export type ConnectionPhase =
  /** Persistence-gated route (plan 69 W4): nothing runs at all. */
  | "disabled"
  /** Ready, not connected, no pairing attempt in flight. */
  | "idle"
  /** `pair_request` sent, waiting for `pair_ok` / `pair_error`. */
  | "pairing"
  /** WS open, relay `hello → challenge → auth` in flight. */
  | "relay_authenticating"
  /** Relay authenticated; `host_hello` handshake in flight. */
  | "host_authenticating"
  /** Relay authenticated AND host handshake done. */
  | "connected"
  /** Lost a live connection; backoff/retry in progress. */
  | "reconnecting"
  /** Host (or relay) refused the stored identity — re-pairing required. */
  | "reauth_required"
  /** Shutdown requested, socket not yet confirmed closed. */
  | "closing"
  /** Terminal: socket closed, resources released. */
  | "closed"
  /** Terminal-ish failure without a retry scheduled. */
  | "error";

const CONNECTION_PHASES: readonly ConnectionPhase[] = [
  "disabled",
  "idle",
  "pairing",
  "relay_authenticating",
  "host_authenticating",
  "connected",
  "reconnecting",
  "reauth_required",
  "closing",
  "closed",
  "error",
];

export function isConnectionPhase(value: unknown): value is ConnectionPhase {
  return typeof value === "string" && (CONNECTION_PHASES as readonly string[]).includes(value);
}

/**
 * Public (sanitized) diagnostic codes. These are the ONLY reason strings that
 * can reach the UI: the adapter maps raw failures (exceptions, close codes,
 * host text) onto one of these and the message comes from the frozen table.
 */
export type PublicDiagnosticCode =
  | "relay_unreachable"
  | "relay_auth_failed"
  | "host_timeout"
  | "host_refused"
  | "pair_rejected"
  | "storage_unavailable"
  | "connection_lost"
  | "retry_exhausted"
  | "unexpected";

const DIAGNOSTIC_MESSAGES: Readonly<Record<PublicDiagnosticCode, string>> = {
  relay_unreachable: "Could not reach the relay.",
  relay_auth_failed: "The relay refused this session key.",
  host_timeout: "The host did not answer in time.",
  host_refused: "The host refused the connection.",
  pair_rejected: "The host rejected the pairing.",
  storage_unavailable: "Local storage for this session is unavailable.",
  connection_lost: "The connection to the relay dropped.",
  retry_exhausted: "Could not reconnect.",
  unexpected: "Unexpected connection failure.",
};

export interface PublicDiagnostic {
  code: PublicDiagnosticCode;
  /** Fixed client-authored text — never derived from wire/exception content. */
  message: string;
}

export function isPublicDiagnosticCode(value: unknown): value is PublicDiagnosticCode {
  return typeof value === "string" && Object.hasOwn(DIAGNOSTIC_MESSAGES, value);
}

/** Builds the sanitized diagnostic for `code` (fixed text, nothing echoed). */
export function publicDiagnostic(code: PublicDiagnosticCode): PublicDiagnostic {
  return { code, message: DIAGNOSTIC_MESSAGES[code] };
}

/** Connection state — fully serializable, no secret, no live handle. */
export interface ConnectionState {
  phase: ConnectionPhase;
  /** Increments once per connect attempt sequence (a new "generation" of the
   *  socket): a stale reply from generation N is recognizable in N+1. */
  generation: number;
  /** Attempts used inside the current generation (reconnects included). */
  attempt: number;
  /** ms epoch of the last phase change (`now` supplied by the caller). */
  since: number;
  /** Sanitized reason for `error`/`reconnecting`/`reauth_required`. */
  diagnostic: PublicDiagnostic | null;
}

export interface ConnectionStateInit {
  phase?: ConnectionPhase;
  now?: number;
}

export function createConnectionState(init: ConnectionStateInit = {}): ConnectionState {
  const phase = init.phase ?? "idle";
  return {
    phase,
    generation: 0,
    attempt: 0,
    since: init.now ?? 0,
    diagnostic: null,
  };
}

/** Events the adapter feeds in. One event → exactly one next state.
 *
 * Optional `generation` guard: when an event carries the generation of the
 * socket that produced it, the reducer DROPS it if it does not match the
 * state's current generation. A late reply from a dead socket therefore cannot
 * move a newer connection. Events without the field stay unguarded (the same
 * reducer serves callers that do not track generations). */
export interface GenerationGuard {
  /** Generation of the socket that produced this event (optional). */
  generation?: number;
}

export type ConnectionEvent = (
  /** Begin a connection sequence (enables if the route was disabled). */
  | { type: "connect" }
  /** Route gate closed — everything stops. */
  | { type: "disable" }
  /** WS open; relay handshake started (starts a new generation). */
  | { type: "relay_authenticating" }
  /** Relay accepted `auth`; host handshake next. */
  | { type: "relay_authenticated" }
  /** A pairing flow restarted on the current connection. */
  | { type: "pairing" }
  /** `pair_ok` landed — the host handshake (`host_hello` + catalog) is next. */
  | { type: "pair_accepted" }
  /** Host handshake completed — fully connected. */
  | { type: "host_authenticated" }
  /** A live connection dropped; `retryable` decides reconnect vs failure. */
  | { type: "connection_lost"; code?: PublicDiagnosticCode }
  /** Retry budget exhausted. */
  | { type: "retry_exhausted" }
  /** Stored identity no longer accepted — a new pairing is required. */
  | { type: "reauth_required" }
  /** Shutdown requested. */
  | { type: "close" }
  /** Socket confirmed closed. */
  | { type: "closed" }
  /** Failure with no retry scheduled. */
  | { type: "fail"; code?: PublicDiagnosticCode }
) & GenerationGuard;

/** Legal transitions. Anything not listed leaves the state UNCHANGED (the
 *  reducer never throws on an out-of-order event — a late reply from a dead
 *  socket must be harmless, not fatal).
 *
 *  Two shape rules follow the REAL host-first path
 *  (`relay_authenticating → pairing → host_authenticating → connected`, where
 *  the daemon validates `pair_request` before `host_hello`/catalog):
 *   • `pairing` is reachable from `relay_authenticating` and leads on to
 *     `host_authenticating` — pairing happens on the authenticated relay
 *     socket, before the host handshake, not beside it;
 *   • a rejected/expired token in EITHER the pairing phase or the host phase
 *     means the stored identity must be replaced → `reauth_required` is legal
 *     from both. */
const TRANSITIONS: Readonly<Record<ConnectionPhase, readonly ConnectionPhase[]>> = {
  disabled: ["idle"],
  idle: ["pairing", "relay_authenticating", "reconnecting", "closing", "closed", "disabled", "error"],
  pairing: ["host_authenticating", "relay_authenticating", "connected", "reconnecting", "reauth_required", "error", "closing", "closed"],
  relay_authenticating: ["pairing", "host_authenticating", "reconnecting", "error", "closing", "closed"],
  host_authenticating: ["connected", "relay_authenticating", "reconnecting", "reauth_required", "error", "closing", "closed"],
  // `connected` → `relay_authenticating` is the NEW-PAIR sequence (a fresh
  // socket opened while the previous connection is still healthy).
  connected: ["relay_authenticating", "reconnecting", "reauth_required", "closing", "closed", "error"],
  reconnecting: ["relay_authenticating", "error", "reauth_required", "closing", "closed"],
  reauth_required: ["pairing", "relay_authenticating", "closing", "closed", "error"],
  closing: ["closed"],
  closed: ["idle", "relay_authenticating"],
  error: ["relay_authenticating", "reconnecting", "pairing", "closing", "closed", "disabled"],
};

export function canTransition(from: ConnectionPhase, to: ConnectionPhase): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

/** Pure reducer: (state, event) → next state. Never mutates its input. */
export function reduceConnectionState(
  state: ConnectionState,
  event: ConnectionEvent,
  now: number = 0,
): ConnectionState {
  // Stale-event guard: a sender that stamps its socket generation is refused
  // once a newer generation exists (the reducer never throws, it ignores).
  if (event.generation !== undefined && event.generation !== state.generation) {
    return state;
  }

  const stay = (patch: Partial<ConnectionState> = {}): ConnectionState =>
    ({ ...state, ...patch, since: now });

  const move = (to: ConnectionPhase, patch: Partial<ConnectionState> = {}): ConnectionState => {
    if (!canTransition(state.phase, to)) return state;
    return { ...state, ...patch, phase: to, since: now };
  };

  /** A connection SEQUENCE begins: `generation` advances and the phase becomes
   *  `relay_authenticating` from ANY phase that may open a socket — including
   *  a healthy `connected` (an explicit re-pair opens a new socket at once)
   *  and any in-flight handshake. `keepAttempt` is set ONLY by a true RETRY
   *  (the `relay_authenticating` event): an explicit `connect` always starts
   *  the attempt counter at 1, so a new pair never inherits the old backoff
   *  budget. */
  const beginSequence = (keepAttempt: boolean): ConnectionState => ({
    ...state,
    phase: "relay_authenticating",
    generation: state.generation + 1,
    attempt: keepAttempt && state.phase === "reconnecting" ? state.attempt : 1,
    since: now,
    diagnostic: null,
  });

  /** Legal to open a new socket from here? `disabled`/`closing` are not. */
  const canBegin = (): boolean => canTransition(state.phase, "relay_authenticating");

  switch (event.type) {
    case "connect":
      // `disabled` stays the gate: a connect there only re-enables `idle`.
      if (state.phase === "disabled") {
        return { ...state, phase: "idle", since: now, diagnostic: null };
      }
      return canBegin() ? beginSequence(false) : state;

    case "disable":
      return { ...state, phase: "disabled", since: now, diagnostic: null };

    case "relay_authenticating":
      // A new socket: new generation. Out-of-order while disabled is ignored.
      // This is also the RETRY carrier: from `reconnecting` it keeps the
      // attempt counter (the backoff budget) instead of resetting it.
      return canBegin() ? beginSequence(true) : state;

    case "relay_authenticated":
      return move("host_authenticating", { diagnostic: null });

    case "pairing":
      return move("pairing", { diagnostic: null });

    // `pair_ok` on the authenticated relay socket: the frozen host-first path
    // continues with `host_hello`/catalog before the connection is usable.
    case "pair_accepted":
      return move("host_authenticating", { diagnostic: null });

    case "host_authenticated":
      return move("connected", { diagnostic: null });

    case "connection_lost":
      return move("reconnecting", {
        attempt: state.attempt + 1,
        diagnostic: publicDiagnostic(event.code ?? "connection_lost"),
      });

    case "retry_exhausted":
      return move("error", { diagnostic: publicDiagnostic("retry_exhausted") });

    case "reauth_required":
      return move("reauth_required", { diagnostic: publicDiagnostic("pair_rejected") });

    case "close":
      return move("closing", { diagnostic: null });

    case "closed":
      return move("closed", { diagnostic: null });

    case "fail":
      return move("error", { diagnostic: publicDiagnostic(event.code ?? "unexpected") });

    default:
      return stay();
  }
}

/** True for phases where no work is scheduled and none will be. */
export function isTerminalPhase(phase: ConnectionPhase): boolean {
  return phase === "closed" || phase === "disabled";
}

/** True while the client can carry application traffic. */
export function isUsablePhase(phase: ConnectionPhase): boolean {
  return phase === "connected";
}
