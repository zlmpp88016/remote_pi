/**
 * Plan 01 (Wave 3) — session tree and branching actions.
 *
 * Ported from `zerray/pi-remote-control`'s HTTP handlers for
 * `tree/navigate`, `fork` and `clone`.
 *
 * The load-bearing rule is the **double fence plus busy guard**, which the
 * reference implementation validates server-side before queueing the command:
 *
 *   - `session_busy`    — the agent is streaming; changing the active branch
 *                         mid-run would corrupt the in-flight turn.
 *   - `tree_state_changed` — the client's snapshot or branch version no longer
 *                         matches, so the entry it picked may be gone or the
 *                         leaf it assumed may have moved.
 *   - `target_not_found` / `target_not_forkable` — the id is not in the
 *                         snapshot, or is not a user message.
 *
 * Handlers take their dependencies as parameters (the same convention as the
 * rest of this directory) so the wiring in `index.ts` stays declarative and
 * tests can drive them with fakes.
 */

import type { ClientMessage, ServerMessage, TreeSnapshotWire } from "../protocol/types.js";

/** Minimal channel surface needed to reply. */
export interface ReplyChannel {
  send(msg: ServerMessage): void;
}

/** A context capable of the tree/branching SDK calls plus busy detection. */
export interface TreeActionContext {
  isIdle(): boolean;
  navigateTree(
    targetId: string,
    options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
  ): Promise<{ cancelled: boolean } & Record<string, unknown>>;
  fork(
    entryId: string,
    options?: {
      position?: "before" | "at";
      withSession?: (ctx: unknown) => Promise<void>;
    },
  ): Promise<{ cancelled: boolean } & Record<string, unknown>>;
  /** Current snapshot, or null when the tree is unavailable. */
  buildSnapshot(): TreeSnapshotWire | null;
  /** Text of a user-message entry, for a fork's returned draft. */
  entryText(entryId: string): string;
}

export type TreeActionError =
  | "session_busy"
  | "tree_state_changed"
  | "target_not_found"
  | "target_not_forkable"
  | "cancelled"
  | "aborted"
  | "not_supported";

/** Extract a user-visible message from an SDK error, for logging only. */
function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAborted(error: unknown): boolean {
  return errorDetail(error).toLowerCase().includes("abort");
}

/**
 * Validate a snapshot-based request against the live tree and the busy state.
 * Returns the resolved snapshot, or sends the appropriate error and returns
 * null so the caller stops.
 */
function fence(
  ctx: TreeActionContext,
  sender: ReplyChannel,
  inReplyTo: string,
  action: "tree_navigate" | "session_fork" | "session_clone",
  request: { base_snapshot_version: string; base_branch_version: string; base_leaf_id: string | null },
): TreeSnapshotWire | null {
  if (!ctx.isIdle()) {
    sender.send({
      type: "action_error",
      in_reply_to: inReplyTo,
      action,
      error: "session_busy",
    } satisfies ServerMessage);
    return null;
  }
  const snapshot = ctx.buildSnapshot();
  if (!snapshot) {
    sender.send({
      type: "action_error",
      in_reply_to: inReplyTo,
      action,
      error: "tree_state_changed",
    } satisfies ServerMessage);
    return null;
  }
  // Compare the leaf as well as both versions: a branch move can leave the
  // versions stale in ways the client's own bookkeeping might miss.
  if (
    snapshot.snapshot_version !== request.base_snapshot_version
    || snapshot.branch_version !== request.base_branch_version
    || snapshot.leaf_id !== request.base_leaf_id
  ) {
    sender.send({
      type: "action_error",
      in_reply_to: inReplyTo,
      action,
      error: "tree_state_changed",
    } satisfies ServerMessage);
    return null;
  }
  return snapshot;
}

/** `tree_get` — read-only snapshot; always allowed, even while busy. */
export async function handleTreeGet(
  ctx: TreeActionContext | null,
  sender: ReplyChannel,
  msg: Extract<ClientMessage, { type: "tree_get" }>,
): Promise<void> {
  const snapshot = ctx?.buildSnapshot() ?? null;
  if (!snapshot) {
    sender.send({
      type: "action_error",
      in_reply_to: msg.id,
      action: "tree_get",
      error: "tree_state_unavailable",
    } satisfies ServerMessage);
    return;
  }
  sender.send({ type: "tree_snapshot_ok", in_reply_to: msg.id, snapshot } satisfies ServerMessage);
}

/** `tree_navigate` — move the active branch to another entry. */
export async function handleTreeNavigate(
  ctx: TreeActionContext | null,
  sender: ReplyChannel,
  msg: Extract<ClientMessage, { type: "tree_navigate" }>,
): Promise<void> {
  const fail = (error: TreeActionError) =>
    sender.send({ type: "action_error", in_reply_to: msg.id, action: "tree_navigate", error } satisfies ServerMessage);

  if (!ctx) {
    fail("not_supported");
    return;
  }
  if (!fence(ctx, sender, msg.id, "tree_navigate", msg)) return;
  if (!ctx.buildSnapshot()?.entries.some((entry) => entry.id === msg.target_entry_id)) {
    fail("target_not_found");
    return;
  }

  try {
    const result = await ctx.navigateTree(msg.target_entry_id, { summarize: msg.summarize === true });
    if (result.cancelled) {
      fail("cancelled");
      return;
    }
    const snapshot = ctx.buildSnapshot();
    if (!snapshot) {
      fail("tree_state_changed");
      return;
    }
    const editorText = typeof result["editorText"] === "string" ? (result["editorText"] as string) : undefined;
    sender.send({
      type: "tree_navigate_ok",
      in_reply_to: msg.id,
      leaf_id: snapshot.leaf_id,
      snapshot_version: snapshot.snapshot_version,
      branch_version: snapshot.branch_version,
      ...(editorText === undefined ? {} : { editor_text: editorText }),
    } satisfies ServerMessage);
  } catch (error) {
    fail(isAborted(error) ? "aborted" : "cancelled");
  }
}

/**
 * `session_clone` — duplicate the active branch into a new session.
 *
 * `onReplaced` lets the caller re-point its live context at the replacement
 * session; branching replaces the running session, so remote control has to
 * follow it.
 */
export async function handleSessionClone(
  ctx: TreeActionContext | null,
  sender: ReplyChannel,
  msg: Extract<ClientMessage, { type: "session_clone" }>,
  onReplaced?: (freshCtx: unknown) => void,
): Promise<void> {
  const fail = (error: TreeActionError) =>
    sender.send({ type: "action_error", in_reply_to: msg.id, action: "session_clone", error } satisfies ServerMessage);

  if (!ctx) {
    fail("not_supported");
    return;
  }
  const snapshot = fence(ctx, sender, msg.id, "session_clone", msg);
  if (!snapshot) return;
  // Cloning from the root is meaningless — there is no branch to copy.
  if (!msg.base_leaf_id) {
    fail("tree_state_changed");
    return;
  }

  try {
    const result = await ctx.fork(msg.base_leaf_id, {
      position: "at",
      withSession: async (freshCtx) => { onReplaced?.(freshCtx); },
    });
    if (result.cancelled) {
      fail("cancelled");
      return;
    }
    sender.send({ type: "session_clone_ok", in_reply_to: msg.id } satisfies ServerMessage);
  } catch (error) {
    fail(isAborted(error) ? "aborted" : "cancelled");
  }
}

/**
 * `session_fork` — branch from before a user message and return its text.
 *
 * The returned draft goes to the composer and is never sent automatically:
 * re-running the prompt is the user's decision.
 */
export async function handleSessionFork(
  ctx: TreeActionContext | null,
  sender: ReplyChannel,
  msg: Extract<ClientMessage, { type: "session_fork" }>,
  onReplaced?: (freshCtx: unknown) => void,
): Promise<void> {
  const fail = (error: TreeActionError) =>
    sender.send({ type: "action_error", in_reply_to: msg.id, action: "session_fork", error } satisfies ServerMessage);

  if (!ctx) {
    fail("not_supported");
    return;
  }
  const snapshot = fence(ctx, sender, msg.id, "session_fork", msg);
  if (!snapshot) return;

  const target = snapshot.entries.find((entry) => entry.id === msg.target_entry_id);
  if (!target) {
    fail("target_not_found");
    return;
  }
  if (!target.is_forkable) {
    fail("target_not_forkable");
    return;
  }

  try {
    const editorText = ctx.entryText(msg.target_entry_id);
    const result = await ctx.fork(msg.target_entry_id, {
      position: "before",
      withSession: async (freshCtx) => { onReplaced?.(freshCtx); },
    });
    if (result.cancelled) {
      fail("cancelled");
      return;
    }
    sender.send({ type: "session_fork_ok", in_reply_to: msg.id, editor_text: editorText } satisfies ServerMessage);
  } catch (error) {
    fail(isAborted(error) ? "aborted" : "cancelled");
  }
}
