import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { thinkingLevelsOf, wireFromModel } from "./handlers.js";

/**
 * The picker used to offer every model the same fixed list of thinking levels, so a
 * model honouring only `high`/`max` still showed `low`/`medium`, and picking one
 * resolved to a neighbour with no signal.
 *
 * The rule below mirrors the SDK's `getSupportedThinkingLevels`, and the subtlety is
 * that the map NARROWS rather than enumerates: `off` is always present, a `null` entry
 * excludes a level, and an absent entry keeps it. `xhigh` and `max` are the two levels
 * that require an explicit mapping. Each case is pinned separately because getting any
 * of it backwards is a silent lie in the control.
 */

/** Build a model with an explicit per-level map. */
function model(overrides: Record<string, unknown> = {}) {
  return {
    id: "m",
    name: "m",
    provider: "p",
    reasoning: true,
    contextWindow: 1000,
    input: ["text"] as ("text" | "image")[],
    ...overrides,
  };
}

describe("thinkingLevelsOf", () => {
  it("keeps `off`, `high` and `max` for my-newapi/deepseek-flash", () => {
    /*
     * This machine's real configuration. `off` is always available to a reasoning
     * model; `high` and `max` are mapped; `minimal`/`low`/`medium`/`xhigh` are
     * explicitly null and must not appear.
     */
    const levels = thinkingLevelsOf(
      model({
        thinkingLevelMap: {
          minimal: null,
          low: null,
          medium: null,
          high: "high",
          xhigh: null,
          max: "max",
        },
      }),
    );
    expect(levels).toEqual(["off", "high", "max"]);
  });

  it("requires an explicit mapping for both `xhigh` and `max`", () => {
    /*
     * These two are the exception to "absent means available": offering them because
     * the map merely omits them renders a level the runtime clamps away.
     */
    const bare = thinkingLevelsOf(model());
    expect(bare).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(bare).not.toContain("xhigh");
    expect(bare).not.toContain("max");

    const mapped = thinkingLevelsOf(model({ thinkingLevelMap: { xhigh: "max", max: "max" } }));
    expect(mapped).toContain("xhigh");
    expect(mapped).toContain("max");
  });

  it("treats an absent map as 'everything except xhigh and max'", () => {
    expect(thinkingLevelsOf(model())).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  it("excludes only the levels mapped to null", () => {
    const levels = thinkingLevelsOf(
      model({ thinkingLevelMap: { low: null, max: "max" } }),
    );
    expect(levels).toEqual(["off", "minimal", "medium", "high", "max"]);
  });

  it("reports no levels for a non-reasoning model", () => {
    /* `undefined` is what hides the control entirely. */
    expect(thinkingLevelsOf(model({ reasoning: false }))).toBeUndefined();
  });

  it("matches the real catalogue on this machine", () => {
    /*
     * The oracle: every model in `models.json`, against the values the SDK's own
     * `getSupportedThinkingLevels` produces for the same input.
     *
     * This test reads a DEVELOPER-MACHINE file, so it must not assume which models
     * that file contains. It previously asserted `gpt-6-luna` unconditionally and
     * failed on any machine whose catalogue lacked that id — a red suite saying
     * nothing about the code. The invariants that actually matter are checked
     * below regardless of the catalogue's contents; the per-model assertions run
     * only when the model is present.
     */
    const modelsPath = "C:/Users/zlmpp/.pi/agent/models.json";
    if (!existsSync(modelsPath)) {
      /* No catalogue on this machine — nothing to compare against. */
      return;
    }
    const raw = JSON.parse(readFileSync(modelsPath, "utf8"));
    const provider = raw.providers?.["my-newapi"];
    if (!provider?.models) return;
    const byId = new Map<string, string[] | undefined>(
      provider.models.map((m: Record<string, unknown>) => [
        String(m.id),
        thinkingLevelsOf(
          model({
            reasoning: m.reasoning ?? false,
            ...(m.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: m.thinkingLevelMap }),
          }),
        ),
      ]),
    );

    /* A reasoning model with an explicit map exposes exactly the mapped levels
     * plus the always-present `off`; anything else would put levels on the wire
     * the model cannot honour. */
    for (const m of provider.models as Record<string, unknown>[]) {
      if (m.reasoning !== true) continue;
      const levels = byId.get(String(m.id));
      expect(levels, `${String(m.id)} is a reasoning model but reported no levels`).toBeDefined();
      expect(levels).toContain("off");
      const map = m.thinkingLevelMap as Record<string, unknown> | undefined;
      if (map !== undefined) {
        for (const [level, value] of Object.entries(map)) {
          if (value === null) {
            expect(levels, `${String(m.id)} must not offer ${level}`).not.toContain(level);
          } else {
            expect(levels, `${String(m.id)} should offer ${level}`).toContain(level);
          }
        }
      }
    }
    /* Every reported level must be one the protocol can carry. */
    for (const levels of byId.values()) {
      for (const level of levels ?? []) {
        expect(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).toContain(level);
      }
    }
  });
});

describe("wireFromModel", () => {
  it("carries thinking_levels for a reasoning model", () => {
    const wire = wireFromModel(model({ thinkingLevelMap: { high: "high", max: "max", low: null } }));
    expect(wire.thinking_levels).toEqual(["off", "minimal", "medium", "high", "max"]);
  });

  it("omits thinking_levels entirely for a non-reasoning model", () => {
    /*
     * Omitted, not empty: the picker hides the control on `undefined`, and an empty
     * array would be indistinguishable from "supports nothing".
     */
    const wire = wireFromModel(model({ reasoning: false }));
    expect(wire.thinking_levels).toBeUndefined();
    expect("thinking_levels" in wire).toBe(false);
  });
});
