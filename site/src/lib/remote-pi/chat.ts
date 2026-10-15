/**
 * Wave4 host-forward chat reducer.
 *
 * Pure and transport-agnostic: it consumes only typed `ChatEvent`s, never
 * inspects wire payloads, and never stores credentials, tokens, or secrets.
 * Every transition returns a new `ChatState` (no in-place mutation).
 */

export type ChatPhase =
  | 'idle'
  | 'awaiting_echo'
  | 'streaming'
  | 'completed'
  | 'error'
  | 'timed_out'
  | 'disconnected';

/** CLOSED set of settled-turn failure KINDS the UI is allowed to name. The
 *  caller maps a wire frame onto one of these (and drops everything else), so
 *  no code here ever carries wire text, an exception, or a provider payload. */
export type ChatErrorCode =
  | 'busy'
  | 'not_connected'
  | 'unknown_turn'
  | 'action_rejected'
  | 'provider_error'
  | 'timeout'
  | 'disconnected'
  | 'duplicate'
  | 'superseded';

export interface ChatTurn {
  roomId: string;
  text: string;
  id: string;
  attempt: number;
  phase: ChatPhase;
  echoed: boolean;
  response: string;
  error: ChatErrorCode | null;
  retryRisk: boolean;
}

export interface ChatState {
  active: ChatTurn | null;
  history: readonly ChatTurn[];
  /** Tool calls observed for the ACTIVE turn's room, oldest first. Pi emits
   *  `tool_request`/`tool_result` alongside the text stream; they are kept
   *  separately from the prose so a card never interleaves with the deltas.
   *  Bounded by TOOL_LIMIT. */
  tools: readonly ChatTool[];
}

/** One tool call, as reported by Pi. `args`/`result` stay as TEXT the caller
 *  already stringified: the reducer never interprets host payloads. */
export interface ChatTool {
  id: string;
  roomId: string;
  tool: string;
  argsText: string;
  /** null while the call is still running. */
  outcome: { ok: true; resultText: string } | { ok: false } | null;
}

/** Most recent tool calls kept; older ones are dropped with the history. */
export const TOOL_LIMIT = 50;

export type ChatEvent =
  | { type: 'submit'; roomId: string; text: string; id: string; attempt: number; retryRisk: boolean }
  | { type: 'echo'; roomId: string; id: string }
  | { type: 'chunk'; roomId: string; id: string; delta: string }
  | { type: 'done'; roomId: string; id: string }
  | { type: 'error'; roomId: string; id: string; code: ChatErrorCode }
  | { type: 'timeout'; roomId: string; id: string }
  | { type: 'disconnected'; roomId: string; id?: string }
  /** Pi announced a tool call. `argsText` is ALREADY stringified by the caller
   *  (the reducer never inspects or re-serializes host payloads). */
  | { type: 'tool_start'; roomId: string; toolCallId: string; tool: string; argsText: string }
  /** The matching outcome. `resultText` is caller-stringified, or omitted. */
  | { type: 'tool_end'; roomId: string; toolCallId: string; ok: boolean; resultText?: string }
  | { type: 'reset' };

/** UI-facing projection of a turn. */
export type ChatItem =
  | { kind: 'user'; id: string; roomId: string; text: string }
  | {
      kind: 'agent';
      id: string;
      roomId: string;
      text: string;
      phase: ChatPhase;
      error: ChatErrorCode | null;
      retryRisk: boolean;
      attempt: number;
    };

const CHAT_HISTORY_LIMIT = 100;

const TERMINAL_PHASES: readonly ChatPhase[] = ['completed', 'error', 'timed_out', 'disconnected'];

export const initialChatState: ChatState = { active: null, history: [], tools: [] };

function isTerminalPhase(phase: ChatPhase): boolean {
  return TERMINAL_PHASES.includes(phase);
}

function isOpenPhase(phase: ChatPhase): boolean {
  return phase === 'awaiting_echo' || phase === 'streaming';
}

function matches(turn: ChatTurn, roomId: string, id: string): boolean {
  return turn.id === id && turn.roomId === roomId;
}

function pushHistory(history: readonly ChatTurn[], turn: ChatTurn): readonly ChatTurn[] {
  return [...history, turn].slice(-CHAT_HISTORY_LIMIT);
}

/** Applies `step` to the active turn when it matches exactly; otherwise no-op. */
function updateActive(
  state: ChatState,
  roomId: string,
  id: string,
  step: (turn: ChatTurn) => ChatTurn | null,
): ChatState {
  const active = state.active;
  if (active === null || !matches(active, roomId, id)) return state;
  const next = step(active);
  if (next === null) return state;
  return { active: next, history: state.history, tools: state.tools };
}

/** Applies `step` to the active turn and, on success, archives it as terminal. */
function settleActive(
  state: ChatState,
  roomId: string,
  id: string,
  step: (turn: ChatTurn) => ChatTurn | null,
): ChatState {
  const active = state.active;
  if (active === null || !matches(active, roomId, id)) return state;
  const next = step(active);
  if (next === null) return state;
  return { active: null, history: pushHistory(state.history, next), tools: state.tools };
}

function reduceSubmit(
  state: ChatState,
  event: Extract<ChatEvent, { type: 'submit' }>,
): ChatState {
  const active = state.active;
  if (active !== null && !isTerminalPhase(active.phase)) return state;
  const history = active === null ? state.history : pushHistory(state.history, active);
  const turn: ChatTurn = {
    roomId: event.roomId,
    text: event.text,
    id: event.id,
    attempt: event.attempt,
    phase: 'awaiting_echo',
    echoed: false,
    response: '',
    error: null,
    retryRisk: event.retryRisk,
  };
  // A new turn starts a NEW tool list: the previous turn's calls belong to the
  // transcript above, and this turn's are its own.
  return { active: turn, history, tools: [] };
}

/** True when a new turn may be started: no active turn, or a settled one. */
export function canSubmit(state: ChatState): boolean {
  return state.active === null || isTerminalPhase(state.active.phase);
}

export function reduceChat(state: ChatState, event: ChatEvent): ChatState {
  switch (event.type) {
    case 'submit':
      return reduceSubmit(state, event);

    case 'echo':
      return updateActive(state, event.roomId, event.id, (turn) =>
        turn.echoed || turn.phase !== 'awaiting_echo'
          ? null
          : { ...turn, echoed: true, phase: 'streaming' },
      );

    case 'chunk':
      return updateActive(state, event.roomId, event.id, (turn) =>
        turn.echoed && turn.phase === 'streaming'
          ? { ...turn, response: turn.response + event.delta }
          : null,
      );

    case 'done':
      return settleActive(state, event.roomId, event.id, (turn) =>
        turn.echoed && turn.phase === 'streaming' ? { ...turn, phase: 'completed' } : null,
      );

    case 'error':
      return settleActive(state, event.roomId, event.id, (turn) =>
        isOpenPhase(turn.phase) ? { ...turn, phase: 'error', error: event.code } : null,
      );

    case 'timeout':
      return settleActive(state, event.roomId, event.id, (turn) =>
        isOpenPhase(turn.phase) ? { ...turn, phase: 'timed_out', error: 'timeout' } : null,
      );

    case 'disconnected':
      return settleActive(state, event.roomId, event.id ?? state.active?.id ?? '', (turn) =>
        isOpenPhase(turn.phase) ? { ...turn, phase: 'disconnected', error: 'disconnected' } : null,
      );

    case 'tool_start': {
      // Only the ACTIVE turn's room is adopted: a tool frame for another room
      // (or with no open turn) is not this transcript's business.
      const active = state.active;
      if (active === null || active.roomId !== event.roomId) return state;
      // A repeated id does not duplicate the card — Pi can re-announce.
      if (state.tools.some((tool) => tool.id === event.toolCallId)) return state;
      const tool: ChatTool = {
        id: event.toolCallId,
        roomId: event.roomId,
        tool: event.tool,
        argsText: event.argsText,
        outcome: null,
      };
      return { ...state, tools: [...state.tools, tool].slice(-TOOL_LIMIT) };
    }

    case 'tool_end': {
      const index = state.tools.findIndex(
        (tool) => tool.id === event.toolCallId && tool.roomId === event.roomId,
      );
      if (index < 0) return state;
      const tools = state.tools.slice();
      tools[index] = {
        ...tools[index],
        outcome: event.ok
          ? { ok: true, resultText: event.resultText ?? '' }
          : { ok: false },
      };
      return { ...state, tools };
    }

    case 'reset':
      return { active: null, history: [], tools: [] };

    default:
      return state;
  }
}

/**
 * Ordered user/agent items for the UI. A turn the host has NOT echoed yet
 * (`awaiting_echo`) contributes NOTHING: no optimistic user bubble and no
 * agent placeholder — the submitted text is invisible until the host confirms
 * it with an exact-echo event (same room + id). After that echo the user item
 * and the streaming agent item appear together; a settled turn (completed /
 * error / timed_out / disconnected) shows the user item plus the fixed agent
 * status carried by `phase`/`error`/`retryRisk`/`attempt`.
 */
export function visibleChatItems(state: ChatState): readonly ChatItem[] {
  const turns: readonly ChatTurn[] =
    state.active === null ? state.history : [...state.history, state.active];
  const items: ChatItem[] = [];
  for (const turn of turns) {
    if (!turn.echoed && !isTerminalPhase(turn.phase)) continue;
    items.push({ kind: 'user', id: turn.id, roomId: turn.roomId, text: turn.text });
    items.push({
      kind: 'agent',
      id: turn.id,
      roomId: turn.roomId,
      text: turn.response,
      phase: turn.phase,
      error: turn.error,
      retryRisk: turn.retryRisk,
      attempt: turn.attempt,
    });
  }
  return items;
}
