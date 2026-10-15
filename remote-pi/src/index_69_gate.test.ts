import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic home (same pattern as the daemon tests): identity/pairing writes
// must land in a temp dir, never the developer's real ~/.pi/remote.
const _tmpHome = mkdtempSync(join(tmpdir(), "pi-idx69-"));
vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return { ...orig, homedir: () => _tmpHome };
});

const idx = await import("./index.js");

/**
 * Plan/69 — regression for the host-first reply gate.
 *
 * Bug (reported live): in daemon mode the app pairs with the SUPERVISOR, so
 * the child Pi has NO entry in `_activePeers`. Every reply event
 * (agent_chunk / agent_done / tool_* / provider error) is gated by
 * `_anyPeerActive()`, which only counted direct owners — so the user typed,
 * saw their own echoed bubble (the echo has its own `_hostProxyChannel`
 * fallback), and then nothing. The transcript proved the agent replied; the
 * frame never reached the app.
 *
 * Fix: `_anyPeerActive()` also counts the host-proxy channel. This test pins
 * that predicate and, critically, that clearing the channel restores the
 * legacy behaviour (no accidental "always paired" in TUI/interactive mode).
 */
describe("plan/69 — host-first reply gate (_anyPeerActive)", () => {
  afterEach(() => {
    idx._setHostProxyChannelForTest(null);
  });

  test("daemon child: proxy channel alone counts as an owner (replies are broadcast)", () => {
    expect(idx._getActivePeerCountForTest()).toBe(0);
    idx._setHostProxyChannelForTest({ send: () => {}, detach: () => {} });
    expect(idx._hasHostProxyChannelForTest()).toBe(true);
    expect(idx._anyPeerActiveForTest()).toBe(true);
  });

  test("legacy direct mode: no proxy channel and no owners → not active", () => {
    idx._setHostProxyChannelForTest(null);
    expect(idx._getActivePeerCountForTest()).toBe(0);
    expect(idx._hasHostProxyChannelForTest()).toBe(false);
    expect(idx._anyPeerActiveForTest()).toBe(false);
  });
});
