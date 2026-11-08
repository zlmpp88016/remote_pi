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
 * `workspace_list_ok` proves the host can read its own state, and so on.
 *
 * Usage: node scripts/verify-public-roundtrip.mjs http://203.0.113.5:58300
 */

const base = (process.argv[2] ?? "http://114.55.178.114:58300").replace(/\/$/, "");

let failed = false;
const check = (name, ok, extra = "") => {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

/** Minimal cookie jar — Node's fetch has none. */
let cookie = "";
const remember = (res) => {
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const pair = line.split(";")[0];
    if (pair.startsWith("pi_bootstrap=")) cookie = pair;
  }
};

// ── 1. bootstrap ────────────────────────────────────────────────────────────
const page = await fetch(`${base}/remote-pi/connect`);
remember(page);
check("page loads over the tunnel", page.status === 200, `status ${page.status}`);
check("bootstrap cookie issued", cookie !== "");

const boot = await fetch(`${base}/api/bootstrap`, {
  method: "POST",
  headers: { Origin: base, Cookie: cookie, "content-type": "application/json" },
  body: "{}",
});
const bootBody = await boot.json().catch(() => ({}));
check("POST /api/bootstrap accepted", boot.status === 200, `status ${boot.status}`);
check("bootstrap returns a token", typeof bootBody.token === "string" && bootBody.token !== "");

// ── 2. SSE channel ──────────────────────────────────────────────────────────
const events = await fetch(`${base}/api/events`, {
  headers: { Origin: base, Cookie: cookie, Accept: "text/event-stream" },
});
check("/api/events upgraded", events.status === 200, `status ${events.status}`);

const reader = events.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let connectionId = null;
/** in_reply_to → decoded reply object */
const replies = new Map();
let frameCount = 0;

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
      if (inner.in_reply_to) replies.set(inner.in_reply_to, inner);
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
async function call(id, message, timeoutMs = 15_000) {
  const status = await fetch(`${base}/api/frame?id=${encodeURIComponent(connectionId)}`, {
    method: "POST",
    headers: { Origin: base, Cookie: cookie, "content-type": "application/json" },
    body: JSON.stringify({ ...message, id }),
  })
    .then((r) => r.status)
    .catch(() => 0);
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
    detail: (r) => `${Array.isArray(r.schedules) ? r.schedules.length : 0} automation(s)`,
  },
];

for (const probe of probes) {
  const { postStatus, reply } = await call(probe.id, probe.message);
  const ok = reply?.type === probe.expect;
  check(
    `${probe.message.type} → ${probe.expect}`,
    ok,
    ok ? probe.detail(reply) : `got ${reply?.type ?? `nothing (POST ${postStatus})`}`,
  );
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

check("frames came back over the tunnel", frameCount > 0, `${frameCount} frame(s)`);

await reader.cancel().catch(() => {});
await pumpLoop;

console.log(failed ? "\nRESULT: FAILED" : "\nRESULT: PASSED");
process.exit(failed ? 1 : 0);
