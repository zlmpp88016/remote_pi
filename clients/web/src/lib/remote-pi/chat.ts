/**
 * Wave4 host-forward chat reducer.
 *
 * Pure and transport-agnostic: it consumes only typed `ChatEvent`s, never
 * inspects wire payloads, and never stores credentials, tokens, or secrets.
 * Every transition returns a new `ChatState` (no in-place mutation).
 */
import type { WireSessionEvent, WireUsage } from "./protocol";

export type ChatPhase =
  | 'idle'
  | 'awaiting_echo'
  | 'streaming'
  | 'completed'
  /** The user stopped the turn. Distinct from `error`: nothing failed. */
  | 'cancelled'
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
  /**
   * Token accounting and timing for this turn, when the host reported them.
   *
   * Absent for a turn that is still streaming (usage arrives with the settled
   * assistant message) and for any turn from a host that sends no usage at all.
   * The UI omits the reading rather than printing a zero.
   */
  stats?: TurnStats;
}

/** Per-turn display data derived from the host's usage and event timestamps. */
export interface TurnStats {
  /** Elapsed milliseconds from the user message to the last reply, or `null`. */
  elapsedMs: number | null;
  /**
   * Milliseconds actually spent GENERATING, i.e. from the first assistant
   * message of the turn to the last.
   *
   * `elapsedMs` includes tool executions and queueing, so dividing output tokens
   * by it reports wall-clock throughput rather than decode speed — measured at
   * ~17 tok/s for a session whose model decoded at hundreds. `null` when the turn
   * has fewer than two assistant messages to span.
   */
  decodeMs: number | null;
  /** Timestamp of the last assistant message, or `null`. */
  lastAgentTs: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
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
  | { type: 'done'; roomId: string; id: string; usage?: WireUsage }
  | { type: 'error'; roomId: string; id: string; code: ChatErrorCode }
  | { type: 'timeout'; roomId: string; id: string }
  | { type: 'cancelled'; roomId: string; id: string }
  | { type: 'disconnected'; roomId: string; id?: string }
  /** Pi announced a tool call. `argsText` is ALREADY stringified by the caller
   *  (the reducer never inspects or re-serializes host payloads). */
  | { type: 'tool_start'; roomId: string; toolCallId: string; tool: string; argsText: string }
  /** The matching outcome. `resultText` is caller-stringified, or omitted. */
  | { type: 'tool_end'; roomId: string; toolCallId: string; ok: boolean; resultText?: string }
  /** Replace the whole transcript with turns reconstructed from a session file
   *  (the host's `session_history` fan-out, or a `session_read`). Needed because
   *  resuming a session starts a FRESH process whose mirror is empty: without
   *  this the UI showed a brand-new blank conversation for a session that has
   *  months of history. */
  | { type: 'hydrate'; roomId: string; turns: readonly HydratedTurn[] }
  | { type: 'reset' };

/** One already-finished turn, as reconstructed from persisted events. */
export interface HydratedTurn {
  id: string;
  userText: string;
  agentText: string;
  tools: readonly { id: string; tool: string; argsText: string; ok: boolean; resultText: string }[];
  /** Timestamp of the user message that opened this turn, or `null` for a
   *  synthetic turn the host never opened with a user message. */
  userTs: number | null;
  /** Timestamp of the LAST assistant message in this turn, or `null` when the
   *  turn has no reply yet. Drives the divider's "completed in Xs" label. */
  lastAgentTs: number | null;
  /** Timestamp of the FIRST assistant message in this turn, or `null`. Together
   *  with `lastAgentTs` it bounds the time actually spent generating. */
  firstAgentTs: number | null;
  /** Summed usage across this turn's assistant messages. Absent when the host
   *  sent no usage at all, so the UI can omit the footer instead of printing 0. */
  usage: TurnUsage | null;
}

/** Per-turn token accounting, summed from its assistant messages. */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

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

const TERMINAL_PHASES: readonly ChatPhase[] = ['completed', 'cancelled', 'error', 'timed_out', 'disconnected'];

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
      return settleActive(state, event.roomId, event.id, (turn) => {
        if (!(turn.echoed && turn.phase === 'streaming')) return null;
        /*
         * Attach the host's usage as the turn settles.
         *
         * The live path never goes through `hydrate`, so without this a streaming
         * turn finished with no token accounting at all — the composer readings
         * only appeared after a re-read, which made them look broken during the
         * one moment a user is watching them.
         */
        const stats = event.usage !== undefined
          ? {
              elapsedMs: null,
              decodeMs: null,
              lastAgentTs: null,
              inputTokens: event.usage.input_tokens ?? 0,
              outputTokens: event.usage.output_tokens ?? 0,
              cacheReadTokens: event.usage.cache_read_tokens ?? 0,
              cacheWriteTokens: event.usage.cache_write_tokens ?? 0,
              reasoningTokens: event.usage.reasoning_tokens ?? 0,
            }
          : undefined;
        return { ...turn, phase: 'completed', ...(stats !== undefined ? { stats } : {}) };
      });

    case 'error':
      return settleActive(state, event.roomId, event.id, (turn) =>
        isOpenPhase(turn.phase) ? { ...turn, phase: 'error', error: event.code } : null,
      );

    case 'timeout':
      return settleActive(state, event.roomId, event.id, (turn) =>
        isOpenPhase(turn.phase) ? { ...turn, phase: 'timed_out', error: 'timeout' } : null,
      );

    /* The user stopped the turn. Guarded on `isOpenPhase` like every other
       settle: a cancel frame that races a turn which already completed must be
       inert, never rewrite a finished reply as "stopped". `error` stays null —
       nothing failed, and a status the user caused must not read as a fault. */
    case 'cancelled':
      return settleActive(state, event.roomId, event.id, (turn) =>
        isOpenPhase(turn.phase) ? { ...turn, phase: 'cancelled', error: null } : null,
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

    case 'hydrate': {
      /*
       * Rebuild the transcript from persisted turns.
       *
       * Every hydrated turn is 'completed': the events came from a session file,
       * so none of them is still streaming. `active` is cleared because the
       * fresh process has no open turn -- anything the user sends next becomes a
       * NEW turn rather than being appended to a resumed one.
       */
      const history: ChatTurn[] = event.turns.map((turn) => ({
        roomId: event.roomId,
        text: turn.userText,
        id: turn.id,
        attempt: 0,
        phase: 'completed',
        echoed: true,
        response: turn.agentText,
        error: null,
        retryRisk: false,
        ...(turn.usage !== null || turn.lastAgentTs !== null
          ? {
              stats: {
                elapsedMs:
                  turn.userTs !== null && turn.lastAgentTs !== null
                    ? Math.max(0, turn.lastAgentTs - turn.userTs)
                    : null,
                /*
                 * Generation time = first reply block to last. A turn whose
                 * reply arrived as a single message has no span, and reporting
                 * that as an extremely high speed would be a fabricated reading;
                 * `null` makes the pill omit the speed instead.
                 */
                decodeMs:
                  turn.firstAgentTs !== null &&
                  turn.lastAgentTs !== null &&
                  turn.lastAgentTs > turn.firstAgentTs
                    ? turn.lastAgentTs - turn.firstAgentTs
                    : null,
                lastAgentTs: turn.lastAgentTs,
                inputTokens: turn.usage?.inputTokens ?? 0,
                outputTokens: turn.usage?.outputTokens ?? 0,
                cacheReadTokens: turn.usage?.cacheReadTokens ?? 0,
                cacheWriteTokens: turn.usage?.cacheWriteTokens ?? 0,
                reasoningTokens: turn.usage?.reasoningTokens ?? 0,
              },
            }
          : {}),
      }));
      const tools: ChatTool[] = event.turns.flatMap((turn) =>
        turn.tools.map((t) => ({
          id: t.id,
          roomId: event.roomId,
          tool: t.tool,
          argsText: t.argsText,
          outcome: t.ok ? { ok: true as const, resultText: t.resultText } : { ok: false as const },
        })),
      );
      return { active: null, history, tools: tools.slice(-TOOL_LIMIT) };
    }

    case 'reset':
      return { active: null, history: [], tools: [] };

    default:
      return state;
  }
}

/**
 * Ordered user/agent items for the UI.
 *
 * OPTIMISTIC LOCAL ECHO: a turn the host has not confirmed yet
 * (`awaiting_echo`) renders its USER bubble immediately, so the text the user
 * just sent appears on screen before any network round trip. Only the agent
 * placeholder is withheld: an `awaiting_echo` turn contributes no agent item,
 * because there is nothing to stream yet. The host's exact echo (same room +
 * id) then promotes the turn to `streaming` and its agent item appears.
 *
 * A settled turn (completed / error / timed_out / disconnected) shows the user
 * item plus the fixed agent status carried by
 * `phase`/`error`/`retryRisk`/`attempt`.
 */
export function visibleChatItems(state: ChatState): readonly ChatItem[] {
  const turns: readonly ChatTurn[] =
    state.active === null ? state.history : [...state.history, state.active];
  const items: ChatItem[] = [];
  for (const turn of turns) {
    // The user's own text is never withheld: it is drawn from the local draft
    // the moment the send was accepted (see `visibleChatItems` doc above).
    items.push({ kind: 'user', id: turn.id, roomId: turn.roomId, text: turn.text });
    // The agent item exists only once the host has taken the turn: before the
    // echo there is no reply to show, and showing an empty streaming bubble
    // would claim work that may never start.
    if (!turn.echoed && !isTerminalPhase(turn.phase)) continue;
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

/**
 * Fold persisted session events into finished turns.
 *
 * The wire vocabulary (`user_input` / `agent_message` / `tool_request` /
 * `tool_result` / `compaction`) is chronological, so one pass is enough: a
 * `user_input` opens a turn and everything until the next one belongs to it.
 *
 * `compaction` is folded into the agent text rather than dropped: a summary is
 * real conversation content, and hiding it would make a compacted session look
 * like it lost the middle of its history.
 */
export function hydrateTurns(events: readonly WireSessionEvent[]): HydratedTurn[] {
  interface Draft {
    id: string;
    user: string;
    agent: string[];
    tools: { id: string; tool: string; argsText: string; ok: boolean; resultText: string }[];
    userTs: number | null;
    lastAgentTs: number | null;
    firstAgentTs: number | null;
    usage: TurnUsage | null;
  }
  const turns: Draft[] = [];
  let current: Draft | null = null;
  /** tool_call_id -> index in current.tools, so a result can find its request. */
  const pending = new Map<string, number>();

  const open = (id: string, text: string, ts: number | null): Draft => {
    current = {
      id,
      user: text,
      agent: [],
      tools: [],
      userTs: ts,
      lastAgentTs: null,
      firstAgentTs: null,
      usage: null,
    };
    turns.push(current);
    return current;
  };

  /** Add one assistant message's usage to a turn, keeping `null` when none was sent. */
  const addUsage = (turn: Draft, usage: WireUsage | undefined): void => {
    if (usage === undefined) return;
    const acc = turn.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
    acc.inputTokens += usage.input_tokens ?? 0;
    acc.outputTokens += usage.output_tokens ?? 0;
    acc.cacheReadTokens += usage.cache_read_tokens ?? 0;
    acc.cacheWriteTokens += usage.cache_write_tokens ?? 0;
    acc.reasoningTokens += usage.reasoning_tokens ?? 0;
    turn.usage = acc;
  };

  for (const event of events) {
    if (event.type === "user_input") {
      open(event.id, event.text, event.ts);
      pending.clear();
      continue;
    }
    // An agent message or tool event with no preceding user turn still belongs
    // somewhere: some sessions start with a synthetic/system turn. Give it a
    // stable id derived from the position rather than inventing a user bubble.
    const turn = current ?? open(`hydrated-${event.ts}`, "", null);
    if (event.type === "agent_message") {
      if (event.text !== "") turn.agent.push(event.text);
      if (turn.firstAgentTs === null) turn.firstAgentTs = event.ts;
      turn.lastAgentTs = event.ts;
      addUsage(turn, event.usage);
      continue;
    }
    if (event.type === "compaction") {
      turn.agent.push(event.summary);
      continue;
    }
    if (event.type === "tool_request") {
      const index = turn.tools.length;
      pending.set(event.tool_call_id, index);
      turn.tools.push({
        id: event.tool_call_id,
        tool: event.tool,
        argsText: safeStringify(event.args),
        ok: true,
        resultText: "",
      });
      continue;
    }
    if (event.type === "tool_result") {
      const index = pending.get(event.tool_call_id);
      if (index === undefined) continue;
      const target = turn.tools[index];
      if (target === undefined) continue;
      target.ok = event.error === undefined;
      target.resultText = event.error ?? safeStringify(event.result);
    }
  }

  return turns.map((t) => ({
    id: t.id,
    userText: t.user,
    agentText: t.agent.join(""),
    tools: t.tools,
    userTs: t.userTs,
    lastAgentTs: t.lastAgentTs,
    firstAgentTs: t.firstAgentTs,
    usage: t.usage,
  }));
}

/** Host payloads are opaque; a cycle or a BigInt must not throw here. */
function safeStringify(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
