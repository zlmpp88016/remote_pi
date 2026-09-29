/**
 * Plan/28 Wave B — typed action handlers.
 *
 * Each handler maps one `ClientMessage` action to a public Pi SDK call,
 * and replies with `action_ok` or `action_error`. Handlers take their
 * dependencies as parameters so the index.ts wiring is one-liner and
 * unit tests can pass fakes without touching global state.
 *
 * `models_list` lives next door because it shares the `ModelRegistry`
 * helper and the same wire vocabulary.
 *
 * SDK API surface used (see plan/28 Wave 0 for the full table):
 *
 *   - `ctx.compact()`            — non-blocking, fires `session_compact`
 *                                  event when done
 *   - `ctx.newSession()`         — only on `ExtensionCommandContext`;
 *                                  resolves with `{cancelled}` flag
 *   - `ctx.switchSession(path)`  — plan/67, command ctx only; `{cancelled}`
 *                                  maps to wire `locked`
 *   - `listSessions(cwd)`        — injected; production uses SessionManager.list
 *   - `pi.setModel(model)`       — returns `false` if no auth configured
 *   - `pi.setThinkingLevel(lvl)` — synchronous
 *   - `ctx.getModel()`           — optional, undefined before first turn
 *   - `ModelRegistry.{refresh,getAvailable,find}` — see `registry.ts`
 */

import type {
  ClientMessage,
  ServerMessage,
  WireModel,
  ActionName,
} from "../protocol/types.js";

/**
 * Structural subset of the SDK's `Model<Api>` interface (defined in
 * `@earendil-works/pi-ai`, which is a transitive dep — not re-exported by
 * `@earendil-works/pi-coding-agent`'s main entry). Capturing just the
 * fields we touch keeps the handler decoupled from the SDK's full Model
 * surface and avoids a direct dep on `pi-ai`.
 */
export interface SdkModelLike {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  contextWindow: number;
  /** Plan/30: accepted input modalities. The SDK's `Model.input` is
   *  `("text" | "image")[]`; we read `includes("image")` for the `vision`
   *  flag. Optional here so tests can omit it (treated as text-only). */
  input?: ("text" | "image")[];
}
// `Model` is the alias used throughout the file. Real SDK models structurally
// satisfy this — `pi.setModel(model)` accepts them because TypeScript
// validates structurally at the call site (the SDK's full Model has more
// fields than we declare here, which is fine for an input parameter).
type Model<_TApi = unknown> = SdkModelLike;

/**
 * Minimal channel surface needed to reply. Mirrors `PlainPeerChannel`'s
 * `.send` signature; tests pass an array-backed fake.
 */
export interface ActionReplySender {
  send(msg: ServerMessage): void;
}

/**
 * Narrow shape of the `ExtensionAPI` surface action handlers actually
 * call. Lets the test layer stub just these without rebuilding the full
 * SDK type (which has 30+ methods we don't use here).
 */
export interface ActionPi {
  setModel(model: Model<any>): Promise<boolean>;
  setThinkingLevel(level: import("../protocol/types.js").ThinkingLevel): void;
}

/**
 * Narrow shape of the per-call context. Drawn from the union of
 * `ExtensionContextActions` (compact, getModel) and
 * `ExtensionCommandContextActions` (newSession), since index.ts caches
 * the most-recent ctx and that's typically the command one.
 *
 * All fields are optional so a missing method (e.g. when only a plain
 * `ExtensionContext` was seen) becomes a typed `action_error` instead of
 * a runtime TypeError.
 */
export interface ActionCtx {
  compact?: (options?: object) => void;
  /**
   * Starts a new session. `withSession` is the SDK's blessed hook for
   * post-replacement work: it receives a FRESH, command-capable ctx bound to
   * the new session. The SDK marks any ctx captured BEFORE this call stale, so
   * callers must re-capture via `withSession` rather than reuse the old ctx.
   */
  newSession?: (options?: {
    withSession?: (ctx: ActionCtx) => Promise<void>;
  }) => Promise<{ cancelled: boolean }>;
  /** Plan/67 — switch to another session file. Command ctx only. */
  switchSession?: (
    sessionPath: string,
    options?: { withSession?: (ctx: ActionCtx) => Promise<void> },
  ) => Promise<{ cancelled: boolean }>;
  cwd?: string;
  getSessionId?: () => string | undefined;
  getSessionFile?: () => string | undefined;
  getModel?: () => Model<any> | undefined;
  /**
   * Live session registry from Pi's extension ctx. Includes providers/models
   * registered dynamically via `pi.registerProvider(...)`, unlike the fallback
   * disk-backed registry remote-pi can build on its own.
   */
  modelRegistry?: ActionModelRegistry;
}

/**
 * Minimal shape of the registry surface. Maps 1:1 onto `ModelRegistry`
 * but lets tests fake catalogs without instantiating the real one.
 */
export interface ActionModelRegistry {
  refresh(): void;
  getAvailable(): Model<any>[];
  find(provider: string, modelId: string): Model<any> | undefined;
}

/** Project a SDK `Model<Api>` onto the wire schema. Shared by list_models
 *  and the `current` echo, so both stay in lockstep. */
export function wireFromModel(model: Model<any>): WireModel {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    reasoning: model.reasoning,
    context_window: model.contextWindow,
    // Plan/30: vision = model accepts image input. `Model.input` is
    // `("text" | "image")[]` at runtime (confirmed against pi-ai). `?.` guards
    // a fake/partial model in tests → treated as text-only.
    vision: model.input?.includes("image") ?? false,
  };
}

// ── ack helpers ────────────────────────────────────────────────────────────

function ok(sender: ActionReplySender, msg: { id: string }, action: ActionName): void {
  sender.send({ type: "action_ok", in_reply_to: msg.id, action });
}

function fail(
  sender: ActionReplySender,
  msg: { id: string },
  action: ActionName,
  err: unknown,
): void {
  const error = err instanceof Error ? err.message : String(err);
  sender.send({ type: "action_error", in_reply_to: msg.id, action, error });
}

/** Run a synchronous action with uniform success/failure replies. */
function runSync(
  sender: ActionReplySender,
  msg: { id: string },
  action: ActionName,
  body: () => void,
): void {
  try {
    body();
    ok(sender, msg, action);
  } catch (e) {
    fail(sender, msg, action, e);
  }
}

/** Run an async action with uniform success/failure replies. */
async function runAsync(
  sender: ActionReplySender,
  msg: { id: string },
  action: ActionName,
  body: () => Promise<void>,
): Promise<boolean> {
  try {
    await body();
    ok(sender, msg, action);
    return true;
  } catch (e) {
    fail(sender, msg, action, e);
    return false;
  }
}

// ── individual handlers ───────────────────────────────────────────────────

type SessionCompactMsg = Extract<ClientMessage, { type: "session_compact" }>;
type SessionNewMsg = Extract<ClientMessage, { type: "session_new" }>;
type ModelSetMsg = Extract<ClientMessage, { type: "model_set" }>;
type ThinkingSetMsg = Extract<ClientMessage, { type: "thinking_set" }>;
type ListModelsMsg = Extract<ClientMessage, { type: "list_models" }>;
type SessionListMsg = Extract<ClientMessage, { type: "session_list" }>;
type SessionSwitchMsg = Extract<ClientMessage, { type: "session_switch" }>;

/** Plan/67 — one listed AgentSession. Injected so tests never import the SDK. */
export interface ListedSession {
  id: string;
  path: string;
  name?: string;
  mtime: number;
  preview?: string;
  cwd?: string;
}

export type ListSessionsFn = (cwd: string) => Promise<ListedSession[]>;

export function handleSessionCompact(
  ctx: ActionCtx | null,
  sender: ActionReplySender,
  msg: SessionCompactMsg,
): void {
  runSync(sender, msg, "session_compact", () => {
    if (!ctx?.compact) throw new Error("compact unavailable (no active session ctx)");
    // Force the summary to English regardless of the conversation language —
    // the summary is surfaced to the app via the `compaction` message, which
    // is an English-only surface. `customInstructions` is appended to the SDK's
    // compaction prompt (best-effort: the model writes the summary).
    ctx.compact({
      customInstructions:
        "Always write the compaction summary in English, even if the conversation is in another language.",
    });
  });
}

export async function handleSessionNew(
  ctx: ActionCtx | null,
  sender: ActionReplySender,
  msg: SessionNewMsg,
  onReplaced?: (freshCtx: ActionCtx) => void,
): Promise<boolean> {
  // Returns true only when a fresh session was actually created. index.ts
  // keys the Pi-side reset (clear _messageBuffer, restamp _sessionStartedAt,
  // fan out an empty session_history) off this signal — a `cancelled`/errored
  // new-session must NOT reset, so we return runAsync's success boolean.
  return runAsync(sender, msg, "session_new", async () => {
    if (!ctx?.newSession) throw new Error("newSession unavailable (no command ctx yet)");
    // newSession marks the caller's captured ctx (index.ts's `_lastCtx`) STALE
    // — reusing it later throws "stale after session replacement" (the
    // compact-after-New-session crash). `withSession` hands back a fresh,
    // command-capable ctx bound to the new session; forward it via onReplaced
    // so the caller re-captures and keeps later actions off the stale ctx.
    const result = await ctx.newSession({
      withSession: async (freshCtx) => { onReplaced?.(freshCtx); },
    });
    // `cancelled: true` happens when the SDK's hook chain vetoes the new
    // session (e.g. an extension's `session_before_switch` returned a
    // refusal). Surface as a typed error rather than silent success.
    if (result.cancelled) throw new Error("cancelled by extension hook");
  });
}

export function handleThinkingSet(
  pi: ActionPi,
  sender: ActionReplySender,
  msg: ThinkingSetMsg,
): void {
  runSync(sender, msg, "thinking_set", () => {
    pi.setThinkingLevel(msg.level);
  });
}

export async function handleModelSet(
  pi: ActionPi,
  ctx: ActionCtx | null,
  reg: ActionModelRegistry,
  sender: ActionReplySender,
  msg: ModelSetMsg,
  onPersist?: (provider: string, modelId: string) => void,
): Promise<void> {
  await runAsync(sender, msg, "model_set", async () => {
    // Prefer Pi's LIVE session registry when available so the app sees models
    // registered dynamically by extensions via `pi.registerProvider(...)`.
    // Fall back to remote-pi's own disk-backed registry when no ctx exists.
    const liveReg = ctx?.modelRegistry ?? reg;
    // Refresh first so a model just-added via `/login` is visible.
    liveReg.refresh();
    const model = liveReg.find(msg.provider, msg.model_id);
    if (!model) {
      throw new Error(`model "${msg.provider}/${msg.model_id}" not in registry`);
    }
    const success = await pi.setModel(model);
    if (!success) throw new Error("no auth configured for this model");
    // `pi.setModel` only sets the LIVE model — it does NOT persist. Without
    // this, a model picked from the app reverts to the saved default on the
    // next Pi/daemon restart (the TUI persists because AgentSession.setModel
    // writes the default; this path doesn't). `onPersist` writes the new
    // default so the app's choice survives. Best-effort — the caller's writer
    // must not throw, so a failed settings write never fails the model change.
    onPersist?.(model.provider, model.id);
  });
}

export function handleListModels(
  ctx: ActionCtx | null,
  reg: ActionModelRegistry,
  sender: ActionReplySender,
  msg: ListModelsMsg,
): void {
  // refresh() can throw if `models.json` is malformed — wrap in try so the
  // app gets an explicit error reply instead of a silent drop.
  try {
    // Prefer Pi's LIVE session registry when available so the app sees models
    // registered dynamically by extensions via `pi.registerProvider(...)`.
    // Fall back to remote-pi's own disk-backed registry when no ctx exists.
    const liveReg = ctx?.modelRegistry ?? reg;
    liveReg.refresh();
    const models = liveReg.getAvailable().map(wireFromModel);
    const current = ctx?.getModel?.();
    sender.send({
      type: "models_list",
      in_reply_to: msg.id,
      models,
      current: current ? wireFromModel(current) : undefined,
    });
  } catch (e) {
    sender.send({
      type: "error",
      in_reply_to: msg.id,
      code: "internal_error",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Plan/67 — list AgentSessions for the workspace cwd. */
export async function handleSessionList(
  ctx: ActionCtx | null,
  sender: ActionReplySender,
  msg: SessionListMsg,
  listSessions: ListSessionsFn,
): Promise<void> {
  const cwd = ctx?.cwd;
  if (!cwd) {
    sender.send({
      type: "action_error",
      in_reply_to: msg.id,
      action: "session_list",
      error: "cwd unavailable (no session ctx)",
    });
    return;
  }
  try {
    const listed = await listSessions(cwd);
    const currentId = ctx.getSessionId?.() ?? null;
    sender.send({
      type: "session_list_ok",
      in_reply_to: msg.id,
      current_id: currentId,
      sessions: listed.map((s) => ({
        id: s.id,
        name: s.name,
        mtime: s.mtime,
        preview: s.preview,
        live: currentId != null && s.id === currentId,
        cwd: s.cwd,
      })),
    });
  } catch (e) {
    sender.send({
      type: "action_error",
      in_reply_to: msg.id,
      action: "session_list",
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Plan/67 — switch the live AgentSession.
 * Returns true only when the SDK actually switched (caller must reset the
 * remote-pi mirror). `cancelled` → wire `locked` (no steal).
 */
export async function handleSessionSwitch(
  ctx: ActionCtx | null,
  sender: ActionReplySender,
  msg: SessionSwitchMsg,
  listSessions: ListSessionsFn,
  onReplaced?: (freshCtx: ActionCtx) => void,
): Promise<boolean> {
  if (!ctx?.switchSession) {
    sender.send({
      type: "session_switch_error",
      in_reply_to: msg.id,
      code: "no_sdk",
      message: "switchSession unavailable (no command ctx; daemon needs --resume)",
    });
    return false;
  }
  const cwd = ctx.cwd;
  if (!cwd) {
    sender.send({
      type: "session_switch_error",
      in_reply_to: msg.id,
      code: "unknown",
      message: "cwd unavailable",
    });
    return false;
  }
  let listed: ListedSession[];
  try {
    listed = await listSessions(cwd);
  } catch (e) {
    sender.send({
      type: "session_switch_error",
      in_reply_to: msg.id,
      code: "unknown",
      message: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
  const target = listed.find((s) => s.id === msg.session_id);
  if (!target) {
    sender.send({
      type: "session_switch_error",
      in_reply_to: msg.id,
      code: "unknown",
      message: `session "${msg.session_id}" not in this workspace`,
    });
    return false;
  }
  const currentId = ctx.getSessionId?.();
  if (currentId && currentId === target.id) {
    sender.send({
      type: "session_switch_ok",
      in_reply_to: msg.id,
      session_id: target.id,
      // 0 = unchanged clock; callers must not treat this as a new session.
      session_started_at: 0,
    });
    return false; // already live — do not wipe the mirror
  }
  try {
    const result = await ctx.switchSession(target.path, {
      withSession: async (freshCtx) => { onReplaced?.(freshCtx); },
    });
    if (result.cancelled) {
      sender.send({
        type: "session_switch_error",
        in_reply_to: msg.id,
        code: "locked",
        message: "session switch cancelled (in use or hook refused)",
      });
      return false;
    }
    // Caller (index.ts) sends session_switch_ok AFTER resetting the mirror
    // so session_started_at matches the empty session_history fan-out.
    return true;
  } catch (e) {
    sender.send({
      type: "session_switch_error",
      in_reply_to: msg.id,
      code: "unknown",
      message: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}
