/**
 * Plan/68 W3 — production construction of the Pi surface dependencies.
 *
 * The SDK is the only source of truth for skills and packages, so this module
 * wires its three collaborators (`SettingsManager`, `DefaultPackageManager`,
 * `loadSkills`) against the real agent dir and workspace cwd. index.ts only
 * asks for `{ deps, runtime }` at request time; all SDK construction lives
 * here so it stays testable and out of the already-large index.
 *
 * The `SettingsManager` is cached per cwd: it owns a write queue, and creating
 * a fresh manager for every request would drop pending writes (the pattern a
 * `skill_set_enabled` immediately followed by a `pi_surface` would hit).
 */

import {
  DefaultPackageManager,
  SettingsManager,
  getAgentDir,
  loadSkills,
} from "@earendil-works/pi-coding-agent";
import type { SurfaceDeps } from "./surface.js";

/** Everything the surface handlers need for one request. */
export interface SurfaceContext {
  deps: SurfaceDeps;
  runtime: SurfaceRuntimeLike;
}

/** Live session state, read lazily so a stale ctx cannot throw here. */
export interface SurfaceRuntimeLike {
  model: () => { provider: string; id: string } | undefined;
  thinking: () => import("../protocol/types.js").ThinkingLevel;
}

const managers = new Map<string, SettingsManager>();

function settingsFor(cwd: string, agentDir: string): SettingsManager {
  const key = `${agentDir}\u0000${cwd}`;
  let manager = managers.get(key);
  if (!manager) {
    manager = SettingsManager.create(cwd, agentDir);
    managers.set(key, manager);
  }
  return manager;
}

/** Test seam — drops the cached settings managers. */
export function _resetSurfaceDepsForTests(): void {
  managers.clear();
}

export interface SurfaceDepsOptions {
  /** Workspace cwd, or `null` before a session ctx exists. */
  cwd: string | null;
  /** Overrides the Pi agent dir (tests point this at a throwaway home). */
  agentDir?: string;
  model?: () => { provider: string; id: string } | undefined;
  thinking?: () => import("../protocol/types.js").ThinkingLevel;
}

/** Build the dependencies for one `pi_surface*` request. */
export function ensureSurfaceDeps(options: SurfaceDepsOptions): {
  deps: SurfaceDeps;
  runtime: SurfaceRuntimeLike;
} {
  const agentDir = options.agentDir ?? getAgentDir();
  // SettingsManager needs a cwd; without one, the agent dir is a safe standing
  // location (reads still resolve the user scope, which is what we can show).
  const cwd = options.cwd ?? agentDir;
  const settings = settingsFor(cwd, agentDir);
  const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
  return {
    deps: { agentDir, cwd: options.cwd, settings, packages, loadSkillsFn: loadSkills },
    runtime: {
      model: options.model ?? (() => undefined),
      thinking: options.thinking ?? (() => "off"),
    },
  };
}
