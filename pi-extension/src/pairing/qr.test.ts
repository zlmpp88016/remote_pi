import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  QRSession,
  buildQRUri,
  clampPairTtlMs,
  TOKEN_TTL_MS,
  PAIR_TTL_MIN_MS,
  PAIR_TTL_MAX_MS,
} from "./qr.js";

describe("clampPairTtlMs", () => {
  test("passes a value inside the range unchanged", () => {
    expect(clampPairTtlMs(120_000)).toBe(120_000);
  });
  test("clamps below the minimum", () => {
    expect(clampPairTtlMs(1_000)).toBe(PAIR_TTL_MIN_MS);
  });
  test("clamps above the maximum", () => {
    expect(clampPairTtlMs(9_999_999)).toBe(PAIR_TTL_MAX_MS);
  });
  test("non-finite (NaN / Infinity) falls back to the default", () => {
    expect(clampPairTtlMs(Number.NaN)).toBe(TOKEN_TTL_MS);
    expect(clampPairTtlMs(Number.POSITIVE_INFINITY)).toBe(TOKEN_TTL_MS);
  });
});

describe("QRSession.issueToken — ttl", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("default ttl when none given", () => {
    vi.setSystemTime(new Date(1_000_000));
    const { expiresAt } = new QRSession().issueToken();
    expect(expiresAt).toBe(1_000_000 + TOKEN_TTL_MS);
  });

  test("honors a caller-supplied ttl", () => {
    vi.setSystemTime(new Date(1_000_000));
    const { expiresAt } = new QRSession().issueToken(120_000);
    expect(expiresAt).toBe(1_000_000 + 120_000);
  });

  test("token expires after its ttl", () => {
    vi.setSystemTime(new Date(0));
    const s = new QRSession();
    const { token } = s.issueToken(10_000);
    vi.setSystemTime(new Date(10_001));
    expect(s.consumeToken(token)).toBe("expired");
  });

  test("token is single-use within its ttl", () => {
    vi.setSystemTime(new Date(0));
    const s = new QRSession();
    const { token } = s.issueToken(60_000);
    expect(s.consumeToken(token)).toBe("ok");
    expect(s.consumeToken(token)).toBe("consumed");
  });

  test("issuing a new token invalidates the previous one", () => {
    vi.setSystemTime(new Date(0));
    const s = new QRSession();
    const first = s.issueToken(60_000).token;
    s.issueToken(60_000);
    expect(s.consumeToken(first)).toBe("unknown");
  });
});

/**
 * Plan/69 W1 — frozen payload regression.
 *
 * The daemon-issued host code (`remote-pi pair`, rm=host) and the Pi-issued
 * code (`/remote-pi pair`) share ONE payload format — the app parses both
 * with the same paste step. Any edit to buildQRUri that changes the bytes
 * must fail here first.
 */
describe("buildQRUri — frozen payload (plan/69 W1)", () => {
  test("host-issued code keeps the byte-identical remotepi://pair payload", () => {
    const epk = new Uint8Array(32).fill(7);
    const uri = buildQRUri("tOkEn-42", epk, "My PC", "host", "https://relay.example.com");
    expect(uri).toBe(
      "remotepi://pair?t=tOkEn-42&epk=BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc" +
        "&n=My+PC&rm=host&r=https%3A%2F%2Frelay.example.com",
    );
  });

  test("omitting roomId/relayUrl omits rm/r (the older Pi-issued shape)", () => {
    const uri = buildQRUri("tok", new Uint8Array(32), "Pi");
    expect(uri).toBe(
      "remotepi://pair?t=tok&epk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&n=Pi",
    );
  });

  test("param order is stable: t, epk, n, then optional rm, r", () => {
    const uri = buildQRUri("t", new Uint8Array(32).fill(1), "n", "room-x", "http://r");
    expect(uri.indexOf("t=t")).toBeLessThan(uri.indexOf("epk="));
    expect(uri.indexOf("epk=")).toBeLessThan(uri.indexOf("&n="));
    expect(uri.indexOf("&n=")).toBeLessThan(uri.indexOf("&rm="));
    expect(uri.indexOf("&rm=")).toBeLessThan(uri.indexOf("&r="));
  });
});
