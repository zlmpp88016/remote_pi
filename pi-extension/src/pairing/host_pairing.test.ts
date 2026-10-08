import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostPairingSession, pairingPathForTest } from "./host_pairing.js";
import { TOKEN_TTL_MS } from "./qr.js";

/**
 * Plan/69 W1 — the daemon-side pairing token store.
 *
 * Persistent (default) codes live in `~/.pi/remote/pairing.json` and survive
 * a supervisor reboot; `--rotate` is the only thing that invalidates them.
 * `--ephemeral` codes reuse the QRSession semantics: short TTL, single-use.
 */

let testHome: string;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "pi-hostpair-"));
  process.env["REMOTE_PI_HOME"] = testHome;
});

afterEach(() => {
  delete process.env["REMOTE_PI_HOME"];
  try { rmSync(testHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** Real-timer sleep — used instead of fake timers so the async fs writes in
 *  issue/consume are never interleaved with a faked clock. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("HostPairingSession — persistent token (plan/69)", () => {
  test("issue persists to ~/.pi/remote/pairing.json and survives a reboot", async () => {
    const s = new HostPairingSession();
    const rec = await s.issue();
    expect(rec.persistent).toBe(true);
    expect(rec.expires_at).toBeNull();
    expect(rec.consumed).toBe(false);

    const path = pairingPathForTest();
    expect(path).toBe(join(testHome, ".pi", "remote", "pairing.json"));
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as { token: string };
    expect(onDisk.token).toBe(rec.token);

    // A fresh instance = a restarted supervisor: same code, still valid.
    const rebooted = new HostPairingSession();
    const shown = await rebooted.show();
    expect(shown?.token).toBe(rec.token);
    expect(await rebooted.consume(rec.token)).toBe("ok");
    // Persistent codes pair any number of devices — only --rotate kills them.
    expect(await rebooted.consume(rec.token)).toBe("ok");
  });

  test("show() never issues: null before the first issue()", async () => {
    const s = new HostPairingSession();
    expect(await s.show()).toBeNull();
    expect(existsSync(pairingPathForTest())).toBe(false);
    const rec = await s.issue();
    expect((await s.show())?.token).toBe(rec.token);
  });

  test("rotate (a second issue) invalidates the previous token", async () => {
    const s = new HostPairingSession();
    const first = await s.issue();
    const second = await s.issue();
    expect(second.token).not.toBe(first.token);
    expect(await s.consume(first.token)).toBe("unknown");
    expect(await s.consume(second.token)).toBe("ok");
  });

  test("a token issued by another host is unknown", async () => {
    const s = new HostPairingSession();
    await s.issue();
    expect(await s.consume("not-our-token")).toBe("unknown");
  });

  test("a corrupt pairing.json fails closed (no active code)", async () => {
    const s = new HostPairingSession();
    await s.issue();
    writeFileSync(pairingPathForTest(), "{not json", "utf8");
    expect(await s.show()).toBeNull();
    expect(await s.consume("whatever")).toBe("unknown");
  });
});

describe("HostPairingSession — ephemeral token (plan/69)", () => {
  test("expires after its ttl", async () => {
    const s = new HostPairingSession();
    const { token } = await s.issue({ ephemeral: true, ttlMs: 1 });
    await sleep(25);
    expect(await s.consume(token)).toBe("expired");
  });

  test("single-use, and the consumption is persisted", async () => {
    const s = new HostPairingSession();
    const { token } = await s.issue({ ephemeral: true, ttlMs: TOKEN_TTL_MS });
    expect(await s.consume(token)).toBe("ok");
    expect(await s.consume(token)).toBe("consumed");
    const onDisk = JSON.parse(readFileSync(pairingPathForTest(), "utf8")) as { consumed: boolean };
    expect(onDisk.consumed).toBe(true);
    // Even a restarted supervisor must not resurrect a consumed code.
    const rebooted = new HostPairingSession();
    expect(await rebooted.consume(token)).toBe("consumed");
  });

  test("default ephemeral ttl reuses the QR rotation period (TOKEN_TTL_MS)", async () => {
    const before = Date.now();
    const s = new HostPairingSession();
    const rec = await s.issue({ ephemeral: true });
    expect(rec.persistent).toBe(false);
    expect(rec.expires_at).toBeGreaterThanOrEqual(before + TOKEN_TTL_MS);
    expect(rec.expires_at).toBeLessThanOrEqual(Date.now() + TOKEN_TTL_MS);
  });

  test("concurrent consume/issue calls are serialized on the file", async () => {
    const s = new HostPairingSession();
    const { token } = await s.issue({ ephemeral: true, ttlMs: TOKEN_TTL_MS });
    const [a, b] = await Promise.all([s.consume(token), s.consume(token)]);
    expect([a, b].filter((r) => r === "ok")).toHaveLength(1);
    expect([a, b].filter((r) => r === "consumed")).toHaveLength(1);
  });
});
