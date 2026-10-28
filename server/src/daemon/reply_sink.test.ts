/**
 * Regression lock for the phase-two reply sink (plan/76).
 *
 * The sink exists so browser replies can skip the relay. The bug this file guards
 * against shipped once and was invisible to the whole suite: `_reply` returned as
 * soon as a sink was configured, so every peer the sink did NOT own — desktop,
 * mobile, CLI, i.e. any raw WebSocket client — had its replies silently dropped.
 *
 * The load-bearing assertion is therefore not "the sink is called" but "a sink that
 * declines does not swallow the frame".
 */
import { describe, expect, test, vi } from "vitest";
import { HostBridge, type ReplySink } from "./host_bridge.js";

/** A bridge with no relay: `_reply` must reach the sink without one. */
function bridgeWith(sink: ReplySink | undefined) {
  /* `fleet` is unused by the reply path; a stub keeps the test focused. */
  const fleet = {} as never;
  return new HostBridge({ fleet, replySink: sink });
}

describe("ReplySink", () => {
  test("a declining sink does NOT swallow the reply", () => {
    /*
     * This is the blocker. A WebSocket client is not an SSE stream, so the sink
     * answers `false`; `_reply` must then fall through to the relay instead of
     * returning. Asserting only "deliver was called" would have passed on the
     * broken implementation.
     */
    const deliver = vi.fn().mockReturnValue(false);
    const bridge = bridgeWith({ deliver });

    const sent: string[] = [];
    /* Reach into the private seam on purpose: the relay is otherwise built inside
     * `start()`, and this test is about `_reply`, not about connecting. */
    (bridge as unknown as { relay: { send: (line: string) => void } }).relay = {
      send: (line: string) => sent.push(line),
    };

    (bridge as unknown as { _reply: (peer: string, msg: unknown) => void })._reply("peer-a", {
      type: "workspace_list_ok",
    });

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!).peer).toBe("peer-a");
  });

  test("a sink that accepts the frame replaces the relay hop", () => {
    /* The whole point of phase two: an SSE peer must not touch the relay. */
    const deliver = vi.fn().mockReturnValue(true);
    const bridge = bridgeWith({ deliver });

    const sent: string[] = [];
    (bridge as unknown as { relay: { send: (line: string) => void } }).relay = {
      send: (line: string) => sent.push(line),
    };

    (bridge as unknown as { _reply: (peer: string, msg: unknown) => void })._reply("peer-b", {
      type: "workspace_list_ok",
    });

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(0);
  });

  test("a throwing sink falls back to the relay instead of dropping the frame", () => {
    const deliver = vi.fn(() => {
      throw new Error("stream gone");
    });
    const bridge = bridgeWith({ deliver });

    const sent: string[] = [];
    (bridge as unknown as { relay: { send: (line: string) => void } }).relay = {
      send: (line: string) => sent.push(line),
    };

    expect(() =>
      (bridge as unknown as { _reply: (peer: string, msg: unknown) => void })._reply("peer-c", {
        type: "workspace_list_ok",
      }),
    ).not.toThrow();
    expect(sent).toHaveLength(1);
  });

  test("no sink at all keeps the pre-existing relay behaviour", () => {
    const bridge = bridgeWith(undefined);
    const sent: string[] = [];
    (bridge as unknown as { relay: { send: (line: string) => void } }).relay = {
      send: (line: string) => sent.push(line),
    };

    (bridge as unknown as { _reply: (peer: string, msg: unknown) => void })._reply("peer-d", {
      type: "workspace_list_ok",
    });

    expect(sent).toHaveLength(1);
  });
});
