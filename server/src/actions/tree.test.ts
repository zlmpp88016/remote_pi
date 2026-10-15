import { describe, expect, it } from "vitest";
import type { ServerMessage, TreeSnapshotWire } from "../protocol/types.js";
import {
  handleSessionClone,
  handleSessionFork,
  handleTreeGet,
  handleTreeNavigate,
  type ReplyChannel,
  type TreeActionContext,
} from "./tree.js";

function sender(): ReplyChannel & { sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  return { sent, send: (msg) => { sent.push(msg); } };
}

function snapshot(overrides: Partial<TreeSnapshotWire> = {}): TreeSnapshotWire {
  return {
    snapshot_version: "treev_1",
    branch_version: "branchv_1",
    leaf_id: "u2",
    entries: [
      {
        id: "u1",
        parent_id: null,
        type: "message",
        role: "user",
        title: "user",
        preview: "first",
        timestamp: "2026-09-29T10:00:00.000Z",
        is_current_leaf: false,
        is_on_active_branch: true,
        is_forkable: true,
        navigation_behavior: "edit_prompt",
      },
      {
        id: "u2",
        parent_id: "u1",
        type: "message",
        role: "user",
        title: "user",
        preview: "second",
        timestamp: "2026-09-29T10:01:00.000Z",
        is_current_leaf: true,
        is_on_active_branch: true,
        is_forkable: true,
        navigation_behavior: "edit_prompt",
      },
      {
        id: "a1",
        parent_id: "u2",
        type: "message",
        role: "assistant",
        title: "assistant",
        preview: "reply",
        timestamp: "2026-09-29T10:02:00.000Z",
        is_current_leaf: false,
        is_on_active_branch: true,
        is_forkable: false,
        navigation_behavior: "navigate",
      },
    ],
    default_filter: "default",
    filters: ["default"],
    generated_at: "2026-09-29T10:03:00.000Z",
    ...overrides,
  };
}

/** A context that records calls and can be told to fail. */
function context(overrides: Partial<TreeActionContext> = {}): TreeActionContext & {
  calls: { navigate: unknown[]; fork: unknown[] };
} {
  const calls = { navigate: [] as unknown[], fork: [] as unknown[] };
  return {
    calls,
    isIdle: () => true,
    navigateTree: async (targetId, options) => { calls.navigate.push({ targetId, options }); return { cancelled: false }; },
    fork: async (entryId, options) => {
      calls.fork.push({ entryId, options });
      // Branching replaces the session; exercise the callback like the SDK does.
      await options?.withSession?.({ replaced: true });
      return { cancelled: false };
    },
    buildSnapshot: () => snapshot(),
    entryText: () => "second",
    ...overrides,
  };
}

const baseFence = { base_snapshot_version: "treev_1", base_branch_version: "branchv_1", base_leaf_id: "u2" };

describe("handleTreeGet", () => {
  it("returns the snapshot", async () => {
    const out = sender();
    await handleTreeGet(context(), out, { type: "tree_get", id: "r1" });
    expect(out.sent[0]).toEqual({ type: "tree_snapshot_ok", in_reply_to: "r1", snapshot: snapshot() });
  });

  it("errors when the tree is unavailable", async () => {
    const out = sender();
    await handleTreeGet(context({ buildSnapshot: () => null }), out, { type: "tree_get", id: "r1" });
    expect(out.sent[0]).toMatchObject({ type: "action_error", error: "tree_state_unavailable" });
  });

  it("errors when there is no context", async () => {
    const out = sender();
    await handleTreeGet(null, out, { type: "tree_get", id: "r1" });
    expect(out.sent[0]).toMatchObject({ type: "action_error", error: "tree_state_unavailable" });
  });

  it("reads the tree even while the agent is busy", async () => {
    const out = sender();
    await handleTreeGet(context({ isIdle: () => false }), out, { type: "tree_get", id: "r1" });
    expect(out.sent[0]).toMatchObject({ type: "tree_snapshot_ok" });
  });
});

describe("handleTreeNavigate", () => {
  it("navigates when the fence matches", async () => {
    const out = sender();
    const ctx = context();
    await handleTreeNavigate(ctx, out, { type: "tree_navigate", id: "r1", target_entry_id: "u1", ...baseFence });
    expect(ctx.calls.navigate).toEqual([{ targetId: "u1", options: { summarize: false } }]);
    expect(out.sent[0]).toMatchObject({ type: "tree_navigate_ok", leaf_id: "u2", snapshot_version: "treev_1" });
  });

  it("passes the summarize flag through", async () => {
    const out = sender();
    const ctx = context();
    await handleTreeNavigate(ctx, out, { type: "tree_navigate", id: "r1", target_entry_id: "u1", summarize: true, ...baseFence });
    expect(ctx.calls.navigate).toEqual([{ targetId: "u1", options: { summarize: true } }]);
  });

  it("returns the editor text when the SDK supplies one", async () => {
    const out = sender();
    const ctx = context({ navigateTree: async () => ({ cancelled: false, editorText: "draft" }) });
    await handleTreeNavigate(ctx, out, { type: "tree_navigate", id: "r1", target_entry_id: "u1", ...baseFence });
    expect(out.sent[0]).toMatchObject({ editor_text: "draft" });
  });

  it("refuses while the agent is streaming", async () => {
    const out = sender();
    const ctx = context({ isIdle: () => false });
    await handleTreeNavigate(ctx, out, { type: "tree_navigate", id: "r1", target_entry_id: "u1", ...baseFence });
    expect(out.sent[0]).toMatchObject({ type: "action_error", error: "session_busy" });
    expect(ctx.calls.navigate).toHaveLength(0);
  });

  it("refuses a stale snapshot version", async () => {
    const out = sender();
    const ctx = context();
    await handleTreeNavigate(ctx, out, { type: "tree_navigate", id: "r1", target_entry_id: "u1", ...baseFence, base_snapshot_version: "old" });
    expect(out.sent[0]).toMatchObject({ error: "tree_state_changed" });
    expect(ctx.calls.navigate).toHaveLength(0);
  });

  it("refuses a stale branch version", async () => {
    const out = sender();
    await handleTreeNavigate(context(), out, { type: "tree_navigate", id: "r1", target_entry_id: "u1", ...baseFence, base_branch_version: "old" });
    expect(out.sent[0]).toMatchObject({ error: "tree_state_changed" });
  });

  it("refuses a stale leaf id", async () => {
    const out = sender();
    await handleTreeNavigate(context(), out, { type: "tree_navigate", id: "r1", target_entry_id: "u1", ...baseFence, base_leaf_id: "other" });
    expect(out.sent[0]).toMatchObject({ error: "tree_state_changed" });
  });

  it("refuses an unknown target", async () => {
    const out = sender();
    await handleTreeNavigate(context(), out, { type: "tree_navigate", id: "r1", target_entry_id: "nope", ...baseFence });
    expect(out.sent[0]).toMatchObject({ error: "target_not_found" });
  });

  it("reports cancellation", async () => {
    const out = sender();
    const ctx = context({ navigateTree: async () => ({ cancelled: true }) });
    await handleTreeNavigate(ctx, out, { type: "tree_navigate", id: "r1", target_entry_id: "u1", ...baseFence });
    expect(out.sent[0]).toMatchObject({ error: "cancelled" });
  });

  it("maps a thrown abort to aborted and anything else to cancelled", async () => {
    const aborted = sender();
    await handleTreeNavigate(
      context({ navigateTree: async () => { throw new Error("operation aborted"); } }),
      aborted,
      { type: "tree_navigate", id: "r1", target_entry_id: "u1", ...baseFence },
    );
    expect(aborted.sent[0]).toMatchObject({ error: "aborted" });

    const failed = sender();
    await handleTreeNavigate(
      context({ navigateTree: async () => { throw new Error("summarization failed"); } }),
      failed,
      { type: "tree_navigate", id: "r1", target_entry_id: "u1", ...baseFence },
    );
    expect(failed.sent[0]).toMatchObject({ error: "cancelled" });
  });

  it("reports not_supported without a context", async () => {
    const out = sender();
    await handleTreeNavigate(null, out, { type: "tree_navigate", id: "r1", target_entry_id: "u1", ...baseFence });
    expect(out.sent[0]).toMatchObject({ error: "not_supported" });
  });
});

describe("handleSessionClone", () => {
  it("clones at the current leaf", async () => {
    const out = sender();
    const ctx = context();
    await handleSessionClone(ctx, out, { type: "session_clone", id: "r1", ...baseFence });
    expect(ctx.calls.fork[0]).toMatchObject({ entryId: "u2", options: { position: "at" } });
    expect(out.sent[0]).toMatchObject({ type: "session_clone_ok" });
  });

  it("notifies the caller about the replacement session", async () => {
    const out = sender();
    const replacements: unknown[] = [];
    await handleSessionClone(context(), out, { type: "session_clone", id: "r1", ...baseFence }, (fresh) => replacements.push(fresh));
    expect(replacements).toEqual([{ replaced: true }]);
  });

  it("refuses a null leaf", async () => {
    const out = sender();
    const ctx = context();
    await handleSessionClone(ctx, out, { type: "session_clone", id: "r1", ...baseFence, base_leaf_id: null });
    expect(out.sent[0]).toMatchObject({ error: "tree_state_changed" });
    expect(ctx.calls.fork).toHaveLength(0);
  });

  it("refuses while busy", async () => {
    const out = sender();
    await handleSessionClone(context({ isIdle: () => false }), out, { type: "session_clone", id: "r1", ...baseFence });
    expect(out.sent[0]).toMatchObject({ error: "session_busy" });
  });

  it("reports cancellation", async () => {
    const out = sender();
    await handleSessionClone(context({ fork: async () => ({ cancelled: true }) }), out, { type: "session_clone", id: "r1", ...baseFence });
    expect(out.sent[0]).toMatchObject({ error: "cancelled" });
  });
});

describe("handleSessionFork", () => {
  it("forks before the target and returns its text", async () => {
    const out = sender();
    const ctx = context();
    await handleSessionFork(ctx, out, { type: "session_fork", id: "r1", target_entry_id: "u1", ...baseFence });
    expect(ctx.calls.fork[0]).toMatchObject({ entryId: "u1", options: { position: "before" } });
    expect(out.sent[0]).toEqual({ type: "session_fork_ok", in_reply_to: "r1", editor_text: "second" });
  });

  it("refuses a non-user target", async () => {
    const out = sender();
    const ctx = context();
    await handleSessionFork(ctx, out, { type: "session_fork", id: "r1", target_entry_id: "a1", ...baseFence });
    expect(out.sent[0]).toMatchObject({ error: "target_not_forkable" });
    expect(ctx.calls.fork).toHaveLength(0);
  });

  it("refuses an unknown target", async () => {
    const out = sender();
    await handleSessionFork(context(), out, { type: "session_fork", id: "r1", target_entry_id: "nope", ...baseFence });
    expect(out.sent[0]).toMatchObject({ error: "target_not_found" });
  });

  it("refuses while busy", async () => {
    const out = sender();
    await handleSessionFork(context({ isIdle: () => false }), out, { type: "session_fork", id: "r1", target_entry_id: "u1", ...baseFence });
    expect(out.sent[0]).toMatchObject({ error: "session_busy" });
  });

  it("refuses a stale fence", async () => {
    const out = sender();
    await handleSessionFork(context(), out, { type: "session_fork", id: "r1", target_entry_id: "u1", ...baseFence, base_branch_version: "old" });
    expect(out.sent[0]).toMatchObject({ error: "tree_state_changed" });
  });

  it("notifies the caller about the replacement session", async () => {
    const out = sender();
    const replacements: unknown[] = [];
    await handleSessionFork(context(), out, { type: "session_fork", id: "r1", target_entry_id: "u1", ...baseFence }, (fresh) => replacements.push(fresh));
    expect(replacements).toEqual([{ replaced: true }]);
  });
});
