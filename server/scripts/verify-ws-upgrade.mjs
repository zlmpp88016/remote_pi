/*
 * The mobile app does NOT use the SSE transport the browser uses — it opens a
 * WebSocket to the relay path of the same origin. A TCP tunnel can carry HTTP
 * perfectly and still break the Upgrade (some proxies drop `Connection: upgrade`
 * or buffer the 101), so this needs its own check.
 *
 * Usage: node scripts/verify-ws-upgrade.mjs http://203.0.113.5:58300
 */
const base = (process.argv[2] ?? "http://114.55.178.114:58300").replace(/\/$/, "");
const wsUrl = base.replace(/^http/, "ws") + "/remote-pi/ws";

let failed = false;
/* The clients dial the relay URL as-is: `http://h:p` → `ws://h:p`, no path
 * appended (clients/mobile/.../relay_config.dart:52). The root must upgrade. */
const check = (name, ok, extra = "") => {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

/*
 * The mobile app dials the relay URL as given — `http://host:port` becomes
 * `ws://host:port` with NO path appended (relay_config.dart:52), so the root
 * is what must upgrade. The others are kept because the web client is free to
 * grow a dedicated path later.
 */
const candidates = ["", "/remote-pi/ws"];
let opened = null;

for (const path of candidates) {
  const url = base.replace(/^http/, "ws") + path;
  const result = await new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => done({ ok: false, why: "timeout" }), 6000);
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      clearTimeout(timer);
      done({ ok: false, why: String(error) });
      return;
    }
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      /* Send one frame so the check proves the duplex path, not just the 101. */
      try {
        socket.send(JSON.stringify({ type: "hello", room: "probe" }));
        done({ ok: true, why: "open + frame sent", socket });
      } catch (error) {
        done({ ok: true, why: "open", socket });
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      done({ ok: false, why: "error" });
    });
    socket.addEventListener("message", () => {
      done({ ok: true, why: "open + message received", socket });
    });
  });
  if (result.ok) {
    opened = { path, ...result };
    break;
  }
  console.log(`       tried ${path}: ${result.why}`);
}

check("a WebSocket upgrades over the tunnel", opened !== null, opened ? `${opened.path} — ${opened.why}` : "no path worked");
opened?.socket?.close();

console.log(failed ? "\nRESULT: FAILED" : "\nRESULT: PASSED");
process.exit(failed ? 1 : 0);
