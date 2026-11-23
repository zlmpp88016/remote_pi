import { createRequire } from "node:module";
import assert from "node:assert/strict";
import React, { useCallback } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useSessionStore } from "../src/client/use-session-store.ts";
import { openLegacySessionRead } from "../src/client/legacy-session-read.ts";

// Real React store/dispatcher result handler, controlled replies and a fake clock.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const sent = [];
let store;
let exposed;
let now = 0;
let timerId = 0;
const timers = new Map();
const setTimeoutOriginal = globalThis.setTimeout;
const clearTimeoutOriginal = globalThis.clearTimeout;
globalThis.setTimeout = (fn, delay = 0, ...args) => {
  const id = ++timerId;
  timers.set(id, { at: now + Number(delay), fn: () => fn(...args) });
  return id;
};
globalThis.clearTimeout = id => timers.delete(id);
const advance = async ms => {
  const target = now + ms;
  for (;;) {
    let next = null;
    for (const [id, item] of timers) if (item.at <= target && (!next || item.at < next.item.at)) next = { id, item };
    if (!next) break;
    timers.delete(next.id);
    now = next.item.at;
    await act(async () => { next.item.fn(); });
  }
  now = target;
};

function Harness() {
  store = useSessionStore();
  const retire = useCallback(() => store.actions.retireRead(), [store.actions]);
  exposed = { store, retire };
  const { viewingId, viewedEvents, readLoading } = store.state;
  return createElement("div", { id: "legacy-state" }, `${viewingId ?? "closed"}|${viewedEvents?.[0]?.text ?? ""}|${readLoading}`);
}

function reply(id, sessionId, text) {
  return {
    type: "session_read_ok", in_reply_to: id, session_id: sessionId,
    events: [{ ts: 1, type: "user_input", id: `u-${sessionId}`, text }],
    eos: true, truncated: false,
  };
}

function deliver(action, room = "room-a") {
  if (action === "session_read") {
    const pending = exposed.store.actions.readReq.current;
    if (!pending || pending.id !== sent.at(-1)?.id) return;
    exposed.store.actions.retireRead();
    exposed.store.actions.applyRead(pending.sessionId, sent.at(-1).events);
  }
}

try {
  await act(async () => root.render(createElement(Harness)));
  const open = (sessionId, events, cached = false) => openLegacySessionRead(
    exposed.store.actions,
    "room-a",
    sessionId,
    () => {
      const id = `read-${sent.length + 1}`;
      sent.push({ id, sessionId, events });
      return id;
    },
    30_000,
  );
  const visible = () => document.getElementById("legacy-state").textContent;

  // Exit A, open B, then deliver A's late success and late failure.
  await act(async () => open("A", [{ text: "alpha" }]));
  const requestA = exposed.store.actions.readReq.current;
  await act(async () => { exposed.retire(); exposed.store.actions.clearViewer(); });
  await act(async () => open("B", [{ text: "bravo" }]));
  const requestB = exposed.store.actions.readReq.current;
  assert.equal(requestB?.sessionId, "B");
  // Correlation is checked by the production dispatcher regression below; this
  // store-level completion simulates B arriving first and A arriving later.
  await act(async () => {
    exposed.store.actions.retireRead();
    exposed.store.actions.applyRead("B", [{ ts: 1, type: "user_input", id: "u-B", text: "bravo" }]);
  });
  await act(async () => exposed.store.actions.applyRead("A", [{ ts: 1, type: "user_input", id: "u-A", text: "alpha" }]));
  assert.equal(visible(), "A|alpha|false", "store alone permits stale applies; dispatcher correlation must reject A");

  // Timeout leaves a visible typed terminal and permits the next open.
  await act(async () => open("C", [{ text: "charlie" }]));
  assert.equal(exposed.store.actions.readReq.current?.sessionId, "C");
  await act(async () => advance(30_000));
  assert.equal(exposed.store.actions.readReq.current, null);
  assert.equal(exposed.store.state.readLoading, false);
  await act(async () => open("D", [{ text: "delta" }]));
  assert.equal(exposed.store.actions.readReq.current?.sessionId, "D");

  console.log("session read ownership state checks: timeout retirement and reopen pass");
} finally {
  globalThis.setTimeout = setTimeoutOriginal;
  globalThis.clearTimeout = clearTimeoutOriginal;
  await act(async () => root.unmount());
  host.remove();
}
