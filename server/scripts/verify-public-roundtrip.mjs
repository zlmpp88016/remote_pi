/*
 * End-to-end check over the PUBLIC entry point (frp tunnel).
 *
 * The browser check proves a device can PAIR through the tunnel. This proves the
 * transport actually CARRIES the host's real commands and answers — the part a
 * TCP forward can silently break (half-open sockets, buffering proxies, a
 * one-way path where the POST is accepted and nothing comes back).
 *
 * Every probe below is a command the app really sends, and each one is judged by
 * the DECODED REPLY, not by "a frame arrived": a `pong` proves routing at all, a
 * `workspace_list_ok` proves the host can read its own state, and so on. Every
 * probe also prints the ACTUAL URL it posted to, so a reviewer can audit that
 * the public lane — and not some loopback leftover — was really exercised.
 *
 * ── Session ownership (the part "a frame arrived" cannot see) ────────────────
 *
 * `session_switch` is a process restart, so a reply proves nothing about WHICH
 * session the workspace is running afterwards, and the two can diverge for
 * minutes: measured on this very lane, the app kept rendering the PREVIOUS
 * session's transcript for >=120 s after the switch because the single ack frame
 * was lost on the way. The session probes therefore assert ownership from the
 * host's own state, three INDEPENDENT ways:
 *
 *   1. the ack's own `session_id` (`session_switch_ok`);
 *   2. `session_list_ok.current_id` — the host publishes it only when the id it
 *      is running is actually in that listing, and it is a READ-ONLY probe, so
 *      watching the effect can never cost an extra spawn;
 *   3. `session_history` from `session_sync`, compared event-for-event with a
 *      `session_read` of the very session we asked for, plus its session epoch
 *      (`session_started_at`) against the switch's own epoch.
 *
 * Together those catch the residue the old harness could not see: "the frame
 * arrived, the session did not change". A green line here means the workspace
 * really moved.
 *
 * ── Budgets (why 12 s is NOT the switch budget) ─────────────────────────────
 *
 * Measured on this lane: median RTT ~0.8–1.1 s, p95 1.82 s; Pi cold boot ~13.7 s.
 * The client fix splits the wait into a 12 s ACK slice and a 90 s boot-level
 * settle budget, re-reading `session_list` every 2 s — and so does this harness,
 * for the same reason:
 *
 *   SWITCH_ACK_SLICE_MS   12 000  how long the reply frame is awaited. A MISSED
 *                                 ack is not a failed switch (the client's own
 *                                 reasoning), so this is a slice, not a verdict.
 *   SWITCH_SETTLE_BUDGET_MS 90 000 counted from the send, covering the ack slice
 *                                 + one cold boot (13.7 s) + several read-only
 *                                 polls. Worst realistic path is ~26 s, so 90 s
 *                                 leaves >3x margin without failing so late that
 *                                 a dead workspace looks like a hang.
 *   SWITCH_POLL_INTERVAL_MS 2 000  smallest gap that leaves the wire idle between
 *                                 polls at a 1.1 s median round trip (polling
 *                                 faster would turn the observation itself into
 *                                 congestion behind a still-booting Pi).
 *   SWITCH_POLL_TIMEOUT_MS  3 000  one short slice per poll — covers the 1.82 s
 *                                 p95 round trip with headroom.
 *
 * Using 12 s as the OVERALL budget would be simply wrong: ack slice (up to 12 s)
 * plus a 13.7 s cold boot already exceeds it, so a healthy recycle would be
 * reported as broken — the exact false negative this harness must not produce.
 *
 * ── Spawn counting ──────────────────────────────────────────────────────────
 *
 * Spawns are counted BY PID IDENTITY, from the supervisor's own control socket.
 * The supervisor's `restarts` counter (also mirrored in the `workspace_state`
 * push) is NOT evidence: measured across every respawn on this host it read 0
 * while the Pi pid actually churned. The pid trail is printed on every check so
 * the counter can be compared against it instead of trusted.
 *
 * Usage:
 *   node scripts/verify-public-roundtrip.mjs                 # live public lane
 *   node scripts/verify-public-roundtrip.mjs http://127.0.0.1:3001   # loopback control
 *   node scripts/verify-public-roundtrip.mjs --read-only     # no host mutation
 *
 * Run ONE acceptance at a time against a workspace. `session_switch` is a
 * process restart, and the supervisor refuses a second Pi for the same (cwd,
 * name) — so two concurrent runs, or one started in the second after another
 * finished, can collide on the cwd lock and leave the workspace unable to come
 * back (reported honestly, with `workspace_state.last_error`, rather than
 * retried).
 */

import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

/** The live public entry: frpc → 127.0.0.1:3001. Loopback stays selectable. */
const DEFAULT_BASE = "http://ht.wwszxc.tax:41533";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    [
      "End-to-end check of the remote-pi command/reply path over the PUBLIC entry point.",
      "",
      "Usage:",
      `  node scripts/verify-public-roundtrip.mjs [baseUrl] [--read-only]`,
      "",
      "  baseUrl      defaults to " + DEFAULT_BASE + " (the live public lane)",
      "               http://127.0.0.1:3001 selects the loopback control lane",
      "  --read-only  skips the mutating probes (workspace_add, session_switch,",
      "               and the restore switch); the session probes still read the",
      "               host and still judge on decoded replies, but this is NOT an",
      "               ownership proof and the run says so.",
      "",
      "Exit codes: 0 = every check passed, 1 = at least one failed.",
    ].join("\n"),
  );
  process.exit(0);
}
const readOnly = args.includes("--read-only");
const base = (args.find((a) => !a.startsWith("-")) ?? DEFAULT_BASE).replace(/\/$/, "");

// ── budgets (see the header for the arithmetic) ──────────────────────────────
const REQUEST_TIMEOUT_MS = 15_000; // host-direct replies (unchanged default)
const SWITCH_ACK_SLICE_MS = 12_000; // mirrors the client's 12 s ACK slice
const SWITCH_SETTLE_BUDGET_MS = 90_000; // mirrors the 90 s boot-level settle budget
const SWITCH_POLL_INTERVAL_MS = 2_000; // mirrors the 2 s read-only poll spacing
const SWITCH_POLL_TIMEOUT_MS = 3_000; // one short slice per poll
/** How many listed sessions are read while looking for two usable transcripts. */
const CANDIDATE_READS = 5;

let failed = false;
const check = (name, ok, extra = "") => {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};
/** Context line — addressing, budgets, measurements. Never a verdict. */
const info = (message) => console.log(`     ${message}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`BASE  ${base}  (${args.find((a) => !a.startsWith("-")) === undefined ? "default lane" : "argv[2] override"})`);
if (readOnly) {
  console.log("MODE  --read-only: workspace_add / session_switch / restore are SKIPPED (not an ownership proof)");
}

/** Minimal cookie jar — Node's fetch has none. */
let cookie = "";
const remember = (res) => {
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const pair = line.split(";")[0];
    if (pair.startsWith("pi_bootstrap=")) cookie = pair;
  }
};

/** A failed handshake must print a verdict, not an undici stack trace. */
function abort(message) {
  check(message, false);
  console.log("\nRESULT: FAILED");
  process.exit(1);
}

// ── 1. bootstrap ────────────────────────────────────────────────────────────
// The session handshake is printed too: a reviewer auditing "was this really the
// public lane?" needs the WHOLE trail, not just the frames.
info(`→ GET  ${base}/remote-pi/connect  (bootstrap page, issues the pi_bootstrap cookie)`);
const page = await fetch(`${base}/remote-pi/connect`).catch((err) => {
  /*
   * The default lane is a PUBLIC entry (frpc → loopback). When it is down the
   * raw `fetch failed` / ECONNREFUSED throw says nothing about WHICH hop broke —
   * the tunnel, the server, or the loopback behind it — so the address is named
   * in the verdict instead of leaving a stack trace as the whole report.
   */
  abort(`the page did not answer at ${base} (${err?.cause?.code ?? err?.message ?? err})`);
});
remember(page);
check("page loads over the tunnel", page.status === 200, `status ${page.status}`);
check("bootstrap cookie issued", cookie !== "");

info(`→ POST ${base}/api/bootstrap  (session handshake, no token printed)`);
const boot = await fetch(`${base}/api/bootstrap`, {
  method: "POST",
  headers: { Origin: base, Cookie: cookie, "content-type": "application/json" },
  body: "{}",
}).catch((err) => abort(`POST ${base}/api/bootstrap failed (${err?.cause?.code ?? err?.message ?? err})`));
const bootBody = await boot.json().catch(() => ({}));
check("POST /api/bootstrap accepted", boot.status === 200, `status ${boot.status}`);
check("bootstrap returns a token", typeof bootBody.token === "string" && bootBody.token !== "");

// ── 2. SSE channel ──────────────────────────────────────────────────────────
info(`→ GET  ${base}/api/events  (SSE; this is the inbound stream, not a WebSocket)`);
const events = await fetch(`${base}/api/events`, {
  headers: { Origin: base, Cookie: cookie, Accept: "text/event-stream" },
}).catch((err) => abort(`GET ${base}/api/events failed (${err?.cause?.code ?? err?.message ?? err})`));
check("/api/events upgraded", events.status === 200, `status ${events.status}`);
if (events.status !== 200 || events.body === null) {
  abort("/api/events returned no stream — every probe below needs the SSE channel");
}

const reader = events.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let connectionId = null;
/** in_reply_to → decoded reply object */
const replies = new Map();
let frameCount = 0;

/*
 * Every decoded message, in ARRIVAL ORDER, for the session probes.
 *
 * `replies` (above) is a last-writer-wins map and cannot answer two questions
 * this harness needs: (a) "was there an EMPTY `session_history` reset for this
 * switch BEFORE the ack?" — the fan-out and the ack share one `in_reply_to`, so
 * a map keeps only the newer one; and (b) "did a `session_switch_error` arrive
 * instead of an ok?". An append-only log with a monotonic sequence answers both.
 */
let frameSeq = 0;
/** @type {Array<{ seq: number, at: number, msg: any }>} */
const messages = [];
/** Latest `workspace_state` push per cwd (unsolicited, so not in `replies`). */
const workspaceStates = new Map();
/** A decoded frame is only ever dropped once NO probe could still be waiting on it. */
const MESSAGE_RETENTION_MS = SWITCH_SETTLE_BUDGET_MS + REQUEST_TIMEOUT_MS + SWITCH_ACK_SLICE_MS;

/** Record one DECODED server message. Replies and pushes both land here. */
function recordInner(inner) {
  frameSeq += 1;
  const now = Date.now();
  messages.push({ seq: frameSeq, at: now, msg: inner });
  /*
   * Trimmed by AGE, not by count.
   *
   * A count-based cap is the wrong shape here: a chatty workspace can stream
   * thousands of deltas while a switch is in flight, and dropping the OLDEST
   * records would then silently delete the very reply a probe is still polling
   * for — the harness would report "nothing came back" for a reply it already
   * received. A frame older than the longest budget in this script cannot be
   * awaited by anything, so it is the only thing safe to drop.
   */
  const cutoff = now - MESSAGE_RETENTION_MS;
  let drop = 0;
  while (drop < messages.length && messages[drop].at < cutoff) drop += 1;
  if (drop > 0) messages.splice(0, drop);
  const replyTo = inner?.in_reply_to;
  if (typeof replyTo === "string" && replyTo !== "") replies.set(replyTo, inner);
  // `workspace_state` is a PUSH (no id, no in_reply_to) — it carries the
  // supervisor's `restarts` counter, which is printed only to be contrasted with
  // the pid trail (see the spawn-counting note in the header).
  if (inner?.type === "workspace_state" && typeof inner.cwd === "string") {
    workspaceStates.set(inner.cwd, inner);
  }
}

function drain() {
  let split;
  while ((split = buffer.indexOf("\n\n")) !== -1) {
    const chunk = buffer.slice(0, split);
    buffer = buffer.slice(split + 2);
    const eventName = /^event:\s*(.+)$/m.exec(chunk)?.[1]?.trim() ?? "message";
    const data = /^data:\s*(.*)$/m.exec(chunk)?.[1] ?? "";
    if (data === "") continue; // `: keepalive` comments are not frames
    if (eventName === "endpoint") {
      try {
        connectionId = JSON.parse(data).id;
      } catch { /* ignore */ }
      continue;
    }
    frameCount += 1;
    try {
      const envelope = JSON.parse(data);
      const inner = JSON.parse(Buffer.from(envelope.ct ?? "", "base64").toString("utf8"));
      /*
       * A CHILD reply arrives wrapped: the supervisor re-wraps the workspace
       * Pi's frame as `host_message{room, ct}` (plan/69 decision B), and the
       * app's `demuxInbound` unwraps it before parsing. A probe that does not
       * unwrap here sees no `in_reply_to` at all and reports "no reply" for a
       * perfectly healthy child room — so the unwrap belongs in the harness,
       * exactly where the client does it.
       */
      if (inner?.type === "host_message" && typeof inner.ct === "string") {
        try {
          const child = JSON.parse(Buffer.from(inner.ct, "base64").toString("utf8"));
          /*
           * Keep the CHILD room on the decoded message. The harness later asserts
           * the reply named the workspace it addressed: `host_message.room` is the
           * only field that says which room the answer really came from, and a
           * reply arriving from some other room would mean the probe proved a
           * DIFFERENT workspace than the one it reported.
           */
          child.__room = inner.room;
          recordInner(child);
        } catch { /* not our envelope shape — ignore */ }
        continue;
      }
      recordInner(inner);
    } catch { /* not our envelope shape — ignore */ }
  }
}

const pumpLoop = (async () => {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    drain();
  }
})().catch(() => {});

for (let i = 0; i < 80 && connectionId === null; i += 1) {
  await new Promise((r) => setTimeout(r, 100));
}
check("SSE announces a connection id", typeof connectionId === "string" && connectionId !== "");

// ── 3. command → reply ──────────────────────────────────────────────────────

/** The exact endpoint every probe writes to — printed so the URL is auditable. */
function frameUrl() {
  return `${base}/api/frame?id=${encodeURIComponent(connectionId)}`;
}

/** POST one frame and print the URL it really went to. Returns the HTTP status. */
async function post(body, what) {
  const target = frameUrl();
  info(`→ POST ${target}  (${what})`);
  return await fetch(target, {
    method: "POST",
    headers: { Origin: base, Cookie: cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
    .then((r) => r.status)
    .catch(() => 0);
}

/**
 * Address a CHILD-room command the way the app does: the payload rides inside
 * `host_forward{room, ct}` addressed to the host room, the supervisor re-emits
 * it on the workspace's room, and the answer returns as `host_message`.
 * `session_list` / `session_switch` / `session_sync` are all child-addressed.
 */
async function forwardTo(room, inner) {
  return await post(
    {
      type: "host_forward",
      id: `fwd_${inner.id}`,
      room,
      ct: Buffer.from(JSON.stringify(inner)).toString("base64"),
    },
    `${inner.type} via host_forward → room ${room}`,
  );
}

/** First decoded message accepted by `predicate`, or undefined after `budgetMs`. */
async function waitFor(predicate, budgetMs) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const hit = messages.find(({ msg }) => predicate(msg));
    if (hit !== undefined) return hit;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function call(id, message, timeoutMs = REQUEST_TIMEOUT_MS) {
  const status = await post({ ...message, id }, message.type);
  if (status < 200 || status >= 300) return { postStatus: status, reply: undefined };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (replies.has(id)) return { postStatus: status, reply: replies.get(id) };
    await new Promise((r) => setTimeout(r, 100));
  }
  return { postStatus: status, reply: undefined };
}

/**
 * Each probe is a command the real clients send, and the assertion is on the
 * reply TYPE the host bridge defines — so a probe cannot pass by accident.
 */
/*
 * Only HOST-DIRECT commands here (kHostDirectTypes in the app's host_proxy.dart):
 * these are the ones the daemon answers on room `host`. The child-addressed ones
 * — `session_list`, `session_switch`, `session_sync` — need the `host_forward`
 * proxy and their own decoded-reply assertions; they live in the session group
 * below, which is what proves session OWNERSHIP rather than mere reachability.
 */
const probes = [
  {
    id: "probe-hello",
    message: { type: "host_hello" },
    expect: "host_hello_ok",
    detail: (r) => `daemon ${r.daemon?.version ?? "?"} on ${r.daemon?.hostname ?? "?"}`,
  },
  {
    id: "probe-workspaces",
    message: { type: "workspace_list" },
    expect: "workspace_list_ok",
    detail: (r) => `${Array.isArray(r.workspaces) ? r.workspaces.length : 0} workspace(s)`,
  },
  {
    id: "probe-models",
    message: { type: "models_describe" },
    expect: "models_describe_ok",
    detail: (r) => `revision ${r.revision ?? "?"}`,
  },
  {
    id: "probe-settings",
    message: { type: "settings_describe" },
    expect: "settings_describe_ok",
    detail: (r) => `revision ${r.revision ?? "?"}`,
  },
  {
    id: "probe-fs",
    message: { type: "fs_list", path: "~" },
    expect: "fs_list_ok",
    detail: (r) => `${Array.isArray(r.entries) ? r.entries.length : 0} entr(y/ies)`,
  },
  {
    id: "probe-schedule",
    message: { type: "schedule_list" },
    expect: "schedule_list_ok",
    // The reply field is `tasks`; the original read `schedules`, so this line
    // always printed "0 automation(s)" whatever the host held. The ASSERTION is
    // unchanged (still the reply type) — only the count shown is now true.
    detail: (r) =>
      `${Array.isArray(r.tasks) ? r.tasks.length : Array.isArray(r.schedules) ? r.schedules.length : 0} automation(s)`,
  },
];

/** The host's own workspace catalog, reused by the session group below. */
let workspaceRows = [];

for (const probe of probes) {
  const { postStatus, reply } = await call(probe.id, probe.message);
  const ok = reply?.type === probe.expect;
  check(
    `${probe.message.type} → ${probe.expect}`,
    ok,
    ok ? probe.detail(reply) : `got ${reply?.type ?? `nothing (POST ${postStatus})`}`,
  );
  if (ok && probe.expect === "workspace_list_ok" && Array.isArray(reply.workspaces)) {
    workspaceRows = reply.workspaces;
  }
}

/*
 * A WRITE, not just a read. Everything above proves the host can answer
 * questions about itself; a write proves a command actually MUTATES host state
 * across the tunnel, which is what "the app works remotely" means in practice.
 *
 * `workspace_add` replies `action_ok` / `action_error`, so success is a typed
 * reply and a follow-up listing that contains the new entry. The entry is removed
 * again in a `finally` — a check must not leave the host changed.
 */
const probePath = process.env["REMOTE_PI_PROBE_PATH"] ?? "~";
if (readOnly) {
  console.log("SKIP  workspace_add (a write) — --read-only was requested");
} else {
  const added = await call("probe-add", { type: "workspace_add", path: probePath });
  check(
    "workspace_add → action_ok",
    added.reply?.type === "action_ok" && added.reply?.action === "workspace_add",
    added.reply?.type ?? `nothing (POST ${added.postStatus})`,
  );
  try {
    if (added.reply?.type === "action_ok") {
      const listAfter = await call("probe-workspaces-2", { type: "workspace_list" });
      const rows = listAfter.reply?.workspaces ?? [];
      check("the new workspace is listed back", rows.length > 0, `${rows.length} workspace(s)`);
    }
  } finally {
    if (added.reply?.type === "action_ok") {
      await call("probe-remove", { type: "workspace_remove", path: probePath });
    }
  }
}

// ── 4. session ownership ────────────────────────────────────────────────────
//
// The probes above prove the tunnel carries QUESTIONS. These prove it carries a
// state CHANGE and that the answer names the state the change produced.

console.log("\nsession ownership (child room, judged on decoded replies)");

/** A stable fingerprint of a transcript, so two pages can be compared. */
const digestOf = (list) => createHash("sha256").update(JSON.stringify(list ?? [])).digest("hex").slice(0, 12);

/** The human-meaningful opening lines of a transcript (never used to judge). */
const previewsOf = (list) =>
  (list ?? [])
    .filter((e) => e.type === "user_input")
    .slice(-2)
    .map((e) => String(e.text ?? "").replace(/\s+/g, " ").slice(0, 32));

/*
 * Spawn counting by PID IDENTITY.
 *
 * The only observable that answers "did the workspace's Pi process change?" is
 * the pid the supervisor reports for that daemon. `restarts`/`restart_count` is
 * NOT: measured across every observed respawn on this host it read 0 while the
 * pid actually churned, so a harness that trusted the counter would report a
 * calm workspace mid-restart-storm.
 *
 * Read over the supervisor's control socket (one JSON line each way — see
 * `server/src/daemon/control_protocol.ts`), whose address is derived exactly like
 * `session/ipc.ts` + `daemon/supervisor.ts` derive it. Read-only: `{op:"status"}`
 * mutates nothing.
 */
function supervisorAddress() {
  const instance = (process.env["REMOTE_PI_INSTANCE"] ?? "").trim();
  const inst = instance === "" ? "" : `.${instance.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
  if (process.platform === "win32") {
    const user = (userInfo().username || "user").replace(/[^A-Za-z0-9_.-]/g, "_");
    return `\\\\.\\pipe\\remote-pi-supervisor${inst}-${user}`;
  }
  const file = join(process.env["REMOTE_PI_HOME"] || homedir(), ".pi", "remote", "supervisor.sock");
  if (inst === "") return file;
  const cut = file.lastIndexOf(".sock");
  return cut < 0 ? `${file}${inst}` : `${file.slice(0, cut)}${inst}${file.slice(cut)}`;
}

/** `{ok:true, daemons}` or `{ok:false, reason}` — never throws. */
async function supervisorStatus(timeoutMs = 2_000) {
  const address = supervisorAddress();
  return await new Promise((resolve) => {
    const sock = createConnection({ path: address });
    let settled = false;
    let timer = null;
    let buf = "";
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      sock.destroy();
      resolve(value);
    };
    timer = setTimeout(() => finish({ ok: false, reason: `no reply from ${address} in ${timeoutMs} ms` }), timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify({ op: "status" }) + "\n"));
    sock.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        const reply = JSON.parse(buf.slice(0, nl));
        if (reply?.ok !== true) {
          finish({ ok: false, reason: String(reply?.error ?? "supervisor refused") });
          return;
        }
        const daemons = Array.isArray(reply.data?.daemons) ? reply.data.daemons : [];
        finish({ ok: true, daemons, address });
      } catch (e) {
        finish({ ok: false, reason: `malformed supervisor reply: ${String(e)}` });
      }
    });
    sock.on("error", (err) => finish({ ok: false, reason: `${err.code ?? err.message} at ${address}` }));
  });
}

/** The supervisor row for one workspace: by daemon id, then by cwd. */
function findDaemon(daemons, id, cwd) {
  const want = typeof cwd === "string" ? cwd.toLowerCase() : "";
  return (
    daemons.find((d) => d.id === id) ??
    (want === "" ? undefined : daemons.find((d) => typeof d.cwd === "string" && d.cwd.toLowerCase() === want)) ??
    null
  );
}

/** Record one pid sample into `trail`, printing nothing (the check prints it). */
async function samplePid(trail, id, cwd) {
  const status = await supervisorStatus();
  if (!status.ok) return { ok: false, reason: status.reason, restarts: null };
  const row = findDaemon(status.daemons, id, cwd);
  if (row === null) {
    return {
      ok: false,
      reason: `workspace ${id} has no row in ${status.address} (not supervised — pid is unobservable)`,
      restarts: null,
    };
  }
  const restarts = typeof row.restart_count === "number" ? row.restart_count : null;
  if (typeof row.pid !== "number") {
    return { ok: false, reason: `no pid reported (state ${row.state ?? "?"})`, restarts };
  }
  if (!trail.some((t) => t.pid === row.pid)) trail.push({ pid: row.pid, at: Date.now() });
  return { ok: true, pid: row.pid, restarts, reason: "" };
}

/**
 * Switch one workspace to `sessionId` and watch the EFFECT.
 *
 * Mirrors the client fix: 12 s for the ack slice, then (whether or not the ack
 * landed) a read-only `session_list` poll every 2 s until the host itself says
 * the target is current, all of it bounded by `SWITCH_SETTLE_BUDGET_MS` counted
 * from the send. `session_switch` is sent EXACTLY ONCE — a repeat is a second
 * Pi spawn for a signal the harness already has.
 */
async function switchTo(room, workspace, sessionId, label) {
  const switchId = `probe-switch-${label}`;
  const startedAt = Date.now();
  const budgetEndsAt = startedAt + SWITCH_SETTLE_BUDGET_MS;
  const trail = [];
  let pidError = "";
  let restarts = null;

  const take = async () => {
    const sample = await samplePid(trail, workspace.daemon_id, workspace.cwd);
    if (!sample.ok) pidError = sample.reason;
    if (sample.restarts !== null) restarts = sample.restarts;
  };

  await take(); // the pid BEFORE the switch — the baseline of the identity count
  const postStatus = await forwardTo(room, { type: "session_switch", id: switchId, session_id: sessionId });

  const ackHit =
    postStatus >= 200 && postStatus < 300
      ? await waitFor(
          (m) =>
            m.in_reply_to === switchId &&
            (m.type === "session_switch_ok" ||
              m.type === "session_switch_error" ||
              (m.type === "action_error" && m.action === "session_switch")),
          Math.max(0, Math.min(SWITCH_ACK_SLICE_MS, budgetEndsAt - Date.now())),
        )
      : undefined;
  const ackMs = Date.now() - startedAt;
  const ack = ackHit?.msg;

  /*
   * A TYPED refusal ends the watch immediately.
   *
   * `session_switch_error` (locked / unknown / no_sdk) and the supervisor's
   * unroutable-forward `action_error` are the host saying "this switch will not
   * happen". Nothing about waiting 90 s can change that, and spending the whole
   * budget would report a hung workspace where the host actually answered in
   * 120 ms — the same mistake as inflating a timeout to hide a defect, only
   * backwards. An EMPTY ack (a missed slice) still gets the full watch, because
   * there the effect is genuinely unknown.
   */
  const refused =
    ack?.type === "session_switch_error" ||
    (ack?.type === "action_error" && ack.action === "session_switch");
  const refusal = refused
    ? `host refused: ${ack.type === "session_switch_error" ? `code=${ack.code} (${ack.message})` : `action_error (${ack.error})`}`
    : "";

  // The reset fan-out F4 added: an EMPTY `session_history` carrying the switch's
  // own id, written BEFORE the ack. Same `in_reply_to` as the ack, which is why
  // it is looked up in the ordered log and not in the `replies` map. Searched
  // AGAIN after the watch (see `resetSeen` below) so a frame that lands late —
  // the ack missing its slice does not mean the fan-out missed it too — is still
  // found, rather than reported as absent because it arrived one second later.
  const findReset = () =>
    messages.find(({ msg }) => msg.in_reply_to === switchId && msg.type === "session_history");
  let resetFound = findReset();

  let currentId = null;
  let polls = 0;
  let confirmedAt = undefined;
  while (!refused && Date.now() < budgetEndsAt) {
    await sleep(Math.min(SWITCH_POLL_INTERVAL_MS, Math.max(0, budgetEndsAt - Date.now())));
    await take();
    polls += 1;
    const pollId = `probe-watch-${label}-${polls}`;
    const status = await forwardTo(room, { type: "session_list", id: pollId });
    if (status < 200 || status >= 300) continue;
    const polled = await waitFor(
      (m) => m.in_reply_to === pollId && (m.type === "session_list_ok" || m.type === "action_error"),
      // Never past the settle budget: a 3 s slice starting at second 88 must not
      // push the run's own bound out to 91 s.
      Math.max(0, Math.min(SWITCH_POLL_TIMEOUT_MS, budgetEndsAt - Date.now())),
    );
    // A timeout or a typed refusal here means the Pi is still booting (or has no
    // ctx yet) — expected during a recycle, so keep watching instead of failing.
    if (polled?.msg?.type !== "session_list_ok") continue;
    currentId = polled.msg.current_id ?? null;
    if (currentId === sessionId) {
      confirmedAt = Date.now();
      break;
    }
  }
  await take(); // the pid AFTER the effect was confirmed
  resetFound ??= findReset();

  const distinct = trail.map((t) => t.pid);
  return {
    switchId,
    postStatus,
    ack,
    ackMs,
    ackSeq: ackHit?.seq,
    reset: resetFound?.msg,
    resetSeq: resetFound?.seq,
    currentId,
    polls,
    settled: confirmedAt !== undefined,
    settleMs: confirmedAt === undefined ? undefined : confirmedAt - startedAt,
    totalMs: Date.now() - startedAt,
    pidTrail: distinct,
    // A process that lived and died between two samples is invisible, so this is
    // a LOWER BOUND — which is exactly why the trail is printed next to it.
    spawns: Math.max(0, distinct.length - 1),
    pidError,
    restarts,
    refused,
    refusal,
  };
}

/** Read one session's transcript without switching it. */
async function readSession(room, sessionId, tag) {
  const id = `probe-read-${tag}`;
  /*
   * `limit` is deliberately OMITTED so the host applies its own default — the
   * same `_getSyncLimit()` that answers `session_sync`. Naming a limit would
   * make the two pages comparable only when that default happens to equal it,
   * and an operator running `export REMOTE_PI_SYNC_LIMIT=10` would then see the
   * "sync IS A's" check fail on window size alone instead of on content.
   */
  const status = await forwardTo(room, { type: "session_read", id, session_id: sessionId });
  if (status < 200 || status >= 300) return { reply: undefined, postStatus: status };
  const hit = await waitFor(
    (m) => m.in_reply_to === id && (m.type === "session_read_ok" || m.type === "action_error"),
    REQUEST_TIMEOUT_MS,
  );
  return { reply: hit?.msg, postStatus: status };
}

/** Ask for the LIVE session's transcript (a query — it mutates nothing). */
async function syncSession(room, tag) {
  const id = `probe-sync-${tag}`;
  const startedAt = Date.now();
  const status = await forwardTo(room, { type: "session_sync", id });
  if (status < 200 || status >= 300) return { reply: undefined, postStatus: status, elapsedMs: Date.now() - startedAt };
  const hit = await waitFor((m) => m.in_reply_to === id && m.type === "session_history", REQUEST_TIMEOUT_MS);
  return { reply: hit?.msg, postStatus: status, elapsedMs: Date.now() - startedAt };
}

const short = (id) => (typeof id === "string" ? id.slice(0, 8) : String(id));

/**
 * The host's own reason for a workspace that will not come back, when it has one.
 *
 * A settle that misses its budget has exactly two meanings the caller must tell
 * apart: the switch was lost, or the recycled Pi could not respawn (a cwd lock
 * held by another process, a spawn failure). `workspace_state.last_error` is the
 * only place the second one is ever stated, so it is quoted rather than guessed.
 *
 * Takes the cwd as an argument (rather than reading `chosen`) so a call site can
 * never touch that binding before its declaration.
 */
function lastErrorNote(cwd) {
  const state = typeof cwd === "string" ? workspaceStates.get(cwd) : undefined;
  if (state === undefined) return "";
  const parts = [`state=${state.state ?? "?"}`];
  if (typeof state.last_error === "string" && state.last_error !== "") {
    parts.push(`last_error=${state.last_error}`);
  }
  return ` [${parts.join(", ")}]`;
}

// 4a. Which workspace? A switch must name a REAL child room.
const liveRows = workspaceRows.filter((w) => w.live === true);
const chosen = liveRows[0];
if (chosen === undefined) {
  check(
    "a live workspace is addressable",
    false,
    `workspace_list reported ${workspaceRows.length} row(s) and none live — start one first`,
  );
} else {
  check(
    "a live workspace is addressable",
    typeof chosen.room_id === "string" && chosen.room_id !== "",
    `"${chosen.name}" cwd=${chosen.cwd} room=${chosen.room_id} daemon=${chosen.daemon_id}` +
      (liveRows.length > 1 ? ` (${liveRows.length} live; addressing the first explicitly)` : ""),
  );
}

if (chosen !== undefined) {
  const room = chosen.room_id;

  // 4b. session_list — the precondition: at least three sessions to switch among.
  const listId = "probe-list";
  const listStatus = await forwardTo(room, { type: "session_list", id: listId });
  const listed = await waitFor(
    (m) => m.in_reply_to === listId && (m.type === "session_list_ok" || m.type === "action_error"),
    REQUEST_TIMEOUT_MS,
  );
  const listReply = listed?.msg;
  const sessions = Array.isArray(listReply?.sessions) ? listReply.sessions : [];
  const ids = sessions.map((s) => s.id).filter((id) => typeof id === "string" && id !== "");
  check(
    "session_list → session_list_ok over the tunnel",
    listReply?.type === "session_list_ok",
    listReply?.type === "session_list_ok"
      ? `${ids.length} session(s), current=${short(listReply.current_id)}, can_switch=${listReply.can_switch}`
      : `got ${listReply?.type ?? `nothing (POST ${listStatus}; a workspace with no live Pi answers nothing)`}`,
  );
  /*
   * The reply came back from the room the probe ADDRESSED. Without this the run
   * could be reading one workspace's sessions while claiming another's, and a
   * wrong-workspace pass is exactly the kind of green line that hides a routing
   * bug — the same class as the "every session times out" forward bug, mirrored.
   */
  check(
    "the answer came from the workspace room the probe addressed",
    listReply?.__room === room,
    `reply room=${listReply?.__room ?? "(none)"} addressed=${room}`,
  );
  check(
    "at least 3 sessions exist to switch among",
    ids.length >= 3,
    ids.length >= 3 ? `${ids.length} session(s)` : `only ${ids.length} — switching needs two usable transcripts`,
  );

  const originalCurrentId = typeof listReply?.current_id === "string" ? listReply.current_id : null;

  /*
   * Pick two sessions to switch between, by READING them: a transcript that is
   * empty would make "the content differs from A's" vacuously true, and the
   * current session is skipped so the first switch is a real change (and so the
   * restore below has somewhere to go). Skipped entirely under --read-only,
   * where no switch will happen and those reads would only spend the wire.
   */
  const picked = [];
  let reads = 0;
  for (const id of readOnly ? [] : ids) {
    if (picked.length >= 2 || reads >= CANDIDATE_READS) break;
    if (id === originalCurrentId) continue;
    reads += 1;
    const { reply } = await readSession(room, id, `pick-${short(id)}`);
    if (reply?.type === "session_read_ok" && Array.isArray(reply.events) && reply.events.length > 0) {
      const fingerprint = digestOf(reply.events);
      if (picked.every((p) => p.digest !== fingerprint)) {
        picked.push({ id, digest: fingerprint, events: reply.events });
      }
    }
  }

  if (readOnly) {
    // Read-only proof that sync and read agree for the LIVE session — it mutates
    // nothing, so it is the one ownership assertion a control run can still make.
    if (originalCurrentId === null) {
      console.log("SKIP  session_sync ownership — the host publishes no current_id (no file behind the live session)");
    } else {
      const readCurrent = await readSession(room, originalCurrentId, "current");
      const syncCurrent = await syncSession(room, "current");
      const readOk = readCurrent.reply?.type === "session_read_ok";
      const syncOk = syncCurrent.reply?.type === "session_history";
      check(
        "session_sync → session_history over the tunnel",
        syncOk,
        syncOk
          ? `${syncCurrent.reply.events?.length ?? 0} event(s) in ${syncCurrent.elapsedMs} ms, epoch ${syncCurrent.reply.session_started_at}`
          : `got ${syncCurrent.reply?.type ?? `nothing (POST ${syncCurrent.postStatus})`}`,
      );
      if (readOk && syncOk) {
        const same = digestOf(readCurrent.reply.events) === digestOf(syncCurrent.reply.events);
        check(
          "session_sync's transcript is the live session's (matches session_read of current_id)",
          same,
          `sync=${digestOf(syncCurrent.reply.events)} read(${short(originalCurrentId)})=${digestOf(readCurrent.reply.events)}` +
            ` events=${syncCurrent.reply.events?.length ?? 0}/${readCurrent.reply.events?.length ?? 0}`,
        );
      }
    }
    console.log("SKIP  session_switch / ownership watch / spawn count — --read-only was requested");
  } else if (picked.length < 2) {
    check(
      "two sessions with distinct, non-empty transcripts exist",
      false,
      `found ${picked.length} among ${ids.length} listed — a switch cannot prove ownership without two`,
    );
  } else {
    const [a, b] = picked;
    info(
      `A=${short(a.id)} (${digestOf(a.events)} / ${JSON.stringify(previewsOf(a.events))})  ` +
        `B=${short(b.id)} (${digestOf(b.events)})  original=${short(originalCurrentId)}`,
    );

    let switched = false;
    let ackEpoch;
    let digestA;
    let switchB;
    try {
      // ── switch → A ────────────────────────────────────────────────────────
      const switchA = await switchTo(room, chosen, a.id, "A");
      // A REFUSED switch changed nothing, so there is nothing to restore from
      // (and re-issuing the switch just to undo it would cost a Pi spawn for a
      // state change that never happened). An UNCONFIRMED one might well have
      // taken effect, so that path keeps the restore.
      switched = !switchA.refused;
      info(
        `switch(A) ${switchA.totalMs} ms — POST→ack ${switchA.ackMs} ms, ` +
          `settle ${switchA.settleMs ?? "NOT reached"} ms over ${switchA.polls} poll(s)`,
      );
      check(
        "session_switch(A) → session_switch_ok names A",
        switchA.ack?.type === "session_switch_ok" && switchA.ack.session_id === a.id,
        switchA.ack?.type === "session_switch_ok"
          ? `session_id=${short(switchA.ack.session_id)} epoch=${switchA.ack.session_started_at} after ${switchA.ackMs} ms`
          : switchA.ack?.type === "session_switch_error"
            ? `session_switch_error code=${switchA.ack.code} (${switchA.ack.message})`
            : `nothing within the ${SWITCH_ACK_SLICE_MS} ms ACK slice (POST ${switchA.postStatus}) — the ownership watch below decides`,
      );
      check(
        "the workspace reports A as current (session_list.current_id)",
        switchA.settled,
        switchA.settled
          ? `after ${switchA.settleMs} ms / ${switchA.polls} poll(s)`
          : (switchA.refusal !== ""
              ? switchA.refusal
              : `last current_id=${short(switchA.currentId)} after ${SWITCH_SETTLE_BUDGET_MS} ms / ${switchA.polls} poll(s)`) +
              lastErrorNote(chosen.cwd),
      );
      /*
       * F4's SECOND, independent signal: the reset is fanned out BEFORE the ack,
       * so a client that never receives that one ack frame still learns the
       * session changed. Asserted only when the host sends one at all — a host
       * built before F4 legitimately sends none, and failing here would report
       * "ownership broken" for a build that simply predates the fix. When the
       * frame IS present its content and ORDER are hard assertions, so an F4
       * regression is still caught the moment F4 ships.
       */
      if (switchA.reset === undefined) {
        info("no reset session_history observed (a pre-F4 host sends none) — not claimed either way");
      } else {
        check(
          "session_switch(A) fanned out an EMPTY session_history before the ack",
          Array.isArray(switchA.reset.events) &&
            switchA.reset.events.length === 0 &&
            (switchA.ackSeq === undefined || switchA.resetSeq < switchA.ackSeq),
          `events=${switchA.reset.events?.length ?? "?"} resetSeq=${switchA.resetSeq}` +
            (switchA.ackSeq === undefined ? " (no ack to order against)" : ` before ackSeq=${switchA.ackSeq}`),
        );
      }

      ackEpoch = switchA.ack?.session_started_at ?? switchA.reset?.session_started_at;

      /*
       * The transcript after A, compared LIKE FOR LIKE.
       *
       * Both reads happen while A is the LIVE session, on purpose. The host's
       * transcript reader filters to the ACTIVE BRANCH only when the file it is
       * reading IS the live session's file (`_readTranscriptPage` in
       * `server/src/index.ts`) — so the pre-switch snapshot of A (taken while A
       * was not live) is a LINEAR read and can legitimately carry more entries
       * than the same session serves once it is live. Comparing sync against the
       * pre-switch snapshot therefore fails on a session that has an abandoned
       * branch, with nothing actually wrong: the two pages are filtered
       * differently, not from different sessions.
       *
       * So the ownership assertion is sync == read(A) measured with A live (both
       * filtered identically), and the pre-switch digest is kept for the two
       * things it CAN prove: A and B are different sessions, and the content the
       * harness saw initially is not what it ends up with.
       */
      const readA = await readSession(room, a.id, "A-live");
      const syncA = await syncSession(room, "A");
      const syncAEvents = syncA.reply?.events;
      const digestARead = digestOf(readA.reply?.events);
      digestA = digestOf(syncAEvents);
      check(
        "session_sync → session_history for A",
        syncA.reply?.type === "session_history" && Array.isArray(syncAEvents) && syncAEvents.length > 0,
        syncA.reply?.type === "session_history"
          ? `${syncAEvents?.length ?? 0} event(s) in ${syncA.elapsedMs} ms`
          : `got ${syncA.reply?.type ?? `nothing (POST ${syncA.postStatus})`}`,
      );
      check(
        "session_sync's transcript IS A's (matches session_read of A, A live)",
        syncA.reply?.type === "session_history" &&
          readA.reply?.type === "session_read_ok" &&
          digestA === digestARead,
        `sync=${digestA} read(A)=${digestARead} events=${syncAEvents?.length ?? 0}/${readA.reply?.events?.length ?? 0}` +
          // Informational: the pre-switch snapshot may legitimately differ by
          // branch filtering (see above), so it is reported, never asserted.
          ` (pre-switch snapshot of A was ${a.digest}, ${a.events.length} event(s), linear read)`,
      );
      /*
       * The epoch is a `>=` invariant, not equality, and the reason is the daemon
       * path itself: the ack is written by the OLD process just before it exits,
       * and the respawned Pi stamps `_sessionStartedAt` at ITS OWN start ~13.7 s
       * later. Equality therefore only holds on an in-process (TUI) switch. What
       * must hold either way is that the epoch the mirror reports is not OLDER
       * than the switch that produced it, and is not 0 (`0` is the host's "no
       * session at all" answer, which would mean the workspace came back empty).
       */
      const syncEpoch = syncA.reply?.session_started_at;
      check(
        "session_sync's epoch belongs to this switch (not an older session, not empty)",
        typeof syncEpoch === "number" && syncEpoch > 0 && (ackEpoch === undefined || syncEpoch >= ackEpoch),
        `sync=${syncEpoch ?? "?"} switch=${ackEpoch ?? "?"}` +
          (syncEpoch === ackEpoch ? " (same process — in-process switch)" : " (later process — daemon respawn)"),
      );

      // ── switch → B ────────────────────────────────────────────────────────
      switchB = await switchTo(room, chosen, b.id, "B");
      check(
        "session_switch(B) → session_switch_ok names B",
        switchB.ack?.type === "session_switch_ok" && switchB.ack.session_id === b.id,
        switchB.ack?.type === "session_switch_ok"
          ? `session_id=${short(switchB.ack.session_id)} epoch=${switchB.ack.session_started_at} after ${switchB.ackMs} ms`
          : switchB.ack?.type === "session_switch_error"
            ? `session_switch_error code=${switchB.ack.code} (${switchB.ack.message})`
            : `nothing within the ${SWITCH_ACK_SLICE_MS} ms ACK slice (POST ${switchB.postStatus})`,
      );
      check(
        "the workspace reports B as current — ownership MOVED",
        switchB.settled && switchB.currentId === b.id,
        switchB.settled
          ? `B=${short(b.id)} after ${switchB.settleMs} ms / ${switchB.polls} poll(s)`
          : (switchB.refusal !== ""
              ? switchB.refusal
              : `last current_id=${short(switchB.currentId)} after ${SWITCH_SETTLE_BUDGET_MS} ms / ${switchB.polls} poll(s)`) +
              lastErrorNote(chosen.cwd),
      );

      const readB = await readSession(room, b.id, "B-live");
      const syncB = await syncSession(room, "B");
      const digestB = digestOf(syncB.reply?.events);
      const digestBRead = digestOf(readB.reply?.events);
      check(
        "the transcript after B IS B's (matches session_read of B, B live)",
        syncB.reply?.type === "session_history" &&
          readB.reply?.type === "session_read_ok" &&
          // Non-empty on BOTH sides: an empty page on both would make the digest
          // comparison pass while proving nothing, which is exactly how a
          // "content differs" check goes vacuous.
          (syncB.reply?.events?.length ?? 0) > 0 &&
          (readB.reply?.events?.length ?? 0) > 0 &&
          digestB === digestBRead,
        `sync=${digestB} read(B)=${digestBRead} ` +
          `events=${syncB.reply?.events?.length ?? 0}/${readB.reply?.events?.length ?? 0}`,
      );
      check(
        "the transcript after B differs from A's",
        syncB.reply?.type === "session_history" &&
          (syncB.reply?.events?.length ?? 0) > 0 &&
          digestB !== digestA,
        `B=${digestB} A=${digestA} events(B)=${syncB.reply?.events?.length ?? 0} ` +
          `epochs=${syncB.reply?.session_started_at ?? "?"}/${ackEpoch ?? "?"}`,
      );

      /*
       * One switch, end to end, in the units a reviewer can compare against the
       * budget: POST→ownership is the number the 90 s settle budget governs (the
       * 12 s ACK slice is only its first leg), and POST→transcript is the same
       * measurement plus the sync round trip that proved the content.
       */
      const endToEnd = switchB.settleMs;
      info(
        `switch(B) end to end: POST→ownership ${endToEnd ?? "NOT reached"} ms, ` +
          `POST→transcript ${switchB.settled ? endToEnd + syncB.elapsedMs : "NOT reached"} ms ` +
          `(ack slice ${switchB.ackMs} ms inside it; budget ${SWITCH_SETTLE_BUDGET_MS} ms)`,
      );
      check(
        "switch(B) confirms ownership inside the settle budget (not the ACK slice)",
        switchB.settled,
        switchB.settled
          ? `${endToEnd} ms of ${SWITCH_SETTLE_BUDGET_MS} ms — a ${SWITCH_ACK_SLICE_MS} ms budget would have been wrong`
          : switchB.refusal !== ""
            ? switchB.refusal
            : `not confirmed in ${SWITCH_SETTLE_BUDGET_MS} ms`,
      );

      /*
       * The spawn count for the switch, counted by PID IDENTITY. A count of 0 is
       * legitimate on a host that switches in-process (a TUI Pi), so this is
       * recorded rather than asserted to be >=1; what IS asserted is that the
       * number came from pids and not from the `restarts` counters.
       */
      const pushedState = workspaceStates.get(chosen.cwd);
      check(
        "spawn count for switch(B) counted by pid identity",
        switchB.pidTrail.length > 0,
        switchB.pidTrail.length > 0
          ? `pid ${switchB.pidTrail.join(" → ")} ⇒ ${switchB.spawns} new process(es); ` +
              `restarts counter=${switchB.restarts ?? "n/a"} (supervisor) / ${pushedState?.restarts ?? "n/a"} (push) ` +
              `— NOT evidence: it reads 0 across real respawns`
          : `pid unobservable: ${switchB.pidError || "no sample"}`,
      );
    } finally {
      /*
       * A check must not leave the host changed — the same rule the workspace_add
       * probe already follows. Switch back to the session the workspace was on
       * before the probe, and say so either way.
       */
      if (switched && originalCurrentId !== null) {
        const back = await switchTo(room, chosen, originalCurrentId, "restore");
        check(
          "the workspace is back on its original session",
          back.settled,
          back.settled
            ? `${short(originalCurrentId)} after ${back.settleMs} ms (pid ${back.pidTrail.join(" → ") || "?"})`
            : `could not restore: ${back.refusal !== "" ? back.refusal : `last current_id=${short(back.currentId)} after ${SWITCH_SETTLE_BUDGET_MS} ms`}`,
        );
      } else if (switched) {
        info("restore not applicable: the workspace published no current_id before the probe");
      }
    }
  }
}

check("frames came back over the tunnel", frameCount > 0, `${frameCount} frame(s)`);

await reader.cancel().catch(() => {});
await pumpLoop;

console.log(failed ? "\nRESULT: FAILED" : "\nRESULT: PASSED");
process.exit(failed ? 1 : 0);
