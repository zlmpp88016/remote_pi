import { describe, expect, test } from "vitest";

import { projectSettings, SETTINGS_WHITELIST } from "./settings_config.js";

/**
 * The load-bearing property is what this module REFUSES to project.
 *
 * The real `settings.json` on a developer machine contains `packages` with absolute
 * host paths in it. A projection that forwarded the document would leak the user's
 * directory layout through a preferences panel — the same class of leak `fs_read`'s
 * allowlist prevents. These assertions are written against the serialised payload,
 * i.e. the exact bytes that would go on the wire.
 */
describe("projectSettings", () => {
  const real = {
    lastChangelogVersion: "1.4.0",
    theme: "cockpit-ocean",
    packages: [
      "npm:pi-maestro-flow@0.30.0",
      "C:\\Users\\somebody\\.pi\\agent\\npm\\node_modules\\pi-cockpit",
      "D:\\workspace\\git_repo\\pi-extensions\\pi-model-log",
    ],
    retry: { enabled: true, maxRetries: 10, baseDelayMs: 2000, provider: { maxRetryDelayMs: 16000 } },
    hideThinkingBlock: true,
    extensions: ["-builtin:mcp"],
  };

  test("no host path appears in the projected payload", () => {
    const wire = JSON.stringify(projectSettings(real));
    expect(wire).not.toContain("C:");
    expect(wire).not.toContain("D:");
    expect(wire).not.toContain("Users");
    expect(wire).not.toContain("git_repo");
  });

  test("packages, extensions and lastChangelogVersion are not projected", () => {
    const wire = JSON.stringify(projectSettings(real));
    expect(wire).not.toContain("packages");
    expect(wire).not.toContain("extensions");
    expect(wire).not.toContain("lastChangelogVersion");
    expect(wire).not.toContain("1.4.0");
    expect(wire).not.toContain("pi-maestro-flow");
  });

  test("the whitelisted values DO come through", () => {
    const p = projectSettings(real);
    expect(p.appearance.theme).toBe("cockpit-ocean");
    expect(p.appearance.hide_thinking_block).toBe(true);
    expect(p.behaviour.retry_enabled).toBe(true);
    expect(p.behaviour.retry_max_retries).toBe(10);
    expect(p.behaviour.retry_base_delay_ms).toBe(2000);
    expect(p.behaviour.retry_provider_max_retry_delay_ms).toBe(16000);
  });

  test("a missing or wrong-typed leaf becomes null rather than a guess", () => {
    const p = projectSettings({ theme: 42, retry: { maxRetries: "ten" } });
    expect(p.appearance.theme).toBeNull();
    expect(p.behaviour.retry_max_retries).toBeNull();
    expect(p.behaviour.retry_enabled).toBeNull();
  });

  test("a wholly empty document projects to nulls, not to an error", () => {
    const p = projectSettings({});
    expect(p.appearance).toEqual({ theme: null, hide_thinking_block: null });
    expect(p.behaviour).toEqual({
      retry_enabled: null,
      retry_max_retries: null,
      retry_base_delay_ms: null,
      retry_provider_max_retry_delay_ms: null,
    });
  });

  test("the whitelist contains no wildcard or whole-subtree entry", () => {
    /* A prefix like `retry` would let an op replace the entire subtree, silently
     * dropping `provider`. Only exact leaves are addressable. */
    for (const entry of SETTINGS_WHITELIST) {
      expect(entry).not.toMatch(/\*/);
      expect(entry.split(".").length).toBeGreaterThanOrEqual(1);
    }
    expect(SETTINGS_WHITELIST).not.toContain("retry");
    expect(SETTINGS_WHITELIST).not.toContain("packages");
    expect(SETTINGS_WHITELIST).not.toContain("extensions");
    expect(SETTINGS_WHITELIST).not.toContain("lastChangelogVersion");
  });

  test("unknown extra keys in the document are dropped", () => {
    const wire = JSON.stringify(projectSettings({ ...real, somethingNew: "secret-value", apiKey: "sk-x" }));
    expect(wire).not.toContain("somethingNew");
    expect(wire).not.toContain("secret-value");
    expect(wire).not.toContain("sk-x");
  });
});
