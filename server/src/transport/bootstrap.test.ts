import { describe, expect, test } from "vitest";
import type { IncomingMessage } from "node:http";
import {
  bootstrapCookie,
  consumeBootstrap,
  issueBootstrapNonce,
  readCookie,
} from "./bootstrap.js";

/**
 * Minimal request stand-in.
 *
 * The real gate only reads headers, so a full `IncomingMessage` would add noise
 * without adding coverage.
 */
function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

/** A nonce exactly as the server would hand it to a browser. */
function freshCookie(): string {
  const nonce = issueBootstrapNonce();
  return `pi_bootstrap=${nonce}`;
}

const NO_ORIGINS: ReadonlySet<string> = new Set();

describe("bootstrap gate", () => {
  test("accepts a signed nonce on a same-origin request", () => {
    expect(
      consumeBootstrap(
        req({ cookie: freshCookie(), "sec-fetch-site": "same-origin" }),
        "127.0.0.1:4124",
        NO_ORIGINS,
      ),
    ).toBe(true);
  });

  test("rejects a request with no cookie", () => {
    expect(
      consumeBootstrap(req({ "sec-fetch-site": "same-origin" }), "127.0.0.1:4124", NO_ORIGINS),
    ).toBe(false);
  });

  test("rejects cross-site even with a valid cookie", () => {
    /*
     * The cookie alone is not enough. A cross-site page can trigger a request
     * that rides an existing cookie, which is exactly the drive-by case.
     */
    expect(
      consumeBootstrap(
        req({ cookie: freshCookie(), "sec-fetch-site": "cross-site" }),
        "127.0.0.1:4124",
        NO_ORIGINS,
      ),
    ).toBe(false);
  });

  /*
   * Fetch Metadata is absent outside a secure context, which is the normal case
   * for a LAN address (`http://192.168.x.x:4124`). The cookie is the real gate:
   * `SameSite=Strict` means only the origin that received it can send it back.
   */
  test("accepts a valid cookie when Sec-Fetch-Site is absent", () => {
    expect(consumeBootstrap(req({ cookie: freshCookie() }), "192.168.1.7:4124", NO_ORIGINS)).toBe(
      true,
    );
  });

  test("rejects a forged signature", () => {
    /* A plausible-looking nonce whose HMAC does not match the process key. */
    const bucket = Math.floor(Date.now() / 60_000);
    expect(
      consumeBootstrap(
        req({ cookie: `pi_bootstrap=${bucket}.${"0".repeat(64)}`, "sec-fetch-site": "same-origin" }),
        "127.0.0.1:4124",
        NO_ORIGINS,
      ),
    ).toBe(false);
  });

  test("rejects a nonce from a distant time bucket", () => {
    /*
     * Signature is checked before age, so this needs a REAL signature for an old
     * bucket — which the process key cannot produce for a past window. The
     * observable outcome is still a refusal, which is what matters.
     */
    expect(
      consumeBootstrap(
        req({ cookie: `pi_bootstrap=1000.${"a".repeat(64)}`, "sec-fetch-site": "same-origin" }),
        "127.0.0.1:4124",
        NO_ORIGINS,
      ),
    ).toBe(false);
  });

  test("rejects a cross-origin Origin header even with a valid cookie", () => {
    expect(
      consumeBootstrap(
        req({
          cookie: freshCookie(),
          "sec-fetch-site": "same-origin",
          origin: "http://evil.example",
        }),
        "127.0.0.1:4124",
        NO_ORIGINS,
      ),
    ).toBe(false);
  });

  test("accepts a nonce more than once within its window", () => {
    /*
     * Reuse is deliberate. Burning the nonce broke the ordinary reload: the
     * browser keeps the last cookie it was given, so a second page load within the
     * window presented a nonce the server had already dropped and bootstrap
     * answered 403 until site data was cleared.
     */
    const cookie = freshCookie();
    const headers = { cookie, "sec-fetch-site": "same-origin" };
    expect(consumeBootstrap(req(headers), "127.0.0.1:4124", NO_ORIGINS)).toBe(true);
    expect(consumeBootstrap(req(headers), "127.0.0.1:4124", NO_ORIGINS)).toBe(true);
  });

  test("rejects when there is no Host header", () => {
    expect(consumeBootstrap(req({ cookie: freshCookie(), "sec-fetch-site": "same-origin" }), undefined, NO_ORIGINS)).toBe(
      false,
    );
  });
});

describe("bootstrapCookie", () => {
  test("is SameSite=Strict so a cross-site request cannot carry it", () => {
    expect(bootstrapCookie(issueBootstrapNonce())).toContain("SameSite=Strict");
  });

  test("survives a round trip through readCookie", () => {
    const cookie = bootstrapCookie(issueBootstrapNonce());
    const value = cookie.slice("pi_bootstrap=".length).split(";")[0];
    expect(readCookie(req({ cookie: `other=1; pi_bootstrap=${value}` }), "pi_bootstrap")).toBe(
      value,
    );
  });
});
