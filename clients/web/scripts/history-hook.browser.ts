/** Browser regression over the real React DOM + production hook. Bundle with
 * esbuild (tsconfig alias resolution), serve alongside an HTML #root, then call
 * await window.runHistoryHookRegression(). No host, credentials or Pi involved.
 */
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useHostHistory, type HistoryHostApi } from "../src/client/use-history";
import { HISTORY_BUILDING } from "../src/client/notices";
import { SessionList } from "../src/components/remote-pi/sessions/session-list";
import type { RemotePiAdapter } from "../src/lib/remote-pi/adapter";

declare global {
  interface Window { runHistoryHookRegression: () => Promise<{ checks: number; renders: number }> }
}

window.runHistoryHookRegression = async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let checks = 0;
  let renders = 0;
  const check = (ok: boolean, label: string) => {
    checks++;
    if (!ok) throw new Error(label);
  };
  const sent: Array<Record<string, unknown>> = [];
  const barriers = new Set<unknown>();
  const adapter = {
    boundHostPeer: "hook-host",
    sendHistory: (request: Record<string, unknown>) => sent.push(request),
    reprioritizeHistory: () => {},
    onHistoryBarrier: (fn: unknown) => { barriers.add(fn); return () => barriers.delete(fn); },
  } as unknown as RemotePiAdapter;
  let api: HistoryHostApi;
  let daemonId = "hook-workspace";
  let generation = 1;
  let capabilities = ["workspace_history_v1"];
  function Harness() {
    renders++;
    api = useHostHistory({ adapter, generation, capabilities, daemonId, viewingSessionId: "s1" });
    const { available, scope, actions } = api;
    useEffect(() => { if (available && scope) actions.openList(); }, [available, scope, actions]);
    return createElement("div", null,
      createElement("span", { id: "rows" }, api.listView?.rows.map(row => row.name).join(",") ?? ""),
      createElement("span", { id: "items" }, api.view?.items.map(item => item.event_id).join(",") ?? ""),
      api.listView?.index_state === "building" ? createElement(SessionList, {
        sessions: [], busy: api.listView.loading, disabledReason: null, viewingId: null,
        liveId: null, notice: HISTORY_BUILDING, now: 0, onOpen: actions.refreshList, onRead() {},
      }) : null);
  }
  const root = createRoot(document.getElementById("root")!);
  const render = async () => { await act(async () => { root.render(createElement(Harness)); }); };
  try {
    await render();
    check(sent.length === 1 && sent[0].type === "history_list", "initial mount must send history_list without a controller yet");
    const actions = api!.actions;
    await act(async () => { api!.actions.feed({
      type: "history_list_ok", in_reply_to: sent[0].id, daemon_id: daemonId,
      revision: null, index_state: "building",
      current: { session_id: null, ready: null, state: null, source: "unknown" },
      sessions: [], next_cursor: null, has_more: false, retry_after_ms: 5,
    }); });
    check(api!.listView?.index_state === "building", "successful building reply remains a transient hook state");
    const text = document.getElementById("root")!.textContent ?? "";
    check(text.includes(HISTORY_BUILDING) && !text.includes("无法加载") && !text.includes("该工作区还没有会话"),
      "building list shows progress rather than false failure or empty terminal");
    await act(async () => {
      const deadline = performance.now() + 1000;
      while (sent.length < 2 && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    });
    check(sent.length === 2 && sent[1].type === "history_list" && sent[1].id !== sent[0].id,
      "building success triggers one fresh list request through the real hook");
    await act(async () => { api!.actions.feed({
      type: "history_list_ok", in_reply_to: sent[1].id, daemon_id: daemonId,
      revision: "lr1", index_state: "ready",
      current: { session_id: null, ready: null, state: null, source: "unknown" },
      sessions: [{ id: "s1", name: "Hook row", mtime: 1, preview: null }],
      next_cursor: null, has_more: false, retry_after_ms: null,
    }); });
    check(document.getElementById("rows")!.textContent === "Hook row", "notification must paint list response in React DOM");
    check(api!.actions === actions && sent.length === 2, "list response keeps actions stable without effect feedback");
    await act(async () => { api!.actions.openSession("s1", "foreground", "viewer"); });
    const read = sent.find(request => request.type === "history_read")!;
    await act(async () => { api!.actions.feed({
      type: "history_read_ok", in_reply_to: read.id, daemon_id: daemonId, session_id: "s1",
      snapshot: "snap1", revision: "r1", projection: 1,
      session: { id: "s1", name: null, mtime: 1, preview: null },
      items: [{ event_id: "painted-event", entry_id: "entry1", event: { ts: 1, type: "user_input", id: "u1", text: "fixture" } }],
      older_cursor: null, has_older: false,
    }); });
    check(document.getElementById("items")!.textContent === "painted-event", "notification must paint read response in React DOM");
    check(api!.actions === actions && barriers.size === 1, "notifications do not recreate controllers or subscriptions");
    daemonId = "second-workspace";
    await render();
    check(sent.at(-1)?.type === "history_list" && sent.at(-1)?.daemon_id === daemonId, "workspace switch opens correct scope");
    check(document.getElementById("rows")!.textContent === "", "workspace switch never paints previous rows");
    generation++;
    await render();
    check(sent.at(-1)?.daemon_id === daemonId && barriers.size === 1, "generation rollover replaces subscription once");
    const count = sent.length;
    capabilities = [];
    await render();
    check(!api!.available && api!.scope === null && sent.length === count, "old host has no history requests");
    check(renders < 25, "bounded render count without effect loop");
  } finally {
    await act(async () => { root.unmount(); });
  }
  check(barriers.size === 0, "unmount disposes barrier subscription");
  return { checks, renders };
};
