/**
 * Package enable/disable (plugins feature).
 *
 * The user asked for BOTH capabilities and for them to be distinct:
 *   - install / update / uninstall  -> changes what is on disk
 *   - disable / enable              -> reversible, changes only what loads
 *
 * Pi's only disable mechanism is the object form of a settings package entry
 * with every resource array empty. `applyPackageFilter` then adds every file
 * with `enabled: false`, so nothing loads while the code stays installed. That
 * makes the flag reportable and the operation reversible offline — which is
 * exactly what "uninstall" is not.
 *
 * These tests pin:
 *   1. `listPackages` reports `enabled:false` ONLY for the all-empty form, and
 *      still reports `true` for an entry that merely pins a subset (filtered is
 *      not disabled — telling the user their plugin is off while part of it runs
 *      would be a lie).
 *   2. `setPackageEnabled` writes the right spelling, at the right scope, and
 *      only for a package that is actually configured.
 *   3. A project-scope write refuses an untrusted project.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  listPackages,
  setPackageEnabled,
  type PackageEntryLike,
  type PackageManagerLike,
  type SettingsLike,
  type SurfaceDeps,
} from "./surface.js";

const ALL_EMPTY = { extensions: [], skills: [], prompts: [], themes: [] };

interface FakeSettings extends SettingsLike {
  /** What `setPackages` / `setProjectPackages` were called with. */
  written: { global?: PackageEntryLike[]; project?: PackageEntryLike[] };
}

function settings(opts: {
  global?: PackageEntryLike[];
  project?: PackageEntryLike[];
  trust?: boolean;
  writable?: boolean;
}): FakeSettings {
  const written: { global?: PackageEntryLike[]; project?: PackageEntryLike[] } = {};
  let global = opts.global ?? [];
  let project = opts.project ?? [];
  const flush = vi.fn(async () => {});
  const base: FakeSettings = {
    written,
    getSkillPaths: () => [],
    setSkillPaths: () => {},
    getGlobalSettings: () => ({ packages: global }),
    getProjectSettings: () => ({ skills: [], packages: project }),
    setProjectSkillPaths: () => {},
    isProjectTrusted: () => opts.trust !== false,
    flush,
  };
  if (opts.writable !== false) {
    Object.assign(base, {
      setPackages: (next: PackageEntryLike[]) => {
        global = next;
        written.global = next;
      },
      setProjectPackages: (next: PackageEntryLike[]) => {
        project = next;
        written.project = next;
      },
    });
  }
  return base;
}

function deps(s: SettingsLike, sources: readonly string[] = []): SurfaceDeps {
  const packages: PackageManagerLike = {
    resolve: async () => ({ extensions: [], skills: [], prompts: [], themes: [] }),
    listConfiguredPackages: () =>
      sources.map((source) => ({ source, scope: "user" as const })),
    installAndPersist: async () => {},
    removeAndPersist: async () => true,
    update: async () => {},
  };
  return {
    agentDir: "/agent",
    cwd: "/proj",
    settings: s,
    packages,
    loadSkillsFn: () => ({ skills: [] }),
  };
}

describe("listPackages — the enabled flag", () => {
  test("a plain string entry is enabled", async () => {
    const s = settings({ global: ["npm:a@1"] });
    const [pkg] = await listPackages(deps(s, ["npm:a@1"]));
    expect(pkg?.enabled).toBe(true);
  });

  test("the all-empty object form is DISABLED", async () => {
    const s = settings({ global: [{ source: "npm:a@1", ...ALL_EMPTY }] });
    const [pkg] = await listPackages(deps(s, ["npm:a@1"]));
    expect(pkg?.enabled).toBe(false);
  });

  test("an entry that pins a SUBSET is still enabled, not disabled", async () => {
    /* `extensions: []` alone disables extensions while leaving skills on, so
       reporting this as "off" would contradict a plugin that is partly running. */
    const s = settings({
      global: [{ source: "npm:a@1", extensions: [], skills: ["src/skills/*"] }],
    });
    const [pkg] = await listPackages(deps(s, ["npm:a@1"]));
    expect(pkg?.enabled).toBe(true);
  });

  test("a missing array means 'no constraint', so it is not a disable", async () => {
    const s = settings({
      global: [{ source: "npm:a@1", extensions: [], skills: [], prompts: [] }],
    });
    const [pkg] = await listPackages(deps(s, ["npm:a@1"]));
    expect(pkg?.enabled).toBe(true);
  });

  test("scope matters: a disabled project entry does not mark the user one", async () => {
    const s = settings({
      global: ["npm:a@1"],
      project: [{ source: "npm:a@1", ...ALL_EMPTY }],
    });
    /* The fake manager reports the same source at USER scope, so this pins that
       the lookup is by (scope, source) and not by source alone. */
    const [pkg] = await listPackages(deps(s, ["npm:a@1"]));
    expect(pkg?.scope).toBe("user");
    expect(pkg?.enabled).toBe(true);
  });
});

describe("setPackageEnabled", () => {
  test("disabling writes the all-empty object form and reports false", async () => {
    const s = settings({ global: ["npm:a@1"] });
    const pkg = await setPackageEnabled(deps(s, ["npm:a@1"]), "npm:a@1", "user", false);

    expect(pkg.enabled).toBe(false);
    expect(s.written.global).toEqual([{ source: "npm:a@1", ...ALL_EMPTY }]);
  });

  test("enabling writes the plain string form back", async () => {
    const s = settings({ global: [{ source: "npm:a@1", ...ALL_EMPTY }] });
    const pkg = await setPackageEnabled(deps(s, ["npm:a@1"]), "npm:a@1", "user", true);

    expect(pkg.enabled).toBe(true);
    expect(s.written.global).toEqual(["npm:a@1"]);
  });

  test("it flushes, so the switch cannot look inverted on the next listing", async () => {
    const s = settings({ global: ["npm:a@1"] });
    await setPackageEnabled(deps(s, ["npm:a@1"]), "npm:a@1", "user", false);
    expect(s.flush).toHaveBeenCalled();
  });

  test("it refuses a source that is not configured", async () => {
    const s = settings({ global: ["npm:a@1"] });
    await expect(
      setPackageEnabled(deps(s, ["npm:a@1"]), "npm:other@2", "user", false),
    ).rejects.toThrow(/not configured/);
    expect(s.written.global).toBeUndefined();
  });

  test("it refuses an empty source", async () => {
    const s = settings({ global: ["npm:a@1"] });
    await expect(setPackageEnabled(deps(s, ["npm:a@1"]), "   ", "user", false)).rejects.toThrow(
      /source is required/,
    );
  });

  test("a project-scope write refuses an untrusted project", async () => {
    const s = settings({ global: [], project: ["npm:a@1"], trust: false });
    await expect(
      setPackageEnabled(deps(s, []), "npm:a@1", "project", false),
    ).rejects.toThrow(/not trusted/);
    expect(s.written.project).toBeUndefined();
  });

  test("a settings manager that cannot write is reported, not silently ignored", async () => {
    const s = settings({ global: ["npm:a@1"], writable: false });
    await expect(
      setPackageEnabled(deps(s, ["npm:a@1"]), "npm:a@1", "user", false),
    ).rejects.toThrow(/cannot write/);
  });

  test("other entries in the list are preserved in order", async () => {
    const s = settings({ global: ["npm:a@1", "npm:b@2", "npm:c@3"] });
    await setPackageEnabled(deps(s, ["npm:a@1"]), "npm:b@2", "user", false);
    expect(s.written.global).toEqual([
      "npm:a@1",
      { source: "npm:b@2", ...ALL_EMPTY },
      "npm:c@3",
    ]);
  });
});
