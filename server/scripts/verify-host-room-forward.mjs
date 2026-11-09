#!/usr/bin/env node
/**
 * The phone cannot tell "wrong room" from "server is dead".
 *
 * `pair_ok` reports `room_id: "host"` (the room the CONTROL plane answers on),
 * an older app build persisted that as the peer's workspace room, and every
 * child-addressed request then went to `host` — where nothing can answer
 * `session_list`. The user saw every session time out after 12 s.
 *
 * This asserts the fix from the outside: a `host_forward` addressed to the host
 * room must produce a REPLY (either routed to the single live workspace, or a
 * typed `action_error` when routing is ambiguous). Silence is the failure.
 *
 * Usage: node scripts/verify-host-room-forward.mjs [baseUrl]
 *   baseUrl defaults to http://127.0.0.1:3001
 */
import { randomUUID } from "node:crypto";

const base = process.argv[2] ?? "http://127.0.0.1:3001";
const TIMEOUT_MS = 6000;

function fail(msg) {
  console.error(`FAIL ${msg}`);
  process.exit(1);
}

const boot = await fetch(`${base}/remote-pi/connect`);
if (!boot.ok) fail(`bootstrap page: HTTP ${boot.status}`);
const cookie = (boot.headers.getSetCookie?.() ?? [])
  .map((l) => l.split(";")[0])
  .find((c) => c.startsWith("pi_bootstrap="));
if (!cookie) fail("bootstrap did not set a session cookie");

const ready = await fetch(`${base}/api/bootstrap`, {
  method: "POST",
  headers: { Origin: base, Cookie: cookie, "content-type": "application/json" },
  body: "{}",
});
if (!ready.ok) fail(`POST /api/bootstrap: HTTP ${ready.status}`);

const events = await fetch(`${base}/api/events`, {
  headers: { Origin: base, Cookie: cookie, Accept: "text/event-stream" },
});
if (!events.ok) fail(`GET /api/events: HTTP ${events.status}`);

const frames = [];
let connectionId = null;
const decoder = new TextDecoder();
let buffer = "";

(async () => {
  const reader = events.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
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
      // The first frame carries the connection id, not ciphertext.
      if (json.id && !json.ct) {
        connectionId ??= json.id;
        continue;
      }
      if (typeof json.ct !== "string") continue;
      let inner;
      try {
        inner = JSON.parse(Buffer.from(json.ct, "base64").toString("utf8"));
      } catch {
        continue; // not ours
      }
      // Child replies arrive wrapped in `host_message{room, ct}` — the app's
      // demuxInbound unwraps it, so the probe must too. Without this the probe
      // reports "no reply" for a perfectly healthy forward.
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
})();

for (let i = 0; i < 50 && connectionId === null; i += 1) {
  await new Promise((r) => setTimeout(r, 100));
}
if (!connectionId) fail("no connectionId frame within 5 s");

const post = (msg) =>
  fetch(`${base}/api/frame?id=${encodeURIComponent(connectionId)}`, {
    method: "POST",
    headers: { Origin: base, Cookie: cookie, "content-type": "application/json" },
    body: JSON.stringify(msg),
  });

const requestId = randomUUID();
const ct = Buffer.from(JSON.stringify({ type: "session_list", id: requestId })).toString("base64");

const startedAt = Date.now();
await post({ type: "host_forward", id: `fwd_${requestId}`, room: "host", ct });

let seen = null;
while (Date.now() - startedAt < TIMEOUT_MS) {
  seen = frames.find(
    (f) =>
      (f.type === "session_list_ok" || f.type === "action_error") &&
      f.in_reply_to === requestId,
  );
  if (seen) break;
  await new Promise((r) => setTimeout(r, 50));
}

const elapsed = Date.now() - startedAt;
if (!seen) {
  fail(
    `host_forward{room:"host"} got NO reply in ${elapsed} ms. ` +
      `This is the "every session times out" bug: the forward was dropped silently.`,
  );
}
if (seen.type === "action_error") {
  // Legitimate outcome (zero or several live workspaces) — but it must SAY so.
  console.log(
    `PASS host_forward{room:"host"} answered action_error after ${elapsed} ms ` +
      `(error=${seen.error}, action=${seen.action}) — no silent drop`,
  );
  process.exit(0);
}

const count = Array.isArray(seen.sessions) ? seen.sessions.length : 0;
console.log(
  `PASS host_forward{room:"host"} routed to the live workspace and answered ` +
    `session_list_ok after ${elapsed} ms (${count} sessions)`,
);
process.exit(0);
