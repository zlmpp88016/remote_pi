import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { dispatchServerMessage } from "../src/client/dispatcher";
import { openLegacySessionRead } from "../src/client/legacy-session-read";
import { useSessionStore } from "../src/client/use-session-store";

declare global { interface Window { runSessionReopenRegression: () => Promise<{ checks: number }> } }

window.runSessionReopenRegression = async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let checks = 0;
  const check = (condition: boolean, label: string) => { checks++; if (!condition) throw Error(label); };
  let actions: ReturnType<typeof useSessionStore>["actions"];
  function StoreHarness(): ReactNode {
    const store = useSessionStore();
    actions = store.actions;
    return createElement("output", { id: "store-state" }, JSON.stringify({ ...store.state, byRoom: undefined }));
  }
  const root = createRoot(document.getElementById("root")!);
  await act(async () => { root.render(createElement(StoreHarness)); });
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let now = 0, seq = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const readTimers = new Set<number>();
  globalThis.setTimeout = ((callback: TimerHandler, ms?: number) => {
    const id = ++seq;
    if (ms === 20) readTimers.add(id);
    timers.set(id, { at: now + (ms ?? 0), callback: callback as () => void });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => { timers.delete(id as unknown as number); readTimers.delete(id as unknown as number); }) as typeof clearTimeout;
  const advance = async (ms: number) => {
    now += ms;
    const due = [...timers].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at);
    for (const [id, timer] of due) { timers.delete(id); readTimers.delete(id); await act(async () => { timer.callback(); }); }
  };
  const rootElement = () => JSON.parse(document.getElementById("store-state")!.textContent!);
  const ports = () => {
    const ref = actions.readReq;
    const activeRoomRef = { current: "room" as string | null };
    const calls = { loading: [] as boolean[], notices: [] as (string | null)[], opened: [] as { id: string; events: unknown[] }[] };
    const noop = () => {};
    return { ref, calls, ports: {
      activeRoomRef, modelReqRef: { current: null }, modelSetRef: { current: null }, thinkingReqRef: { current: null },
      skillsReqRef: { current: null }, skillInvokeRef: { current: null }, packageReqRef: { current: null }, onPackageConfirmed: noop,
      sessionsReqRef: { current: null },
      sessionReadReqRef: ref, prefetchReqRef: { current: null }, sessionSwitchReqRef: { current: null }, sessionNewReqRef: { current: null },
      pendingModelChoiceRef: { current: null }, setModelBusy: noop, setModelNotice: noop, setModelSwitchTo: noop,
      setSkillsBusy: noop, setSkillsNotice: noop, setSessionsBusy: noop, setSessionsNotice: (v: string | null) => calls.notices.push(v),
      setSessionReadLoading: (v: boolean) => { calls.loading.push(v); actions.setReadLoading(v); }, retireSessionRead: actions.retireRead,
      setSwitchLoading: noop, setConfirmedByRoom: noop, setSessionsByRoom: noop, setSessionCaps: noop,
      applyCatalogue: noop, applySkills: noop, markRowCurrent: noop, confirmCachedModel: noop,
      openViewer: (id: string, events: unknown[]) => calls.opened.push({ id, events }), cacheRead: noop, clearViewer: actions.clearViewer,
      relistAfterSwitch: noop, resyncLive: noop, resetChatState: noop, runPrefetchNext: noop, dispatchChat: noop, refreshSurface: noop,
    }, activeRoomRef };
  };
  const error = (id: string, explicit = true) => ({ type: "action_error" as const, in_reply_to: id,
    ...(explicit ? { action: "session_read" as const } : {}), error: "untrusted host text" });
  try {
    await act(async () => openLegacySessionRead(actions, "room", "A", () => "A", 20));
    const pendingA = actions.readReq.current;
    check(pendingA?.id === "A" && rootElement().readLoading && readTimers.size === 1, "A opens with foreground owner and watchdog");
    await advance(10);
    await act(async () => actions.clearViewer());
    check(actions.readReq.current === null && !rootElement().readLoading && readTimers.size === 0, "close retires A and cancels its watchdog");
    await act(async () => openLegacySessionRead(actions, "room", "B", () => "B", 20));
    const pendingB = actions.readReq.current;
    await advance(10);
    check(actions.readReq.current === pendingB && rootElement().readLoading, "cancelled A timeout cannot clear B");
    await act(async () => actions.applyRead("B", []));
    check(actions.readReq.current === null && readTimers.size === 0 && rootElement().viewingId === "B", "B reply settles current read and cancels timer");

    const h = ports();
    h.ref.current = { id: "B", room: "room", sessionId: "B" };
    await act(async () => actions.setReadLoading(true));
    dispatchServerMessage(error("A"), "room", h.ports as never);
    check(h.ref.current?.id === "B" && rootElement().readLoading, "late generic action_error A cannot clear B ownership/loading");
    await act(async () => { dispatchServerMessage(error("B"), "room", h.ports as never); });
    check(h.ref.current === null && !rootElement().readLoading, "matching generic action_error B retires B");

    await act(async () => openLegacySessionRead(actions, "room", "A", () => "A", 20));
    await act(async () => openLegacySessionRead(actions, "room", "B", () => "B", 20));
    await act(async () => openLegacySessionRead(actions, "room", "A", () => "A2", 20));
    const currentA = actions.readReq.current;
    await act(async () => { dispatchServerMessage({ type: "session_read_ok", in_reply_to: "B", session_id: "B", events: [], eos: true, truncated: false }, "room", ports().ports as never); });
    check(currentA?.id === "A2" && actions.readReq.current === currentA && rootElement().viewingId === "A" && rootElement().viewedEvents === null,
      "A-to-B-to-A rejects prior B reply despite repeated session id");

    await act(async () => actions.clearViewer());
    await act(async () => openLegacySessionRead(actions, "room", "same-session", () => "same-old", 20));
    await act(async () => openLegacySessionRead(actions, "room", "same-session", () => "same-current", 20));
    const sameSessionCurrent = actions.readReq.current;
    dispatchServerMessage(error("same-old"), "room", ports().ports as never);
    await act(async () => { dispatchServerMessage({ type: "session_read_ok", in_reply_to: "same-old", session_id: "same-session", events: [], eos: true, truncated: false }, "room", ports().ports as never); });
    check(sameSessionCurrent?.id === "same-current" && actions.readReq.current === sameSessionCurrent &&
      rootElement().readLoading && rootElement().viewedEvents === null && readTimers.size === 1,
      "same-session reopen rejects an older generic error and success by request id");
    await act(async () => { dispatchServerMessage(error("same-current"), "room", ports().ports as never); });
    check(actions.readReq.current === null && !rootElement().readLoading && readTimers.size === 0,
      "same-session current refusal retires only the reopened read");

    await act(async () => openLegacySessionRead(actions, "room", "wrong-room", () => "wrong-room-id", 20));
    const wrongRoomPending = actions.readReq.current;
    const wrongRoomHarness = ports();
    wrongRoomHarness.activeRoomRef.current = "other-room";
    dispatchServerMessage(error("wrong-room-id"), "other-room", wrongRoomHarness.ports as never);
    await act(async () => { dispatchServerMessage({ type: "session_read_ok", in_reply_to: "wrong-room-id", session_id: "wrong-room", events: [], eos: true, truncated: false }, "other-room", wrongRoomHarness.ports as never); });
    check(wrongRoomPending !== null && actions.readReq.current === wrongRoomPending && rootElement().readLoading &&
      rootElement().viewedEvents === null && readTimers.size === 1,
      "same request id routed from a wrong room cannot settle the foreground read");
    wrongRoomHarness.activeRoomRef.current = "room";
    await act(async () => { dispatchServerMessage(error("wrong-room-id"), "room", wrongRoomHarness.ports as never); });
    check(actions.readReq.current === null && !rootElement().readLoading && readTimers.size === 0,
      "the owning room can settle its read after a wrong-room reply");

    await act(async () => actions.clearViewer());
    await act(async () => openLegacySessionRead(actions, "room", "A", () => "A", 20));
    await act(async () => { actions.cacheRead("B", []); openLegacySessionRead(actions, "room", "B", () => { throw Error("cached path sent"); }, 20); });
    check(actions.readReq.current === null && readTimers.size === 0 && rootElement().viewingId === "B" && !rootElement().readLoading,
      "cached B consumes transcript and retires A's pending timer");
    await act(async () => actions.clearViewer());
    await act(async () => openLegacySessionRead(actions, "room", "X", () => { throw Error("synchronous transport failure"); }, 20));
    check(actions.readReq.current === null && readTimers.size === 0 && !rootElement().readLoading && rootElement().notice !== null,
      "synchronous adapter failure terminates spinner without an id or timer");
    await act(async () => openLegacySessionRead(actions, "room", "timeout", () => "timeout-id", 20));
    await advance(20);
    check(actions.readReq.current === null && !rootElement().readLoading && rootElement().notice !== null && readTimers.size === 0,
      "unanswered current legacy read has a bounded terminal deadline");
    await act(async () => openLegacySessionRead(actions, "room", "unmount", () => "unmount-id", 20));
  } finally {
    await act(async () => root.unmount());
    check(readTimers.size === 0, "unmount cancels the owned read watchdog");
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
  return { checks };
};
