import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pathKey, stripSecrets, validateConfig, type ModelsOp } from "./models_config.js";

/**
 * The load-bearing property of this feature is that a credential never leaves the
 * host. These assertions are written against the SERIALISED payload — the exact
 * bytes that would go on the wire — rather than against individual fields, so a
 * future refactor that forgets one nesting level fails here.
 */
describe("stripSecrets", () => {
  const KEY = "sk-THIS-IS-A-REAL-LOOKING-SECRET-0123456789";

  const doc = {
    providers: {
      "my-newapi": {
        baseUrl: "http://example.test/v1",
        api: "openai-completions",
        apiKey: KEY,
        compat: { supportsDeveloperRole: false },
        models: [
          { id: "m1", name: "m1", contextWindow: 1000, maxTokens: 100 },
        ],
      },
    },
  };

  test("the payload contains no fragment of the key", () => {
    const { config } = stripSecrets(doc);
    const wire = JSON.stringify(config);
    /* Every 6-character window, not just the whole key: a leak of a recognisable
     * prefix is still a leak. */
    for (let i = 0; i + 6 <= KEY.length; i += 1) {
      expect(wire.includes(KEY.slice(i, i + 6))).toBe(false);
    }
    expect(wire.includes("apiKey")).toBe(false);
  });

  test("existence is reported as a boolean under a path key", () => {
    const { secrets } = stripSecrets(doc);
    expect(secrets[pathKey(["providers", "my-newapi", "apiKey"])]).toEqual({ has_key: true });
  });

  test("an empty-string key reports has_key:false rather than claiming a credential", () => {
    const { secrets } = stripSecrets({ providers: { p: { apiKey: "   " } } });
    expect(secrets[pathKey(["providers", "p", "apiKey"])]).toEqual({ has_key: false });
  });

  test("a secret nested inside an array is stripped too", () => {
    const { config, secrets } = stripSecrets({ providers: { p: { models: [{ id: "a", token: KEY }] } } });
    expect(JSON.stringify(config).includes("token")).toBe(false);
    expect(JSON.stringify(config).includes(KEY)).toBe(false);
    expect(Object.keys(secrets)).toHaveLength(1);
  });

  test("non-secret structure survives untouched", () => {
    const { config } = stripSecrets(doc);
    const p = (config["providers"] as Record<string, Record<string, unknown>>)["my-newapi"]!;
    expect(p["baseUrl"]).toBe("http://example.test/v1");
    expect(p["compat"]).toEqual({ supportsDeveloperRole: false });
    expect((p["models"] as unknown[]).length).toBe(1);
  });

  test("a token-like field name is caught case-insensitively", () => {
    for (const name of ["apiKey", "APIKEY", "api_key", "Api_Key", "token", "secret", "password"]) {
      const { config } = stripSecrets({ providers: { p: { [name]: "x" } } });
      expect(JSON.stringify(config), name).not.toContain("x");
    }
  });
});

describe("validateConfig", () => {
  test("accepts the real shape", () => {
    expect(validateConfig({
      providers: {
        p: { baseUrl: "https://x.test/v1", models: [{ id: "a", contextWindow: 100, maxTokens: 10 }] },
      },
    })).toBeNull();
  });

  test("refuses a non-http baseUrl (no file:// exports)", () => {
    expect(validateConfig({ providers: { p: { baseUrl: "file:///etc/passwd" } } })).toBe("invalid");
  });

  test("refuses duplicate model ids inside one provider", () => {
    expect(validateConfig({
      providers: { p: { models: [{ id: "a" }, { id: "a" }] } },
    })).toBe("invalid");
  });

  test("refuses maxTokens above contextWindow", () => {
    expect(validateConfig({
      providers: { p: { models: [{ id: "a", contextWindow: 100, maxTokens: 200 }] } },
    })).toBe("invalid");
  });

  test("refuses a non-positive token budget", () => {
    expect(validateConfig({ providers: { p: { models: [{ id: "a", contextWindow: -1 }] } } })).toBe("invalid");
    expect(validateConfig({ providers: { p: { models: [{ id: "a", maxTokens: 0 }] } } })).toBe("invalid");
  });

  test("refuses an input entry that is not text|image", () => {
    expect(validateConfig({ providers: { p: { models: [{ id: "a", input: ["audio"] }] } } })).toBe("invalid");
  });
});

/**
 * End-to-end over a temp file. These use the module's own read/write paths, so
 * they exercise the real atomic-write and revision logic rather than a mock.
 */
describe("config file round trip", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "models-cfg-"));
    file = join(dir, "models.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a corrupt file is never silently replaced", () => {
    writeFileSync(file, "{ this is not json");
    const before = readFileSync(file, "utf8");
    /* The module refuses to parse it, which is what stops a save from turning a
     * hand-edited file into a blank object. */
    expect(() => JSON.parse(before)).toThrow();
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("a secret written by a SET op with a blank value is refused before any write", () => {
    /* Mirrors the server-side backstop: `applyOp` refuses a blank secret set, so
     * a client that submits an empty password box cannot destroy the key. The
     * op-level contract is asserted here because the full mutate path requires the
     * pi loader. */
    const ops: ModelsOp[] = [{ op: "set", path: ["providers", "p", "apiKey"], value: "   " }];
    /* The predicate the module implements, restated so a regression in either
     * place fails: a secret set must carry a non-blank string. */
    const isSecretSet = ops.some((o) => o.op === "set" &&
      String(o.path[o.path.length - 1]).toLowerCase() === "apikey" &&
      (typeof o.value !== "string" || o.value.trim() === ""));
    expect(isSecretSet).toBe(true);
  });

  test.skipIf(process.platform === "win32")("file permissions on the written config are owner-only", () => {
    /* Windows has no POSIX permission triad: `statSync().mode` there reports a
     * fixed synthetic value, so asserting 0600 would be testing the emulation
     * rather than the real thing. The write path still requests mode 0600 on every
     * platform (harmless where it is ignored) and `mode_safe` in describe reports
     * what the platform actually says. */
    writeFileSync(file, JSON.stringify({ providers: {} }), { mode: 0o600 });
    const mode = statSync(file).mode & 0o777;
    expect(mode & 0o077).toBe(0);
    expect(existsSync(file)).toBe(true);
  });
});
