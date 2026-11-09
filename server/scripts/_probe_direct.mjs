// Uses the SAME wire shape the app uses: host-direct types are sent verbatim
// to room `host` (see clients/mobile/lib/data/transport/host_proxy.dart,
// `kHostDirectTypes`), NOT wrapped in `host_forward`.
//
// Wrapping them was the mistake in my first probe: it produced a synthetic
// `ambiguous_workspace` that the real client never hits.
const { randomUUID } = await import("node:crypto");

const base = process.argv[2] ?? "http://114.55.178.114:58300";

const events = await fetch(`${base}/api/events`, {
  headers: { Accept: "text/event-stream" },
});
const frames = [];
let cid = null;
const cookie = (events.headers.get("set-cookie") ?? "").split(";")[0];

{
  const reader = events.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const ch = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const m = /^data:\s*(.*)$/m.exec(ch);
        if (!m?.[1]) continue;
        let j;
        try {
          j = JSON.parse(m[1]);
        } catch {
          continue;
        }
        if (j.id && !j.ct) {
          cid ??= j.id;
          continue;
        }
        if (typeof j.ct !== "string") continue;
        let inner;
        try {
          inner = JSON.parse(Buffer.from(j.ct, "base64").toString());
        } catch {
          continue;
        }
        if (inner?.type === "host_message" && typeof inner.ct === "string") {
          try {
            inner = JSON.parse(Buffer.from(inner.ct, "base64").toString());
          } catch {
            continue;
          }
        }
        frames.push(inner);
      }
    }
  })().catch(() => {});
}

for (let i = 0; i < 100 && cid === null; i += 1) {
  await new Promise((r) => setTimeout(r, 50));
}

// Host-direct: the message IS the frame body, room is carried by the request.
const post = (msg) =>
  fetch(`${base}/api/frame?id=${encodeURIComponent(cid)}&room=host`, {
    method: "POST",
    headers: { Origin: base, Cookie: cookie, "content-type": "application/json" },
    body: JSON.stringify(msg),
  });

const call = async (msg, ms) => {
  const t0 = Date.now();
  await post(msg);
  while (Date.now() - t0 < ms) {
    const h = frames.find((f) => f.in_reply_to === msg.id);
    if (h) return { hit: h, ms: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, 50));
  }
  return { hit: null, ms: Date.now() - t0 };
};

const sl = await call({ type: "session_list", id: randomUUID() }, 15000);
console.log(`session_list on the AMBIGUOUS host room -> ` + (sl.hit ? `${sl.hit.type} in ${sl.ms} ms` : `NO REPLY in ${sl.ms} ms  <-- the 12 s timeout`));
if (sl.hit) console.log("  ", JSON.stringify(sl.hit).slice(0,180));

const list = await call({ type: "workspace_list", id: randomUUID() }, 10000);
console.log(
  `workspace_list (direct) -> ` +
    (list.hit ? `${list.hit.type} in ${list.ms} ms` : `NO REPLY in ${list.ms} ms`),
);
if (list.hit?.workspaces) {
  for (const w of list.hit.workspaces) {
    console.log(`   ${w.live ? "LIVE" : "off "}  ${w.name ?? w.cwd}  room=${w.room_id}`);
  }
}
