/**
 * Plan/68 W3 — Pi surface handlers: parse + happy path + error for each
 * message, with every dependency faked so nothing touches the network, npm,
 * or a live Pi session.
 *
 * The security-critical assertion lives here: `package_install` without
 * `confirm_third_party: true` is refused *before* the package manager is
 * called at all.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ServerMessage, ClientMessage } from "../protocol/types.js";
import {
  handlePackageInstall,
  handlePackageRemove,
  handlePackageUpdate,
  handlePiSurface,
  handleSkillInvoke,
  handleSkillSetEnabled,
  type DispatchUserMessageFn,
} from "./handlers.js";
import type { PackageManagerLike, SettingsLike, SurfaceDeps } from "./surface.js";

function collector(): { sent: ServerMessage[]; send: (m: ServerMessage) => void } {
  const sent: ServerMessage[] = [];
  return { sent, send: (m) => sent.push(m) };
}

/** A fake settings manager backed by two pattern arrays. */
function fakeSettings(opts: { project?: string[]; trust?: boolean } = {}): SettingsLike & {
  global: string[];
  project: string[];
} {
  const state = {
    global: [] as string[],
    project: opts.project ?? [],
  };
  return {
    ...state,
    get global() { return state.global; },
    set global(v: string[]) { state.global = v; },
    get project() { return state.project; },
    set project(v: string[]) { state.project = v; },
    getSkillPaths: () => state.global,
    setSkillPaths: (p) => { state.global = p; },
    getProjectSettings: () => ({ skills: state.project }),
    setProjectSkillPaths: (p) => { state.project = p; },
    isProjectTrusted: () => opts.trust !== false,
    flush: async () => {},
  };
}

function fakePackages(over: Partial<PackageManagerLike> = {}): PackageManagerLike {
  return {
    resolve: vi.fn(async () => ({
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    })),
    listConfiguredPackages: vi.fn(() => []),
    installAndPersist: vi.fn(async () => {}),
    removeAndPersist: vi.fn(async () => true),
    update: vi.fn(async () => {}),
    ...over,
  };
}

function deps(over: Partial<SurfaceDeps> = {}): SurfaceDeps {
  return {
    agentDir: "/agent",
    cwd: "/proj",
    settings: fakeSettings(),
    packages: fakePackages(),
    // One user skill, one project skill (with the sourceInfo the SDK provides).
    loadSkillsFn: () => ({
      skills: [
        { name: "pdf-tools", description: "PDFs", filePath: "/agent/skills/pdf-tools/SKILL.md", disableModelInvocation: false, sourceInfo: { scope: "user", origin: "top-level" } },
        { name: "repo-helper", description: "Repo", filePath: "/proj/.pi/skills/repo-helper/SKILL.md", disableModelInvocation: true, sourceInfo: { scope: "project", origin: "top-level" } },
      ],
    }),
    ...over,
  };
}

let dispatch: { fn: DispatchUserMessageFn; calls: Array<{ text: string; opts?: object }> };
beforeEach(() => {
  const calls: Array<{ text: string; opts?: object }> = [];
  dispatch = {
    calls,
    fn: (text, opts) => {
      calls.push({ text, opts });
      return { ok: true };
    },
  };
});

describe("plan/68 — pi_surface", () => {
  const msg: Extract<ClientMessage, { type: "pi_surface" }> = { type: "pi_surface", id: "r1" };

  test("happy path reports runtime, skills and packages", async () => {
    const col = collector();
    const packages = fakePackages({
      listConfiguredPackages: () => [{ source: "npm:@x/y@1", scope: "user" }],
    });
    await handlePiSurface(
      deps({ packages }),
      { model: () => ({ provider: "anthropic", id: "claude-opus-4-7" }), thinking: () => "medium" },
      col,
      msg,
    );

    expect(col.sent).toHaveLength(1);
    const ok = col.sent[0] as Extract<ServerMessage, { type: "pi_surface_ok" }>;
    expect(ok.type).toBe("pi_surface_ok");
    expect(ok.in_reply_to).toBe("r1");
    expect(ok.runtime).toEqual({ running: true, model: "anthropic/claude-opus-4-7", thinking: "medium" });
    expect(ok.skills.map((s) => [s.name, s.source, s.enabled])).toEqual([
      ["pdf-tools", "user", null],
      ["repo-helper", "project", null],
    ]);
    expect(ok.packages[0]).toEqual({ source: "npm:@x/y@1", scope: "user", resources: [] });
  });

  test("no live ctx reports running:false with null model (never fabricate)", async () => {
    const col = collector();
    await handlePiSurface(deps(), undefined, col, msg);
    const ok = col.sent[0] as Extract<ServerMessage, { type: "pi_surface_ok" }>;
    expect(ok.runtime).toEqual({ running: false, model: null, thinking: null });
  });

  test("a throwing runtime accessor degrades to null instead of failing", async () => {
    const col = collector();
    await handlePiSurface(
      deps(),
      {
        model: () => { throw new Error("stale ctx"); },
        thinking: () => { throw new Error("stale ctx"); },
      },
      col,
      msg,
    );
    const ok = col.sent[0] as Extract<ServerMessage, { type: "pi_surface_ok" }>;
    expect(ok.runtime).toEqual({ running: false, model: null, thinking: null });
  });

  test("a discovery failure replies action_error (not a partial surface)", async () => {
    const col = collector();
    await handlePiSurface(
      deps({ loadSkillsFn: () => { throw new Error("boom"); } }),
      undefined,
      col,
      msg,
    );
    const err = col.sent[0] as Extract<ServerMessage, { type: "action_error" }>;
    expect(err.type).toBe("action_error");
    expect(err.action).toBe("pi_surface");
    expect(err.error).toContain("boom");
  });
});

describe("plan/68 — skill_invoke", () => {
  const base: Extract<ClientMessage, { type: "skill_invoke" }> = {
    type: "skill_invoke",
    id: "r2",
    name: "pdf-tools",
  };

  test("dispatches /skill:<name> <args> with prompt expansion enabled", async () => {
    const col = collector();
    await handleSkillInvoke(deps(), dispatch.fn, col, { ...base, args: "extract report.pdf" });
    expect(dispatch.calls).toEqual([
      { text: "/skill:pdf-tools extract report.pdf", opts: { expandPromptTemplates: true } },
    ]);
    expect(col.sent[0]).toEqual({ type: "skill_invoke_ok", in_reply_to: "r2", name: "pdf-tools" });
  });

  test("omits the trailing space when there are no args", async () => {
    const col = collector();
    await handleSkillInvoke(deps(), dispatch.fn, col, base);
    expect(dispatch.calls[0]!.text).toBe("/skill:pdf-tools");
  });

  test("an unknown skill is refused without dispatching", async () => {
    const col = collector();
    await handleSkillInvoke(deps(), dispatch.fn, col, { ...base, name: "nope" });
    expect(dispatch.calls).toHaveLength(0);
    const err = col.sent[0] as Extract<ServerMessage, { type: "action_error" }>;
    expect(err.action).toBe("skill_invoke");
    expect(err.error).toContain("not installed");
  });

  test("an empty name is refused", async () => {
    const col = collector();
    await handleSkillInvoke(deps(), dispatch.fn, col, { ...base, name: "  " });
    expect(dispatch.calls).toHaveLength(0);
    expect((col.sent[0] as Extract<ServerMessage, { type: "action_error" }>).error).toContain("required");
  });

  test("an agent rejection surfaces as action_error", async () => {
    const col = collector();
    await handleSkillInvoke(deps(), () => ({ ok: false, detail: "busy" }), col, base);
    const err = col.sent[0] as Extract<ServerMessage, { type: "action_error" }>;
    expect(err.action).toBe("skill_invoke");
    expect(err.error).toContain("busy");
  });
});

describe("plan/68 — skill_set_enabled", () => {
  const msg: Extract<ClientMessage, { type: "skill_set_enabled" }> = {
    type: "skill_set_enabled",
    id: "r3",
    name: "pdf-tools",
    enabled: false,
  };

  test("happy path persists the exclusion in user scope for a user skill and acks", async () => {
    const col = collector();
    const settings = fakeSettings();
    await handleSkillSetEnabled(deps({ settings }), col, msg);
    // `pdf-tools` is a USER skill → the pattern lands in user (global) scope.
    expect(settings.global).toEqual(["-/agent/skills/pdf-tools/SKILL.md"]);
    expect(settings.project).toEqual([]);
    expect(col.sent[0]).toEqual({
      type: "skill_set_enabled_ok",
      in_reply_to: "r3",
      name: "pdf-tools",
      enabled: false,
    });
  });

  test("a project skill is toggled in project scope", async () => {
    const col = collector();
    const settings = fakeSettings();
    await handleSkillSetEnabled(deps({ settings }), col, { ...msg, name: "repo-helper" });
    expect(settings.global).toEqual([]);
    expect(settings.project).toEqual(["-/proj/.pi/skills/repo-helper/SKILL.md"]);
  });

  test("a package skill cannot be toggled (it ships with the package)", async () => {
    const col = collector();
    const pkgSkill = {
      name: "fmt",
      description: "Format code",
      filePath: "/agent/pkg/skills/fmt/SKILL.md",
      disableModelInvocation: false,
      // What the real SDK reports when it loads a path handed to it.
      sourceInfo: { scope: "temporary", origin: "top-level" },
    };
    const packages = fakePackages({
      resolve: vi.fn(async () => ({
        extensions: [],
        prompts: [],
        themes: [],
        skills: [{
          path: pkgSkill.filePath,
          enabled: true,
          metadata: { source: "/agent/pkg", origin: "package" },
        }],
      })),
    });
    const settings = fakeSettings();
    await handleSkillSetEnabled(
      deps({ settings, packages, loadSkillsFn: () => ({ skills: [pkgSkill] }) }),
      col,
      { ...msg, name: "fmt" },
    );
    expect(settings.global).toEqual([]);
    const err = col.sent[0] as Extract<ServerMessage, { type: "action_error" }>;
    expect(err.action).toBe("skill_set_enabled");
    expect(err.error).toContain("ships inside a package");
  });

  test("an unknown skill replies action_error", async () => {
    const col = collector();
    await handleSkillSetEnabled(deps(), col, { ...msg, name: "ghost" });
    const err = col.sent[0] as Extract<ServerMessage, { type: "action_error" }>;
    expect(err.action).toBe("skill_set_enabled");
    expect(err.error).toContain("not installed");
  });
});

describe("plan/68 — package_install", () => {
  const msg: Extract<ClientMessage, { type: "package_install" }> = {
    type: "package_install",
    id: "r4",
    source: "npm:@example/pi-tools@1.0.0",
    scope: "user",
    confirm_third_party: true,
  };

  test("REFUSES without confirm_third_party and never touches the package manager", async () => {
    const col = collector();
    const packages = fakePackages();
    const { confirm_third_party: _drop, ...unconfirmed } = msg;
    await handlePackageInstall(deps({ packages }), col, unconfirmed);
    expect(packages.installAndPersist).not.toHaveBeenCalled();
    const err = col.sent[0] as Extract<ServerMessage, { type: "action_error" }>;
    expect(err.action).toBe("package_install");
    expect(err.error).toContain("confirm_third_party");
  });

  test("REFUSES when the flag is explicitly false", async () => {
    const col = collector();
    const packages = fakePackages();
    await handlePackageInstall(deps({ packages }), col, { ...msg, confirm_third_party: false });
    expect(packages.installAndPersist).not.toHaveBeenCalled();
    expect((col.sent[0] as Extract<ServerMessage, { type: "action_error" }>).error).toContain("confirm_third_party");
  });

  test("happy path installs into user settings and acks with scope", async () => {
    const col = collector();
    const packages = fakePackages();
    await handlePackageInstall(deps({ packages }), col, msg);
    expect(packages.installAndPersist).toHaveBeenCalledWith("npm:@example/pi-tools@1.0.0", { local: false });
    expect(col.sent[0]).toEqual({
      type: "package_op_ok",
      in_reply_to: "r4",
      op: "install",
      source: "npm:@example/pi-tools@1.0.0",
      scope: "user",
    });
  });

  test("project scope passes local:true, and requires project trust", async () => {
    const col = collector();
    const packages = fakePackages();
    await handlePackageInstall(deps({ packages }), col, { ...msg, scope: "project" });
    expect(packages.installAndPersist).toHaveBeenCalledWith("npm:@example/pi-tools@1.0.0", { local: true });

    const refused = collector();
    const untrusted = fakePackages();
    await handlePackageInstall(
      deps({ packages: untrusted, settings: fakeSettings({ trust: false }) }),
      refused,
      { ...msg, scope: "project" },
    );
    expect(untrusted.installAndPersist).not.toHaveBeenCalled();
    expect((refused.sent[0] as Extract<ServerMessage, { type: "action_error" }>).error).toContain("not trusted");
  });

  test("a package manager failure replies action_error", async () => {
    const col = collector();
    const packages = fakePackages({
      installAndPersist: vi.fn(async () => { throw new Error("network down"); }),
    });
    await handlePackageInstall(deps({ packages }), col, msg);
    const err = col.sent[0] as Extract<ServerMessage, { type: "action_error" }>;
    expect(err.action).toBe("package_install");
    expect(err.error).toContain("network down");
  });
});

describe("plan/68 — package_remove / package_update", () => {
  test("remove acks when the source was configured", async () => {
    const col = collector();
    const packages = fakePackages();
    await handlePackageRemove(deps({ packages }), col, {
      type: "package_remove",
      id: "r5",
      source: "npm:@x/y@1",
    });
    expect(packages.removeAndPersist).toHaveBeenCalledWith("npm:@x/y@1", { local: false });
    expect(col.sent[0]).toEqual({
      type: "package_op_ok",
      in_reply_to: "r5",
      op: "remove",
      source: "npm:@x/y@1",
      scope: null,
    });
  });

  test("remove of an unknown source is an error", async () => {
    const col = collector();
    const packages = fakePackages({ removeAndPersist: vi.fn(async () => false) });
    await handlePackageRemove(deps({ packages }), col, {
      type: "package_remove",
      id: "r5",
      source: "npm:@x/y@1",
    });
    expect((col.sent[0] as Extract<ServerMessage, { type: "action_error" }>).error).toContain("not configured");
  });

  test("update with no source reconciles all installed packages", async () => {
    const col = collector();
    const packages = fakePackages();
    await handlePackageUpdate(deps({ packages }), col, { type: "package_update", id: "r6" });
    expect(packages.update).toHaveBeenCalledWith(undefined);
    expect(col.sent[0]).toEqual({
      type: "package_op_ok",
      in_reply_to: "r6",
      op: "update",
      source: "",
      scope: null,
    });
  });

  test("update with a source targets just that one", async () => {
    const col = collector();
    const packages = fakePackages();
    await handlePackageUpdate(deps({ packages }), col, { type: "package_update", id: "r6", source: "npm:@x/y@1" });
    expect(packages.update).toHaveBeenCalledWith("npm:@x/y@1");
  });
});
