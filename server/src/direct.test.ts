import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { Socket } from "node:net";
import { ensureDirectRelay, readDirectState, stopDirectRelay, wantsDirect } from "./direct.js";
import { resolveRelayUrl } from "./config.js";

/**
 * `--direct` publishes the embedded relay address through `REMOTE_PI_RELAY`.
 *
 * The contract worth pinning is the INTERACTION with the existing relay
 * resolution (`server/src/config.ts:51`), because the whole feature is "make
 * every consumer resolve the local relay without touching the user's saved
 * config":
 *
 *   - the env tier must win, so `resolveRelayUrl()` reports the local address;
 *   - `~/.pi/remote/config.json` must remain untouched (killing the process
 *     reverts cleanly — no stale port pinned on disk);
 *   - an operator's explicit `REMOTE_PI_RELAY` must NOT be silently replaced.
 */

const ORIGINAL = process.env["REMOTE_PI_RELAY"];

beforeEach(() => {
  delete process.env["REMOTE_PI_RELAY"];
});

afterEach(async () => {
  await stopDirectRelay();
  if (ORIGINAL === undefined) delete process.env["REMOTE_PI_RELAY"];
  else process.env["REMOTE_PI_RELAY"] = ORIGINAL;
});

describe("wantsDirect", () => {
  test("detects the flag anywhere in argv", () => {
    expect(wantsDirect(["--direct"])).toBe(true);
    expect(wantsDirect(["--log", "summary", "--direct"])).toBe(true);
    expect(wantsDirect(["--log", "summary"])).toBe(false);
    expect(wantsDirect([])).toBe(false);
  });
});

describe("ensureDirectRelay", () => {
  test("publishes a loopback address through REMOTE_PI_RELAY", async () => {
    const url = await ensureDirectRelay({ port: 0 });

    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // Canonical http:// form, because that is what buildQRUri's `r=` carries
    // and what `resolveRelayUrl` keeps on disk.
    expect(process.env["REMOTE_PI_RELAY"]).toBe(url);
  });

  test("makes resolveRelayUrl report the local relay via the env tier", async () => {
    const url = await ensureDirectRelay({ port: 0 });

    const resolved = resolveRelayUrl();
    expect(resolved.url).toBe(url);
    expect(resolved.source).toBe("env");
  });

  test("is idempotent — a second call reuses the same relay, not a new port", async () => {
    const first = await ensureDirectRelay({ port: 0 });
    const second = await ensureDirectRelay({ port: 0 });
    expect(second).toBe(first);
  });

  test("does NOT override an operator's explicit REMOTE_PI_RELAY", async () => {
    // An operator exporting this made a deliberate choice; the flag must not
    // silently win by accident of ordering.
    process.env["REMOTE_PI_RELAY"] = "http://operator.example:9000";

    await ensureDirectRelay({ port: 0 });

    expect(process.env["REMOTE_PI_RELAY"]).toBe("http://operator.example:9000");
  });

  test("stops the relay and leaves no listening socket behind", async () => {
    const url = await ensureDirectRelay({ port: 0 });
    const port = Number(new URL(url).port);
    expect(port).toBeGreaterThan(0);

    await stopDirectRelay();

    // The port must be refused now — a lingering listener would make the next
    // `--direct` run collide or, worse, silently serve a stale relay.
    await expect(
      new Promise<void>((resolve, reject) => {
        const socket = new Socket();
        socket.once("connect", () => {
          socket.destroy();
          reject(new Error("port still accepting connections after stop"));
        });
        socket.once("error", () => resolve());
        socket.connect(port, "127.0.0.1");
      }),
    ).resolves.toBeUndefined();
  });
});

describe("readDirectState", () => {
  test("reports live state for the current pid", async () => {
    const url = await ensureDirectRelay({ port: 0 });
    const state = await readDirectState();
    expect(state).not.toBeNull();
    expect(state?.pid).toBe(process.pid);
    expect(state?.url).toBe(url);
  });

  test("returns null for a pid that is not running", async () => {
    /*
     * A stale file must not be reported as live. This is the exact failure the
     * reviewer named: SIGKILL leaves the discovery file behind pointing at a dead
     * port, and a consumer that trusted it would dial into a timeout.
     *
     * 0x7FFFFFFE is outside the range any real process on this platform can hold,
     * so the probe reports ESRCH without racing a real pid.
     */
    const url = await ensureDirectRelay({ port: 0 });
    const state = await readDirectState();
    expect(state?.port).toBe(Number(new URL(url).port));

    const file = join(homedir(), ".pi", "remote", "direct.json");
    writeFileSync(file, JSON.stringify({ pid: 2147483646, port: state!.port, url }, null, 2));

    expect(await readDirectState()).toBeNull();
  });
});

describe("resolveWebDist via REMOTE_PI_WEB_DIST", () => {
  /*
   * A build that exists ONLY in the override location. Using the real
   * `clients/web/dist` would let the test pass through the default candidates, so
   * removing the override branch would not turn it red — a hollow test.
   */
  const FAKE_DIST = join(tmpdir(), `pi-fake-web-dist-${process.pid}`);

  beforeAll(() => {
    mkdirSync(FAKE_DIST, { recursive: true });
    writeFileSync(join(FAKE_DIST, "index.html"), '<!doctype html><div id="root">OVERRIDE-ONLY</div>');
  });

  afterAll(() => {
    rmSync(FAKE_DIST, { recursive: true, force: true });
  });

  afterEach(async () => {
    delete process.env["REMOTE_PI_WEB_DIST"];
    await stopDirectRelay();
  });

  test("serves the override directory when it holds index.html", async () => {
    process.env["REMOTE_PI_WEB_DIST"] = FAKE_DIST;
    const url = await ensureDirectRelay({ port: 0 });

    const index = await fetch(url + "/");
    expect(index.status).toBe(200);
    /* The marker proves the OVERRIDE was used, not a default candidate. */
    expect(await index.text()).toContain("OVERRIDE-ONLY");
  });

  test("ignores an override that has no index.html instead of failing", async () => {
    // A stale env var must not brick an otherwise working install.
    process.env["REMOTE_PI_WEB_DIST"] = join(tmpdir(), "definitely-not-a-web-build");
    const url = await ensureDirectRelay({ port: 0 });
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    /* Falls back to the in-repo build, so the real app must still be served. */
    const index = await fetch(url + "/");
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('<div id="root"');
  });
});
