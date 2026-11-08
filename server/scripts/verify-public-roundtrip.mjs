/*
 * End-to-end check over the PUBLIC entry point (frp tunnel):
 * bootstrap → SSE /api/events → POST /api/frame → get a real answer back.
 *
 * `verify-lan-connect.mjs` proves the browser PAIRS. This proves the transport
 * actually carries traffic in both directions through the tunnel, which is the
 * part a TCP forward can silently break (half-open sockets, buffering proxies).
 *
 * Usage: node scripts/verify-public-roundtrip.mjs http://114.55.178.114:58300
 */

const base = (process.argv[2] ?? "http://114.55.178.114:58300").replace(/\/$/, "");

let failed = false;
const check = (name, ok, extra = "") => {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

const origin = base;

/** Minimal cookie jar — Node's fetch has none. */
let cookie = "";
const remember = (res) => {
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const line of raw) {
    const pair = line.split(";")[0];
    if (pair.startsWith("pi_bootstrap=")) cookie = pair;
  }
};

// 1. Load the page to receive the signed bootstrap cookie.
const page = await fetch(`${base}/remote-pi/connect`);
remember(page);
check("page loads over the tunnel", page.status === 200, `status ${page.status}`);
check("bootstrap cookie issued", cookie !== "");

// 2. Bootstrap: proves the same-origin gate accepts the PUBLIC host.
const boot = await fetch(`${base}/api/bootstrap`, {
  method: "POST",
  headers: { Origin: origin, Cookie: cookie, "content-type": "application/json" },
  body: "{}",
});
const bootBody = await boot.json().catch(() => ({}));
check("POST /api/bootstrap accepted", boot.status === 200, `status ${boot.status}`);
check("bootstrap returns a token", typeof bootBody.token === "string" && bootBody.token.length > 0);

// 3. Open the SSE channel and keep it for the rest of the run.
const events = await fetch(`${base}/api/events`, {
  headers: { Origin: origin, Cookie: cookie, Accept: "text/event-stream" },
});
check("/api/events upgraded", events.status === 200, `status ${events.status}`);

const reader = events.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let connectionId = null;
const frames = [];

const pump = (async () => {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    /* SSE frames are separated by a blank line. */
    let split;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const eventName = /^event:\s*(.+)$/m.exec(chunk)?.[1]?.trim() ?? "message";
      const data = /^data:\s*(.*)$/m.exec(chunk)?.[1] ?? "";
      if (eventName === "endpoint" && connectionId === null) {
        try {
          connectionId = JSON.parse(data).id;
        } catch { /* ignore */ }
      } else {
        /* A keepalive is a COMMENT line, not an event — counting it as an
         * answer would make this script pass while nothing was actually routed. */
        if (data !== "") frames.push({ eventName, data });
      }
    }
    if (connectionId !== null && frames.length > 0) break;
  }
})().catch(() => {});

// 4. Wait for the endpoint id the SSE stream announces.
for (let i = 0; i < 60 && connectionId === null; i += 1) {
  await new Promise((r) => setTimeout(r, 100));
}
check("SSE announces a connection id", typeof connectionId === "string" && connectionId.length > 0);

// 5. Post one frame and require an answer — this is the round trip.
const sendStatus = connectionId
  ? await fetch(`${base}/api/frame?id=${encodeURIComponent(connectionId)}`, {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "content-type": "application/json",
      },
      /* A real host_bridge command with a real reply — `ping` answers `pong`,
       * so a frame coming back proves the tunnel carries traffic in BOTH
       * directions instead of just accepting the POST. */
      body: JSON.stringify({ type: "ping", id: "probe-1" }),
    })
      .then((r) => r.status)
      .catch(() => 0)
  : 0;
check("POST /api/frame accepted", sendStatus >= 200 && sendStatus < 300, `status ${sendStatus}`);
await pump;
/* A `pong` addressed back to this stream, not merely *a* frame: anything else
 * (an unrelated broadcast, a keepalive) would not prove the command was routed. */
/* The payload is base64 `{"type":"pong","in_reply_to":"probe-1"}`; decoding
 * beats guessing at a substring, and keeps the check tied to the probe id. */
const decoded = frames.map((f) => {
  try {
    const envelope = JSON.parse(f.data);
    return Buffer.from(envelope.ct ?? "", "base64").toString("utf8");
  } catch {
    return "";
  }
});
const pong = decoded.find((text) => text.includes("pong") && text.includes("probe-1"));
check("the host answered over the tunnel", pong !== undefined, `${frames.length} frame(s)`);
if (pong) console.log("       reply:", pong.slice(0, 120));

await reader.cancel().catch(() => {});

console.log(failed ? "\nRESULT: FAILED" : "\nRESULT: PASSED");
process.exit(failed ? 1 : 0);
