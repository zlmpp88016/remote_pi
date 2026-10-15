/**
 * ============================ SYNTHETIC FIXTURE ============================
 * This is NOT a real daemon, NOT a real relay and NOT real host data.
 *
 * It exists for ONE purpose: let the root session drive the real
 * `/remote-pi/connect` browser UI (plan 69 Wave 3) against a local, isolated,
 * throwaway host — without touching a real Pi, a real `~/.pi/remote`, real
 * credentials or the production relay.
 *
 * Everything it serves is fabricated at startup under a fresh OS temp dir:
 *   • the relay/host wire is `scripts/relay-stub.mjs` (the same stub the
 *     verification scripts already use), started on 127.0.0.1:8796 with an
 *     Origin allowlist of exactly ONE synthetic origin (default
 *     `http://127.0.0.1:3167`, the isolated Next dev server). The stub's
 *     historical rule is preserved: a request with NO Origin header (native
 *     app / remote-pi / Cockpit clients) is ALLOWED even with the allowlist
 *     enabled — see `OriginPolicy::allows` in `relay/src/origin.rs:79-86`.
 *   • the pairing token and the Ed25519 host key are generated in-process and
 *     thrown away on exit. The PRIVATE KEY is never printed; only the PUBLIC
 *     host key (which is already public by construction) appears in the pair
 *     URI.
 *   • the host filesystem is a synthetic tree of empty files/dirs. It is
 *     NEVER the real home and NEVER the current working directory: it is a
 *     fresh `mkdtempSync` directory under `os.tmpdir()`, and startup fails
 *     closed if the resolved root is not a newly created directory inside the
 *     temp dir, or if it equals the home dir or the cwd. (On Windows
 *     `tmpdir()` legitimately lives *inside* the user profile, so the guard
 *     asserts IDENTITY and ORIGIN — root != home, root != cwd, root under
 *     tmpdir — rather than non-containment.)
 *
 * Control plane (TEST-ONLY, localhost, NOT the app API):
 *   127.0.0.1:8797 is a plain HTTP admin surface used by the test harness to
 *   inject lifecycle pushes and failure modes. It is bound to 127.0.0.1 and
 *   is not part of the product protocol — nothing in `src/` knows it exists.
 *     GET /health
 *         → { ok: true }
 *     GET /state?cwd=<path>&state=<running|starting|crashed|stopped>&restarts=<n>
 *         → host-room `workspace_state` PUSH (no id, no in_reply_to) to every
 *           paired peer. `crashed` carries a synthetic `last_error` canary.
 *     GET /failure?target=list|start|fs|restart|add|restartRaw&on=1|0
 *         → toggles one failure flag. `restartRaw` emits a `workspace_restart_
 *           error` whose code AND message are the raw canary (safe-close test).
 *     GET /stats
 *         → { counts, flags, root, peers } — counters and flags only, NEVER
 *           the token or any credential.
 *     GET /stop
 *         → graceful shutdown: closes relay + control + removes the temp root.
 *
 * Temp / cleanup: the fixture removes ONLY its own temp root and closes ONLY
 * its own sockets/connections. It does that on `/stop`, on SIGTERM and on
 * SIGINT. Nothing outside its temp dir is ever written or deleted.
 *
 * PLATFORM LIMITATION (signals): Node on Windows cannot deliver a catchable
 * SIGTERM/SIGINT from another process — `kill`/`taskkill /F` terminate the
 * process outright and no JS handler runs (verified on this host). The
 * RELIABLE shutdown path on every platform is therefore `GET /stop`. As a
 * second net, a synchronous `process.on("exit")` hook removes the temp root
 * for any JS-level exit (uncaught exception, `process.exit`, natural end);
 * it does NOT cover a hard OS kill on Windows, where only `/stop` does.
 *
 * Synthetic filesystem layout (under `<tmp>/remote-pi-ui-fixture-XXXX/`):
 *   alpha/            dir, contains `.git/` (so `fs_list` reports is_repo)
 *   alpha/README.md   file
 *   empty/            empty dir
 *   .hidden/          hidden dir (only listed with show_hidden=true)
 *   .secret.txt       hidden file (same)
 *   notes.txt         file — used as the `not_a_directory` probe
 *   missing-xyz/      intentionally ABSENT — the `not_found` probe
 *   noperm/           best-effort chmod 000 — see PLATFORM LIMITATION below
 *
 * PLATFORM LIMITATION (permission_denied): a real `EACCES` is not portable
 * from a test process — on Windows `chmod` is a no-op for read access, and on
 * POSIX a privileged runner ignores it. The real filesystem probe is therefore
 * best-effort; the DETERMINISTIC `permission_denied` path is served by the
 * stub's `/failure?target=fs` injection, which returns the documented
 * `action_error{action:"fs_list", error:"permission_denied"}`.
 *
 * Usage:
 *   node scripts/workspace-ui-fixture.mjs [--relay-port 8796] [--control-port 8797]
 *                                        [--origin http://127.0.0.1:3167]
 */

import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath, sep } from "node:path";
import { startRelayStub } from "./relay-stub.mjs";

/** Synthetic, in-process pairing token. Never a real host credential. */
const SYNTHETIC_TOKEN = "synthetic-fixture-token";
/** Synthetic raw host text. Must NEVER reach the UI (asserted by the run). */
const SYNTHETIC_CANARY = "SYNTHETIC-RAW-CANARY";
const DEFAULT_RELAY_PORT = 8796;
const DEFAULT_CONTROL_PORT = 8797;
const DEFAULT_ORIGIN = "http://127.0.0.1:3167";
const CONTROL_HOST = "127.0.0.1";

function argValue(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

/** Builds the throwaway synthetic tree. Fails closed unless the root is a
 *  fresh directory created by THIS call under `os.tmpdir()` — never the real
 *  home, never the cwd. */
function buildSyntheticRoot() {
  const tempRoot = resolvePath(tmpdir());
  const root = resolvePath(mkdtempSync(join(tempRoot, "remote-pi-ui-fixture-")));
  const realHome = process.env.HOME || process.env.USERPROFILE || "";
  const cwd = resolvePath(process.cwd());
  const underTemp = root.startsWith(tempRoot + sep) && root !== tempRoot;
  const named = root.slice(tempRoot.length + 1).startsWith("remote-pi-ui-fixture-");
  if (!underTemp || !named) {
    throw new Error("refusing to build the fixture outside its own temp directory");
  }
  if (root === cwd || (realHome !== "" && root === resolvePath(realHome))) {
    throw new Error("refusing to build the fixture on the real home or the cwd");
  }
  mkdirSync(join(root, "alpha", ".git"), { recursive: true });
  writeFileSync(join(root, "alpha", "README.md"), "# alpha (synthetic)\n");
  mkdirSync(join(root, "empty"), { recursive: true });
  mkdirSync(join(root, ".hidden"), { recursive: true });
  writeFileSync(join(root, ".secret.txt"), "synthetic hidden file\n");
  writeFileSync(join(root, "notes.txt"), "synthetic notes\n");
  // Best-effort only — see PLATFORM LIMITATION in the header.
  const noperm = join(root, "noperm");
  mkdirSync(noperm, { recursive: true });
  try {
    chmodSync(noperm, 0o000);
  } catch {
    /* Windows / restricted runner: the deterministic path is /failure?target=fs */
  }
  return root;
}

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": payload.length });
  res.end(payload);
}

async function main() {
  const relayPort = Number(argValue("relay-port", DEFAULT_RELAY_PORT));
  const controlPort = Number(argValue("control-port", DEFAULT_CONTROL_PORT));
  const origin = argValue("origin", DEFAULT_ORIGIN);

  const root = buildSyntheticRoot();
  const flags = {
    list: false,
    start: false,
    fs: false,
    restart: false,
    add: false,
    restartRaw: false,
  };
  const fixture = { flags, counts: {}, canary: SYNTHETIC_CANARY, push: null };

  const stub = await startRelayStub({
    port: relayPort,
    // Exactly ONE synthetic origin is allow-listed, and the stub's OWN host
    // connection uses that same origin (otherwise the stub would reject
    // itself at the upgrade). A request with no Origin header — native
    // clients/mobile/remote-pi/Cockpit clients — is still allowed (relay/src/origin.rs).
    originAllowlist: [origin],
    hostOrigin: origin,
    token: SYNTHETIC_TOKEN,
    fixture,
  });

  let stopped = false;
  const sockets = new Set();
  const control = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${CONTROL_HOST}:${controlPort}`);
    switch (url.pathname) {
      case "/health":
        json(res, 200, { ok: true });
        return;
      case "/state": {
        const cwd = url.searchParams.get("cwd") ?? "";
        const state = url.searchParams.get("state") ?? "running";
        const restarts = Number(url.searchParams.get("restarts") ?? "0");
        if (!cwd) {
          json(res, 400, { ok: false, error: "cwd_required" });
          return;
        }
        const result = fixture.push({
          cwd,
          state,
          last_error: state === "crashed" ? SYNTHETIC_CANARY : null,
          restarts: Number.isFinite(restarts) ? restarts : 0,
        });
        json(res, 200, { ok: true, ...result });
        return;
      }
      case "/failure": {
        const target = url.searchParams.get("target") ?? "";
        const on = url.searchParams.get("on") !== "0";
        if (!(target in flags)) {
          json(res, 400, { ok: false, error: "unknown_target", targets: Object.keys(flags) });
          return;
        }
        flags[target] = on;
        json(res, 200, { ok: true, flags: { ...flags } });
        return;
      }
      case "/stats":
        // Counters and flags only — the token never appears here.
        json(res, 200, { ok: true, counts: { ...fixture.counts }, flags: { ...flags }, root });
        return;
      case "/stop":
        json(res, 200, { ok: true, stopping: true });
        void shutdown(0);
        return;
      default:
        json(res, 404, { ok: false, error: "not_found" });
    }
  });
  control.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolveListen) => control.listen(controlPort, CONTROL_HOST, resolveListen));

  function removeTempRoot() {
    try {
      chmodSync(join(root, "noperm"), 0o700);
    } catch {
      /* best-effort: the dir may be unreadable by design or already gone */
    }
    rmSync(root, { recursive: true, force: true });
  }

  async function shutdown(code) {
    if (stopped) return;
    stopped = true;
    try {
      await stub.close();
    } catch {
      /* already gone */
    }
    control.closeAllConnections?.();
    await new Promise((resolveClose) => control.close(() => resolveClose()));
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    removeTempRoot();
    console.log("[fixture] stopped — temp root removed, own connections closed");
    process.exit(code);
  }

  // Second net (best-effort): a synchronous exit hook covers every JS-level
  // exit — uncaught exception, explicit process.exit, natural end. It does NOT
  // cover a hard OS kill on Windows (see the header limitation).
  process.on("exit", () => {
    if (stopped) return;
    stopped = true;
    removeTempRoot();
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      void shutdown(0);
    });
  }

  // Startup output: synthetic pair URI, temp root, test ports ONLY.
  const epk = Buffer.from(stub.hostEpk, "base64").toString("base64url");
  const pairUri =
    `remotepi://pair?t=${SYNTHETIC_TOKEN}` +
    `&epk=${epk}&n=host&rm=host&r=ws://127.0.0.1:${stub.port}`;
  console.log("=== SYNTHETIC fixture — not a real daemon, not real host data ===");
  console.log(`[fixture] relay    ws://127.0.0.1:${stub.port}  (allowlist: ${origin}; no-Origin native allowed)`);
  console.log(`[fixture] control  http://${CONTROL_HOST}:${controlPort}  (TEST-ONLY, not the app API)`);
  console.log(`[fixture] root     ${root}`);
  console.log(`[fixture] pair URI ${pairUri}`);
  console.log("[fixture] shutdown: GET /stop (reliable everywhere); SIGTERM/SIGINT on POSIX only");}

await main();
