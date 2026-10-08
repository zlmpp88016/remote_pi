/**
 * Plan/69 W2 — host-first child wiring (daemon mode).
 *
 * A supervisor-spawned daemon child (REMOTE_PI_DAEMON=1) speaks the proxied
 * path: inbound envelopes addressed to the machine's OWN Pi-key are
 * host-proxied traffic (the supervisor's HostBridge re-emitted them), and
 * every reply is addressed `{peer: <own epk>, room: "host"}` so the bridge
 * wraps it as `host_message` for the apps.
 *
 * The legacy DIRECT path (a peer paired straight at this Pi) stays
 * byte-identical, and a non-daemon TUI Pi never sees the own-key path at
 * all. Wire semantics validated against the real relay in
 * scripts/spike-room-multiplex.mjs (the relay rewrites each delivered
 * envelope with the sender's peer+room).
 */
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// ── Mock RelayClient ──────────────────────────────────────────────────────────

const relayRef: { current: MockRelay | null } = { current: null };

class MockRelay extends EventEmitter {
  static OPEN = 1;
  readyState = MockRelay.OPEN;
  connect     = vi.fn();
  send        = vi.fn();
  sendControl = vi.fn();
  close       = vi.fn();
  constructor() { super(); relayRef.current = this; }
}

// ── Mock storage ──────────────────────────────────────────────────────────────

/** 32 zero bytes → stable base64 identity across the test process. */
const OWN_PUBKEY = Buffer.from(new Uint8Array(32)).toString("base64");

vi.mock("../src/pairing/storage.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/pairing/storage.js")>();
  return {
    ...orig,
    getOrCreateEd25519Keypair: vi.fn().mockResolvedValue({
      publicKey: new Uint8Array(32),
      secretKey: new Uint8Array(32),
    }),
    listPeers: vi.fn().mockResolvedValue([]),
    snapshotOwnerPubkeys: vi.fn().mockRejectedValue(
      new Error("strict Owner snapshot unavailable"),
    ),
    addPeer: vi.fn(),
    removePeer: vi.fn(),
  };
});

// ── Mock config ───────────────────────────────────────────────────────────────

vi.mock("../src/config.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/config.js")>();
  return {
    ...orig,
    loadConfig: vi.fn().mockReturnValue({}),
    saveConfig: vi.fn(),
    resolveRelayUrl: vi.fn().mockReturnValue({
      url: "ws://localhost:3000",
      source: "default" as const,
    }),
  };
});

// ── Mock qr ───────────────────────────────────────────────────────────────────

vi.mock("../src/pairing/qr.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/pairing/qr.js")>();
  return {
    ...orig,
    displayQR: vi.fn(),
    qrSession: {
      issueToken: vi.fn().mockReturnValue({ token: "test-token", expiresAt: Date.now() + 60_000 }),
      consumeToken: vi.fn().mockReturnValue("ok"),
      clear: vi.fn(),
      generateToken: vi.fn().mockReturnValue("test-token"),
    },
  };
});

vi.mock("../src/transport/relay_client.js", () => ({
  RelayClient: MockRelay,
}));

// ── Import the extension after mocks ──────────────────────────────────────────

const {
  default: extension,
  _getState,
  _startRelayForTest,
  _stopForTest,
} = await import("../src/index.js");

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockCtx() {
  return { ui: { notify: vi.fn() }, cwd: "/tmp/test", abort: vi.fn() };
}

function makeMockPi() {
  return {
    on: () => undefined,
    registerCommand: () => undefined,
    registerTool: () => undefined,
    registerShortcut: () => undefined,
    registerFlag: () => undefined,
    getFlag: () => undefined,
    registerMessageRenderer: () => undefined,
    sendMessage: () => undefined,
    sendUserMessage: () => undefined,
  } as unknown as ExtensionAPI;
}

/** Outer envelope line as the relay delivers it (rewritten with the sender). */
function outerLine(peer: string, inner: object, room?: string): string {
  const ct = Buffer.from(JSON.stringify(inner)).toString("base64");
  return JSON.stringify(room === undefined ? { peer, ct } : { peer, room, ct });
}

interface DecodedFrame {
  peer: string;
  room?: string;
  inner: Record<string, unknown>;
}

function decodeSent(raw: string): DecodedFrame {
  const outer = JSON.parse(raw) as { peer: string; room?: string; ct: string };
  const inner = JSON.parse(Buffer.from(outer.ct, "base64").toString("utf8"));
  return { peer: outer.peer, room: outer.room, inner };
}

function sentFrames(): DecodedFrame[] {
  return relayRef.current!.send.mock.calls.map((c: unknown[]) => decodeSent(c[0] as string));
}

function sentPongs(): DecodedFrame[] {
  return sentFrames().filter((f) => f.inner["type"] === "pong");
}

async function bootRelay(): Promise<void> {
  (extension as ExtensionFactory)(makeMockPi());
  await _startRelayForTest(makeMockCtx());
  expect(_getState()).toBe("started");
}

/** Legacy direct pairing at THIS Pi (pre-69 flow — unchanged). */
async function pairDirectPeer(): Promise<void> {
  relayRef.current!.emit("message", outerLine("app-peer-001", {
    type: "pair_request",
    id: "pair-req-1",
    token: "test-token",
    device_name: "Test Phone",
  }));
  await vi.waitFor(() => expect(sentFrames().some((f) => f.inner["type"] === "pair_ok")).toBe(true));
}

beforeEach(async () => {
  vi.clearAllMocks();
  relayRef.current = null;
  delete process.env["REMOTE_PI_DAEMON"];
  await _stopForTest(makeMockCtx());
});

afterEach(async () => {
  delete process.env["REMOTE_PI_DAEMON"];
  await _stopForTest(makeMockCtx());
});

describe("plan/69 — daemon child host-first addressing", () => {
  test("own-key (host-proxied) ping → pong addressed {peer: own epk, room: host}", async () => {
    process.env["REMOTE_PI_DAEMON"] = "1";
    await bootRelay();

    relayRef.current!.emit("message", outerLine(OWN_PUBKEY, { type: "ping", id: "px-1" }, "host"));
    await vi.waitFor(() => expect(sentPongs()).toHaveLength(1));

    const pong = sentPongs()[0]!;
    expect(pong.peer).toBe(OWN_PUBKEY);
    expect(pong.room).toBe("host");
    expect(pong.inner).toEqual({ type: "pong", in_reply_to: "px-1" });
  });

  test("legacy direct path stays byte-identical in daemon mode (no room on the wire)", async () => {
    process.env["REMOTE_PI_DAEMON"] = "1";
    await bootRelay();
    await pairDirectPeer();

    const before = relayRef.current!.send.mock.calls.length;
    relayRef.current!.emit("message", outerLine("app-peer-001", { type: "ping", id: "pd-1" }));
    await vi.waitFor(() => expect(sentPongs()).toHaveLength(1));

    const pong = sentPongs()[0]!;
    expect(pong.peer).toBe("app-peer-001");
    expect(pong.room).toBeUndefined(); // legacy direct outer envelope — unchanged
    expect(pong.inner).toEqual({ type: "pong", in_reply_to: "pd-1" });
    expect(before).toBeGreaterThan(0); // pair_ok was sent on the direct wire too
  });

  test("BOTH inbound paths coexist on a daemon child", async () => {
    process.env["REMOTE_PI_DAEMON"] = "1";
    await bootRelay();
    await pairDirectPeer();

    // 1) host-proxied (own-key) traffic…
    relayRef.current!.emit("message", outerLine(OWN_PUBKEY, { type: "ping", id: "px-2" }, "host"));
    await vi.waitFor(() => expect(sentPongs()).toHaveLength(1));

    // 2) …and the direct legacy peer on the same connection.
    relayRef.current!.emit("message", outerLine("app-peer-001", { type: "ping", id: "pd-2" }));
    await vi.waitFor(() => expect(sentPongs()).toHaveLength(2));

    const pongs = sentPongs();
    expect(pongs[0]).toMatchObject({ peer: OWN_PUBKEY, room: "host", inner: { in_reply_to: "px-2" } });
    expect(pongs[1]).toMatchObject({ peer: "app-peer-001", inner: { in_reply_to: "pd-2" } });
    expect(pongs[1]!.room).toBeUndefined();
  });

  test("unknown peer gets no pong even in daemon mode (allow-list untouched)", async () => {
    process.env["REMOTE_PI_DAEMON"] = "1";
    await bootRelay();

    relayRef.current!.emit("message", outerLine("stranger", { type: "ping", id: "ps-1" }, "host"));
    await new Promise((r) => setTimeout(r, 50));
    expect(sentPongs()).toHaveLength(0);
  });
});

describe("plan/69 — TUI (non-daemon) path untouched", () => {
  test("no REMOTE_PI_DAEMON → own-key envelopes produce no proxied pong; direct path works", async () => {
    await bootRelay(); // env NOT set — interactive/TUI mode
    await pairDirectPeer();

    // Own-key envelope: no proxy channel exists, so nothing routes it as
    // host-proxied traffic (the pre-existing unknown-peer handling applies).
    relayRef.current!.emit("message", outerLine(OWN_PUBKEY, { type: "ping", id: "pt-own" }, "host"));
    await new Promise((r) => setTimeout(r, 50));
    expect(sentPongs()).toHaveLength(0);

    // The direct path is fully intact.
    relayRef.current!.emit("message", outerLine("app-peer-001", { type: "ping", id: "pt-direct" }));
    await vi.waitFor(() => expect(sentPongs()).toHaveLength(1));
    expect(sentPongs()[0]).toMatchObject({ peer: "app-peer-001", inner: { in_reply_to: "pt-direct" } });
    expect(sentPongs()[0]!.room).toBeUndefined();
  });
});
