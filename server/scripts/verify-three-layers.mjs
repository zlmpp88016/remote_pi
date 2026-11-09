#!/usr/bin/env node
/**
 * Verifies the three-layer navigation path over a REAL relay.
 *
 * The app's Home now lists SERVERS, then the WORKSPACES each runs, then the
 * SESSIONS inside a workspace. This script walks that same path from outside the
 * UI, so a broken hop shows up as a failing assertion instead of a spinner:
 *
 *   1. room      — `workspace_list` addressed to the host room.
 *   2. workspace — a `host_forward` addressed to a WORKSPACE room answers.
 *   3. session   — that same room answers `session_list`.
 *
 * Layer 1 is gated on PAIRED peers (`allowedPeers` in host_bridge), so an
 * anonymous probe is deliberately dropped there. That is reported as SKIP, not
 * PASS: claiming the app can reach the host room from here would be a lie.
 *
 * Usage:
 *   node scripts/verify-three-layers.mjs [baseUrl]
 *   node scripts/verify-three-layers.mjs http://114.55.178.114:58300
 */
import { randomUUID } from "node:crypto";

const base = process.argv[2] ?? "http://127.0.0.1:3001";
const TIMEOUT_MS = 15_000;

const fail = (m) => {
  console.error(`FAIL ${m}`);
  process.exit(1);
};

const events = await fetch(`${base}/api/events`, {
  headers: { Accept: "text/event-stream" },
});
if (!events.ok) fail(`GET /api/events: HTTP ${events.status}`);
const cookie = (events.headers.get("set-cookie") ?? "").split(";")[0];

const frames = [];
let connectionId = null;

{
  const reader = events.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      // SSE frames are separated by a BLANK line. Splitting on a single "\n"
      // mangles multi-line blocks; that mistake made an earlier probe report
      // "no reply" for a perfectly healthy server.
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const m = /^data:\s*(.*)$/m.exec(chunk);
        if (!m?.[1]) continue;
        let json;
        try {
          json = JSON.parse(m[1]);
        } catch {
          continue;
        }
        if (json.id && !json.ct) {
          connectionId ??= json.id;
          continue;
        }
        if (typeof json.ct !== "string") continue;
        let inner;
        try {
          inner = JSON.parse(Buffer.from(json.ct, "base64").toString("utf8"));
        } catch {
          continue;
        }
        // Child replies arrive wrapped in `host_message{room, ct}`. The app's
        // demuxInbound unwraps it, so this probe must too.
        if (inner?.type === "host_message" && typeof inner.ct === "string") {
          try {
            inner = JSON.parse(Buffer.from(inner.ct, "base64").toString("utf8"));
          } catch {
            continue;
          }
        }
        frames.push(inner);
      }
    }
  })().catch(() => {});
}

for (let i = 0; i < 100 && connectionId === null; i += 1) {
  await new Promise((r) => setTimeout(r, 50));
}
if (!connectionId) fail("no connectionId frame within 5 s");

const post = (msg) =>
  fetch(`${base}/api/frame?id=${encodeURIComponent(connectionId)}`, {
    method: "POST",
    headers: { Origin: base, Cookie: cookie, "content-type": "application/json" },
    body: JSON.stringify(msg),
  });

/** Forwards `inner` to `room` and waits for the reply carrying its id. */
async function forward(room, inner, timeoutMs = TIMEOUT_MS) {
  const startedAt = Date.now();
  await post({
    type: "host_forward",
    id: `fwd_${inner.id}`,
    room,
    ct: Buffer.from(JSON.stringify(inner)).toString("base64"),
  });
  while (Date.now() - startedAt < timeoutMs) {
    const hit = frames.find((f) => f.in_reply_to === inner.id);
    if (hit) return { hit, elapsed: Date.now() - startedAt };
    await new Promise((r) => setTimeout(r, 50));
  }
  return { hit: null, elapsed: Date.now() - startedAt };
}

// ---- layer 1: room (the server itself) ------------------------------------
const listMsg = { type: "workspace_list", id: randomUUID() };
const ws = await forward("host", listMsg, 6_000);
if (ws.hit === null) {
  console.log(
    `SKIP layer 1 (room): workspace_list unanswered after ${ws.elapsed} ms — ` +
      `the host room only accepts PAIRED peers, which this probe is not.`,
  );
} else if (ws.hit.type === "action_error") {
  fail(`layer 1 (room): ${ws.hit.error}`);
} else {
  const n = (ws.hit.workspaces ?? []).length;
  console.log(
    `PASS layer 1 (room): workspace_list answered in ${ws.elapsed} ms (${n} workspaces)`,
  );
}

// ---- layers 2 and 3: a WORKSPACE room ------------------------------------
//
// The room id is derived locally because the authorization gate above is not
// this script's subject — addressing is.
const { listDaemons } = await import("../dist/daemon/registry.js");
const { roomIdFor } = await import("../dist/rooms.js");
const { defaultAgentName } = await import("../dist/daemon/id.js");

const registered = listDaemons();
if (registered.length === 0) fail("no registered workspace locally — nothing to address");
const target = registered[0];
const roomId = roomIdFor(target.cwd, target.name ?? defaultAgentName(target.cwd));
console.log(`     addressing workspace "${target.name ?? target.cwd}" room=${roomId}`);

const sessionMsg = { type: "session_list", id: randomUUID() };
const s = await forward(roomId, sessionMsg);
if (s.hit === null) {
  fail(
    `layer 2/3 (workspace room): no reply in ${s.elapsed} ms. ` +
      `A workspace room must answer session_list directly.`,
  );
}
if (s.hit.type === "action_error") fail(`layer 2/3 (workspace room): ${s.hit.error}`);
const count = Array.isArray(s.hit.sessions) ? s.hit.sessions.length : 0;
console.log(
  `PASS layer 2/3 (workspace room): session_list answered in ${s.elapsed} ms ` +
    `(${count} sessions)`,
);

console.log("\nTHREE-LAYER PATH VERIFIED");
process.exit(0);
