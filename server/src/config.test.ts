import { beforeEach, afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isValidRelayUrl,
  isWebSocketScheme,
  toWebSocketUrl,
  toHttpUrl,
  kDefaultRelayUrl,
  detectLanAddress,
  resolveAllowedHosts,
  resolvePublicRelayUrl,
  resolveRelayUrl,
  saveConfig,
} from "./config.js";

describe("isValidRelayUrl (strict http(s):// only)", () => {
  test("accepts http://", () => {
    expect(isValidRelayUrl("http://foo.test")).toBe(true);
    expect(isValidRelayUrl("http://foo.test:3000")).toBe(true);
    expect(isValidRelayUrl("http://192.168.1.10:3000")).toBe(true);
  });

  test("accepts https://", () => {
    expect(isValidRelayUrl("https://relay.example.tld")).toBe(true);
    expect(isValidRelayUrl("https://relay.880160.xyz")).toBe(true);
  });

  test("rejects ws:// (user must use http:// + auto-convert)", () => {
    expect(isValidRelayUrl("ws://foo.test")).toBe(false);
    expect(isValidRelayUrl("ws://192.168.1.10:3000")).toBe(false);
  });

  test("rejects wss:// (user must use https:// + auto-convert)", () => {
    expect(isValidRelayUrl("wss://relay.example.tld")).toBe(false);
  });

  test("rejects empty / non-URL / non-http scheme", () => {
    expect(isValidRelayUrl("")).toBe(false);
    expect(isValidRelayUrl("not a url")).toBe(false);
    expect(isValidRelayUrl("ftp://example.tld")).toBe(false);
    expect(isValidRelayUrl("file:///etc/passwd")).toBe(false);
  });
});

describe("isWebSocketScheme", () => {
  test("true for ws:// and wss://", () => {
    expect(isWebSocketScheme("ws://foo")).toBe(true);
    expect(isWebSocketScheme("wss://foo")).toBe(true);
    expect(isWebSocketScheme("WSS://Foo")).toBe(true); // case-insensitive
  });

  test("false for http://, https://, and others", () => {
    expect(isWebSocketScheme("http://foo")).toBe(false);
    expect(isWebSocketScheme("https://foo")).toBe(false);
    expect(isWebSocketScheme("ftp://foo")).toBe(false);
    expect(isWebSocketScheme("")).toBe(false);
  });
});

describe("toWebSocketUrl (http(s):// → ws(s)://)", () => {
  test("https:// → wss://", () => {
    expect(toWebSocketUrl("https://relay.example.tld")).toBe("wss://relay.example.tld");
    expect(toWebSocketUrl("https://foo:3000/path")).toBe("wss://foo:3000/path");
  });

  test("http:// → ws://", () => {
    expect(toWebSocketUrl("http://relay.example.tld")).toBe("ws://relay.example.tld");
    expect(toWebSocketUrl("http://192.168.1.10:3000")).toBe("ws://192.168.1.10:3000");
  });

  test("ws(s):// pass through (defensive — env override may bypass validation)", () => {
    expect(toWebSocketUrl("ws://foo")).toBe("ws://foo");
    expect(toWebSocketUrl("wss://foo")).toBe("wss://foo");
  });

  test("case-insensitive scheme match", () => {
    expect(toWebSocketUrl("HTTPS://Foo")).toBe("wss://Foo");
    expect(toWebSocketUrl("HTTP://Foo")).toBe("ws://Foo");
  });
});

describe("toHttpUrl (ws(s):// → http(s)://)", () => {
  test("wss:// → https://", () => {
    expect(toHttpUrl("wss://relay.example.tld")).toBe("https://relay.example.tld");
  });

  test("ws:// → http://", () => {
    expect(toHttpUrl("ws://192.168.1.10:3000")).toBe("http://192.168.1.10:3000");
  });

  test("http(s):// pass through", () => {
    expect(toHttpUrl("https://foo")).toBe("https://foo");
    expect(toHttpUrl("http://foo:3000")).toBe("http://foo:3000");
  });
});

describe("kDefaultRelayUrl", () => {
  test("is canonical https:// form (no scheme conversion needed at resolve time)", () => {
    expect(kDefaultRelayUrl).toMatch(/^https:\/\//);
    expect(kDefaultRelayUrl).toBe("https://relay.880160.xyz");
  });
});

describe("resolvePublicRelayUrl", () => {
  /*
   * The bug this covers: behind a tunnel the address the HOST dials and the
   * address a PHONE must dial are different. Pairing codes were built from
   * `resolveRelayUrl()`, so a tunnelled host emitted its loopback address and
   * every remote phone dialled its own localhost. `--direct` made it
   * unavoidable, because it fills `REMOTE_PI_RELAY` with that same loopback.
   */
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["REMOTE_PI_PUBLIC_RELAY", "REMOTE_PI_RELAY", "REMOTE_PI_HOME", "REMOTE_PI_ADVERTISE"];
  let home = "";

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    home = mkdtempSync(join(tmpdir(), "pi-cfg-"));
    process.env["REMOTE_PI_HOME"] = home;
    delete process.env["REMOTE_PI_PUBLIC_RELAY"];
    delete process.env["REMOTE_PI_RELAY"];
    delete process.env["REMOTE_PI_ADVERTISE"];
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(home, { recursive: true, force: true });
  });

  /*
   * The default is now "whatever address this machine has on the network",
   * because that is what a phone on the same Wi-Fi dials. `REMOTE_PI_ADVERTISE`
   * pins it here so the assertion does not depend on the test host's NICs.
   */
  test("advertises this machine's own network address by default", () => {
    process.env["REMOTE_PI_RELAY"] = "http://127.0.0.1:4125";
    process.env["REMOTE_PI_ADVERTISE"] = "192.0.2.10";

    expect(resolvePublicRelayUrl()).toEqual({ url: "http://192.0.2.10:4124", source: "lan" });
    /* The host keeps dialling loopback — only the CODE changes. */
    expect(resolveRelayUrl().url).toBe("http://127.0.0.1:4125");
  });

  test("falls back to the host address when there is no network address", () => {
    process.env["REMOTE_PI_RELAY"] = "http://127.0.0.1:4125";
    /* Force the detector to find nothing. */
    const probe = detectLanAddress();
    if (probe === null) {
      expect(resolvePublicRelayUrl()).toEqual({ url: "http://127.0.0.1:4125", source: "env" });
    } else {
      /* A machine without a LAN cannot really be tested on a machine WITH one. */
      expect(resolvePublicRelayUrl().source).toBe("lan");
    }
  });

  test("env wins over config and leaves the host address alone", () => {
    saveConfig({ publicRelay: "https://from-config.example" });
    process.env["REMOTE_PI_RELAY"] = "http://127.0.0.1:4125";
    process.env["REMOTE_PI_PUBLIC_RELAY"] = "https://from-env.example";

    expect(resolvePublicRelayUrl().url).toBe("https://from-env.example");
    /* The host must keep dialling its own address — that is the whole point. */
    expect(resolveRelayUrl().url).toBe("http://127.0.0.1:4125");
  });

  test("config is used when the env var is absent", () => {
    saveConfig({ publicRelay: "https://from-config.example" });
    process.env["REMOTE_PI_RELAY"] = "http://127.0.0.1:4125";
    expect(resolvePublicRelayUrl()).toEqual({ url: "https://from-config.example", source: "config" });
  });

  test("ws:// in the public setting is coerced to http://", () => {
    process.env["REMOTE_PI_PUBLIC_RELAY"] = "ws://pi.example.com";
    expect(resolvePublicRelayUrl().url).toBe("http://pi.example.com");
  });
});

describe("resolveAllowedHosts", () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["REMOTE_PI_ALLOWED_HOSTS", "REMOTE_PI_HOME"];
  let home = "";

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    home = mkdtempSync(join(tmpdir(), "pi-cfg-"));
    process.env["REMOTE_PI_HOME"] = home;
    delete process.env["REMOTE_PI_ALLOWED_HOSTS"];
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(home, { recursive: true, force: true });
  });

  test("empty by default — loopback and IP literals need no entry", () => {
    expect(resolveAllowedHosts()).toEqual([]);
  });

  test("env list is split, trimmed and lowercased", () => {
    process.env["REMOTE_PI_ALLOWED_HOSTS"] = " Pi.Example.com , other.example ";
    expect(resolveAllowedHosts()).toEqual(["pi.example.com", "other.example"]);
  });

  test("config supplies the list when the env var is unset", () => {
    saveConfig({ allowedHosts: ["Pi.Example.com"] });
    expect(resolveAllowedHosts()).toEqual(["pi.example.com"]);
  });
});
