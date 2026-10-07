/**
 * Plan/68 W3 — the Pi surface readers.
 *
 * The purpose here is that `pi_surface_ok` reports what Pi actually has, so
 * these tests run against the **real SDK** (`loadSkills`,
 * `SettingsManager`, `DefaultPackageManager`) over a throwaway home. A fake
 * would only prove the projection; using the SDK also pins the contract the
 * handler depends on (that `sourceInfo.scope`/`origin` exist and that an
 * exclusion pattern really flips `enabled`).
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills, SettingsManager, DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import {
  exclusionCovers,
  listPackages,
  listSkills,
  setSkillEnabled,
  skillSource,
  type SurfaceDeps,
} from "./surface.js";

const roots: string[] = [];

/** A throwaway home: agent dir + a project cwd, both empty to start. */
function makeHome(): { root: string; cwd: string; agentDir: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-surface-"));
  roots.push(root);
  const cwd = join(root, "proj");
  const agentDir = join(root, "agent");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(join(agentDir, "skills"), { recursive: true });
  return { root, cwd, agentDir };
}

function writeSkill(dir: string, name: string, extra = ""): string {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  const file = join(skillDir, "SKILL.md");
  writeFileSync(file, `---\nname: ${name}\ndescription: ${name} does things\n${extra}---\nbody\n`);
  return file;
}

function depsFor(home: { cwd: string; agentDir: string }, cwd: string | null = home.cwd): SurfaceDeps {
  const settings = SettingsManager.create(home.cwd, home.agentDir);
  const packages = new DefaultPackageManager({
    cwd: home.cwd,
    agentDir: home.agentDir,
    settingsManager: settings,
  });
  return { agentDir: home.agentDir, cwd, settings, packages, loadSkillsFn: loadSkills };
}

/** Write a local Pi package contributing one skill, and install it for `user`. */
function installLocalPackage(home: { root: string; agentDir: string }, name: string, skill: string): string {
  const pkg = join(home.root, name);
  mkdirSync(join(pkg, "skills"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, keywords: ["pi-package"] }));
  writeSkill(join(pkg, "skills"), skill);
  const settingsPath = join(home.agentDir, "settings.json");
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(require("node:fs").readFileSync(settingsPath, "utf-8"));
  } catch { /* first write */ }
  writeFileSync(
    settingsPath,
    JSON.stringify({ ...current, packages: [...((current.packages as unknown[]) ?? []), pkg] }),
  );
  return pkg;
}

beforeEach(() => {
  // The SDK resolves the agent dir from the environment only when not given,
  // and we always pass it — but a stray user settings file must never leak in.
  delete process.env["PI_AGENT_DIR"];
});

afterEach(() => {
  for (const r of roots.splice(0)) {
    try { rmSync(r, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe("plan/68 — skill provenance", () => {
  test("scope/origin from the SDK map onto user|project|package", () => {
    expect(skillSource({ name: "a", description: "", filePath: "", disableModelInvocation: false, sourceInfo: { scope: "user", origin: "top-level" } })).toBe("user");
    expect(skillSource({ name: "a", description: "", filePath: "", disableModelInvocation: false, sourceInfo: { scope: "project", origin: "top-level" } })).toBe("project");
    expect(skillSource({ name: "a", description: "", filePath: "", disableModelInvocation: false, sourceInfo: { scope: "project", origin: "package" } })).toBe("package");
    // A package installed at user scope still reports `package` (origin wins).
    expect(skillSource({ name: "a", description: "", filePath: "", disableModelInvocation: false, sourceInfo: { scope: "user", origin: "package" } })).toBe("package");
  });
});

describe("plan/68 — listSkills", () => {
  test("discovers user and project skills with paths and descriptions", async () => {
    const home = makeHome();
    const userFile = writeSkill(join(home.agentDir, "skills"), "pdf-tools");
    const projFile = writeSkill(join(home.cwd, ".pi", "skills"), "repo-helper");

    const skills = await listSkills(depsFor(home));
    const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
    expect(Object.keys(byName).sort()).toEqual(["pdf-tools", "repo-helper"]);
    expect(byName["pdf-tools"]!.source).toBe("user");
    expect(byName["pdf-tools"]!.path).toBe(userFile);
    expect(byName["repo-helper"]!.source).toBe("project");
    expect(byName["repo-helper"]!.path).toBe(projFile);
    expect(byName["pdf-tools"]!.description).toContain("does things");
    expect(byName["pdf-tools"]!.enabled).toBe(true);
  });

  test("carries disable-model-invocation through", async () => {
    const home = makeHome();
    writeSkill(join(home.agentDir, "skills"), "manual-only", "disable-model-invocation: true\n");
    const [skill] = await listSkills(depsFor(home));
    expect(skill!.disable_model_invocation).toBe(true);
  });

  test("an exclusion pattern in user settings flips enabled to false", async () => {
    const home = makeHome();
    const file = writeSkill(join(home.agentDir, "skills"), "pdf-tools");
    writeFileSync(join(home.agentDir, "settings.json"), JSON.stringify({ skills: [`-${file}`] }));

    const [skill] = await listSkills(depsFor(home));
    expect(skill!.name).toBe("pdf-tools");
    expect(skill!.enabled).toBe(false);
  });

  test("no session cwd still lists user skills (never throws)", async () => {
    const home = makeHome();
    writeSkill(join(home.agentDir, "skills"), "pdf-tools");
    const skills = await listSkills(depsFor(home, null));
    expect(skills.map((s) => s.name)).toEqual(["pdf-tools"]);
  });
});

describe("plan/68 — listPackages", () => {
  test("reports source, scope and the resource kinds it contributes", async () => {
    const home = makeHome();
    const pkg = installLocalPackage(home, "pi-tools", "fmt");

    const [p] = await listPackages(depsFor(home));
    expect(p!.source).toBe(pkg);
    expect(p!.scope).toBe("user");
    expect(p!.resources).toEqual(["skills"]);
  });

  test("a configured-but-missing package still lists with empty resources", async () => {
    const home = makeHome();
    writeFileSync(
      join(home.agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:@x/y@1.0.0"] }),
    );
    const [p] = await listPackages(depsFor(home));
    expect(p!.source).toBe("npm:@x/y@1.0.0");
    expect(p!.scope).toBe("user");
    expect(p!.resources).toEqual([]);
  });

  test("a package-declared skill is reported with source 'package'", async () => {
    const home = makeHome();
    installLocalPackage(home, "pi-tools", "fmt");
    const skills = await listSkills(depsFor(home));
    expect(skills.map((s) => [s.name, s.source])).toEqual([["fmt", "package"]]);
  });
});

describe("plan/68 — setSkillEnabled", () => {
  test("a USER skill is disabled in user scope (the pattern only applies there)", async () => {
    const home = makeHome();
    const file = writeSkill(join(home.agentDir, "skills"), "pdf-tools");
    const deps = depsFor(home);

    const skill = await setSkillEnabled(deps, "pdf-tools", false);
    expect(skill.source).toBe("user");
    expect(skill.path).toBe(file);
    // A fresh manager sees the persisted pattern, and the resolver honours it.
    const reread = await listSkills(depsFor(home));
    expect(reread.find((s) => s.name === "pdf-tools")!.enabled).toBe(false);
  });

  test("disabling writes a project exclusion and the skill reads back false", async () => {
    const home = makeHome();
    const file = writeSkill(join(home.cwd, ".pi", "skills"), "repo-helper");
    const deps = depsFor(home);

    const skill = await setSkillEnabled(deps, "repo-helper", false);
    expect(skill.path).toBe(file);
    // A fresh manager sees the persisted pattern (not just the in-memory one).
    const reread = await listSkills(depsFor(home));
    expect(reread.find((s) => s.name === "repo-helper")!.enabled).toBe(false);
  });

  test("re-enabling removes the exclusion and reads back true", async () => {
    const home = makeHome();
    writeSkill(join(home.cwd, ".pi", "skills"), "repo-helper");
    const deps = depsFor(home); // trusted: SettingsManager.create defaults to trusted

    await setSkillEnabled(deps, "repo-helper", false);
    await setSkillEnabled(deps, "repo-helper", true);
    const reread = await listSkills(depsFor(home));
    expect(reread.find((s) => s.name === "repo-helper")!.enabled).toBe(true);
  });

  test("a package skill cannot be toggled from settings", async () => {
    const home = makeHome();
    installLocalPackage(home, "pi-tools", "fmt");
    await expect(setSkillEnabled(depsFor(home), "fmt", false)).rejects.toThrow(/ships inside a package/);
  });

  test("an unknown skill is refused", async () => {
    const home = makeHome();
    await expect(setSkillEnabled(depsFor(home), "nope", true)).rejects.toThrow(/not installed/);
  });
});

describe("plan/68 — exclusionCovers", () => {
  test("matches the exact file and everything under a directory", () => {
    expect(exclusionCovers("-/a/b/SKILL.md", "/a/b/SKILL.md")).toBe(true);
    expect(exclusionCovers("-/a/b", "/a/b/SKILL.md")).toBe(true);
    expect(exclusionCovers("-/a/b", "/a/bc/SKILL.md")).toBe(false);
    expect(exclusionCovers("/a/b", "/a/b/SKILL.md")).toBe(false); // no `-` = include
  });
});
