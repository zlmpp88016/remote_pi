// Measures how long `workspace_start` takes for a workspace that has NEVER run,
// and whether its room answers `session_list` right after. This is the probe
// behind the "opening a stopped workspace spins for 12 s" bug.
const { randomUUID } = await import("node:crypto");

const base = process.argv[2] ?? "http://114.55.178.114:58300";
const cwd = process.argv[3] ?? "D:\\模型测试\\测试题";

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

const post = (msg) =>
  fetch(`${base}/api/frame?id=${encodeURIComponent(cid)}`, {
    method: "POST",
    headers: { Origin: base, Cookie: cookie, "content-type": "application/json" },
    body: JSON.stringify(msg),
  });

const fwd = async (room, inner, ms) => {
  const t0 = Date.now();
  await post({
    type: "host_forward",
    id: `f_${inner.id}`,
    room,
    ct: Buffer.from(JSON.stringify(inner)).toString("base64"),
  });
  while (Date.now() - t0 < ms) {
    const h = frames.find((f) => f.in_reply_to === inner.id);
    if (h) return { hit: h, ms: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, 50));
  }
  return { hit: null, ms: Date.now() - t0 };
};

const start = await fwd("host", { type: "workspace_start", id: randomUUID(), cwd }, 40000);
console.log(
  `workspace_start(cwd="${cwd}") -> ` +
    (start.hit ? `${start.hit.type} in ${start.ms} ms` : `NO REPLY in ${start.ms} ms`),
);
if (start.hit) console.log("  payload:", JSON.stringify(start.hit).slice(0, 240));

if (start.hit && start.hit.room_id) {
  const roomId = start.hit.room_id;
  console.log(`  room=${roomId}; probing session_list immediately…`);
  const sl = await fwd(roomId, { type: "session_list", id: randomUUID() }, 15000);
  console.log(
    `  session_list right after start -> ` +
      (sl.hit ? `${sl.hit.type} in ${sl.ms} ms` : `NO REPLY in ${sl.ms} ms`),
  );
}
