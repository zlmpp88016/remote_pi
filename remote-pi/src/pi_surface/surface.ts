/**
 * Plan/68 — Pi surface: what this Pi has installed (skills + packages).
 *
 * The app needs to *see* and *manage* the Pi's skills and packages without a
 * generic command picker (same rationale as plan/28). Everything here reads
 * from authoritative sources and never guesses:
 *
 *   - skills come from the SDK's own `loadSkills()`, which is exactly what Pi
 *     uses at startup (recursive `SKILL.md` discovery, name collisions keep the
 *     first, malformed files are dropped). The SDK also hands us the
 *     `sourceInfo.scope`/`origin`, so we do not re-derive provenance.
 *   - packages come from the SDK's `DefaultPackageManager.listConfiguredPackages()`,
 *     which reads `~/.pi/agent/settings.json` and `.pi/settings.json`.
 *
 * Enabled/disabled is NOT a field Pi stores per skill. Pi implements it with
 * exclusion patterns in the `skills` resource setting: a `-<path>` entry removes
 * that path (or everything under it) from the catalog. So [listSurface] reads
 * the effective pattern set through `PackageManager.resolve()` and marks each
 * discovered skill with the resulting `enabled` flag, while [setSkillEnabled]
 * writes/removes such a pattern. That keeps the app's toggle and `pi config`
 * manipulating the same single source of truth.
 *
 * **Never fabricate**: when a value cannot be determined the wire carries
 * `null` (see `enabled`), never a plausible guess.
 */

import { sep } from "node:path";
import { readFileSync } from "node:fs";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { SkillSource } from "../protocol/types.js";
/** The SDK's `Skill`, narrowed to the fields we project onto the wire. */
export interface SdkSkillLike {
  name: string;
  description: string;
  filePath: string;
  disableModelInvocation: boolean;
  sourceInfo?: { scope?: string; origin?: string };
}

/** One discovered skill, resolved to wire values. */
export interface SkillRecord {
  name: string;
  description: string;
  path: string;
  source: SkillSource;
  /** `null` when the effective pattern set did not cover the path. */
  enabled: boolean | null;
  disable_model_invocation: boolean;
}

export interface PackageRecord {
  source: string;
  scope: "user" | "project";
  resources: string[];
}

/** Structural subset of the SDK's `SettingsManager` we depend on. */
export interface SettingsLike {
  getSkillPaths(): string[];
  setSkillPaths(paths: string[]): void;
  /** Project-scope `skills` patterns (`Settings.skills` of the project file). */
  getProjectSettings(): { skills?: string[] };
  setProjectSkillPaths(paths: string[]): void;
  isProjectTrusted(): boolean;
  /** Durably writes pending changes. Optional so a fake need not implement it. */
  flush?(): Promise<void>;
}

export interface ConfiguredPackageLike {
  source: string;
  scope: "user" | "project";
}

export interface ResolvedResourceLike {
  path: string;
  enabled: boolean;
  metadata: { source: string; origin?: string };
}

export interface ResolvedPathsLike {
  extensions: ResolvedResourceLike[];
  skills: ResolvedResourceLike[];
  prompts: ResolvedResourceLike[];
  themes: ResolvedResourceLike[];
}

/** Structural subset of the SDK's `PackageManager` we depend on. */
export interface PackageManagerLike {
  resolve(
    onMissing?: (source: string) => Promise<"install" | "skip" | "error">,
  ): Promise<ResolvedPathsLike>;
  listConfiguredPackages(): ConfiguredPackageLike[];
  installAndPersist(source: string, options?: { local?: boolean }): Promise<void>;
  removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean>;
  update(source?: string): Promise<void>;
}

export interface LoadSkillsLike {
  (options: {
    cwd: string;
    agentDir: string;
    skillPaths: string[];
    includeDefaults: boolean;
  }): { skills: SdkSkillLike[] };
}

export interface SurfaceDeps {
  agentDir: string;
  /** Workspace cwd, or `null` when no session ctx exists yet. */
  cwd: string | null;
  settings: SettingsLike;
  packages: PackageManagerLike;
  loadSkillsFn: LoadSkillsLike;
}

const RESOURCE_KINDS = ["extensions", "skills", "prompts", "themes"] as const;

/**
 * Map the SDK's `SourceInfo` onto the wire's closed vocabulary.
 * `origin: "package"` wins because a package ships its skills regardless of
 * the scope the package itself was installed under.
 */
export function skillSource(skill: SdkSkillLike): SkillSource {
  if (skill.sourceInfo?.origin === "package") return "package";
  if (skill.sourceInfo?.scope === "project") return "project";
  return "user";
}

/** Case-insensitive path key (Windows paths round-trip through settings). */
function pathKey(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/**
 * Whether exclusion pattern `pattern` (`-<path>`) covers `target`.
 *
 * Both `/` and `\` count as separators: a pattern written on one platform is
 * still a path to the other, and a directory pattern covers its whole subtree.
 */
export function exclusionCovers(pattern: string, target: string): boolean {
  if (!pattern.startsWith("-")) return false;
  const strip = (s: string) => pathKey(s).replace(/[/\\]+$/, "");
  const root = strip(pattern.slice(1));
  const p = pathKey(target);
  return p === root || p.startsWith(`${root}/`) || p.startsWith(`${root}\\`);
}

/** Every resource kind the package at `source` actually contributes. */
function resourcesForSource(resolved: ResolvedPathsLike, source: string): string[] {
  const kinds: string[] = [];
  for (const kind of RESOURCE_KINDS) {
    const list = resolved[kind];
    if (list.some((r) => r.metadata.source === source)) kinds.push(kind);
  }
  return kinds;
}

/**
 * The configured packages, each annotated with the resource kinds it
 * contributes. `resolve()` only reports resources for packages that are
 * present on disk (an uninstalled npm/git source contributes nothing yet).
 */
export async function listPackages(deps: SurfaceDeps): Promise<PackageRecord[]> {
  const configured = deps.packages.listConfiguredPackages();
  let resolved: ResolvedPathsLike | null = null;
  try {
    // `skip` keeps this a pure read: never install/clone to answer a listing.
    resolved = await deps.packages.resolve(async () => "skip");
  } catch {
    // A broken package tree must not break the whole surface — the configured
    // list is still authoritative for `source`/`scope`; resources become empty.
    resolved = null;
  }
  return configured.map((p) => ({
    source: p.source,
    scope: p.scope,
    resources: resolved ? resourcesForSource(resolved, p.source) : [],
  }));
}

/**
 * Every skill Pi would load for this workspace, with the effective enabled
 * flag. `enabled` is `null` when the pattern set did not cover the path —
 * the host genuinely cannot say, so it does not invent a `true`.
 *
 * Skills are assembled from the same two sources Pi merges: the resource
 * resolver's catalog (which carries package provenance, `origin: "package"`)
 * and `loadSkills()` itself (which owns the standalone `SKILL.md` discovery
 * rules and the description validation). The resolver's entry wins when both
 * name the same file, because only it knows the file came from a package.
 */
export async function listSkills(deps: SurfaceDeps): Promise<SkillRecord[]> {
  const enabledByPath = new Map<string, boolean>();
  const packagePaths: string[] = [];
  try {
    const resolved = await deps.packages.resolve(async () => "skip");
    for (const r of resolved.skills) {
      enabledByPath.set(pathKey(r.path), r.enabled);
      if (r.metadata.origin === "package") packagePaths.push(r.path);
    }
  } catch {
    // Resolution failed: we cannot claim enabled/disabled, so report null.
  }

  const skillPaths = [...deps.settings.getSkillPaths(), ...packagePaths];
  const loaded = deps.loadSkillsFn({
    cwd: deps.cwd ?? deps.agentDir,
    agentDir: deps.agentDir,
    skillPaths,
    includeDefaults: true,
  });

  // `loadSkills` loads a package skill as a top-level "temporary" path, losing
  // the package origin. Re-tag exactly those paths.
  const packageSet = new Set(packagePaths.map(pathKey));
  const tagged: SkillRecord[] = loaded.skills.map((s) => ({
    name: s.name,
    description: s.description,
    path: s.filePath,
    source: packageSet.has(pathKey(s.filePath)) ? "package" : skillSource(s),
    enabled: enabledByPath.get(pathKey(s.filePath)) ?? null,
    disable_model_invocation: s.disableModelInvocation,
  }));

  // The resolver also identifies skills `loadSkills` cannot reach from its
  // configured inputs (e.g. a package whose `SKILL.md` sits outside the
  // conventional `skills/` directory). Add the residue by reading the file.
  const seen = new Set(tagged.map((s) => pathKey(s.path)));
  for (const path of packagePaths) {
    if (seen.has(pathKey(path))) continue;
    try {
      tagged.push(readSkillFile(path, enabledByPath.get(pathKey(path)) ?? null));
    } catch {
      // Unreadable/malformed: skip rather than invent an entry.
    }
  }
  return tagged;
}

/** The exclusion patterns that currently disable `filePath`, per scope. */
export function disablingPatterns(paths: string[], filePath: string): string[] {
  return paths.filter((p) => exclusionCovers(p, filePath));
}

/**
 * Read one `SKILL.md` the resolver found but `loadSkills` did not reach.
 * Uses the SDK's own frontmatter parser so the rules stay in one place, and
 * drops the entry when the name/description are not usable (a malformed file
 * is not a skill — inventing one would break the never-fabricate rule).
 */
function readSkillFile(path: string, enabled: boolean | null): SkillRecord {
  const { frontmatter } = parseFrontmatter(readFileSync(path, "utf-8"));
  const name = typeof frontmatter.name === "string" ? frontmatter.name : "";
  const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
  if (!name || !description) throw new Error(`no usable skill frontmatter in ${path}`);
  return {
    name,
    description,
    path,
    source: "package",
    enabled,
    disable_model_invocation: frontmatter["disable-model-invocation"] === true,
  };
}

/**
 * Enable or disable one skill by name.
 *
 * Scope is dictated by where the skill lives, not by what exists: the SDK
 * applies the `skills` patterns of a scope ONLY to the resources of that scope
 * (a user-directory skill is resolved against the user patterns, a project one
 * against the project patterns). Writing the pattern anywhere else silently
 * does nothing, so a user skill is toggled in user settings and a project skill
 * in project settings. A package skill cannot be toggled at all — it ships
 * with the package — and is refused explicitly rather than pretending.
 *
 * Enabling removes every pattern that disables the skill, from BOTH scopes, so
 * the resulting state is unambiguous.
 */
export async function setSkillEnabled(
  deps: SurfaceDeps,
  name: string,
  enabled: boolean,
): Promise<SkillRecord> {
  const skills = await listSkills(deps);
  const skill = skills.find((s) => s.name === name);
  if (!skill) throw new Error(`skill "${name}" is not installed on this machine`);
  if (skill.source === "package") {
    throw new Error(`skill "${name}" ships inside a package; remove the package to disable it`);
  }

  const useProject = skill.source === "project";
  if (useProject && !deps.settings.isProjectTrusted()) {
    throw new Error("project is not trusted; cannot change project settings");
  }

  const globalPaths = deps.settings.getSkillPaths().filter(
    (p) => !exclusionCovers(p, skill.path),
  );
  const projectPaths = (deps.settings.getProjectSettings().skills ?? []).filter(
    (p) => !exclusionCovers(p, skill.path),
  );

  if (!enabled) {
    // A `-` pattern removes the path (or, for a directory pattern, the whole
    // subtree). `SKILL.md` is the file Pi loads, so targeting it is exact.
    (useProject ? projectPaths : globalPaths).push(`-${skill.path}`);
  }

  deps.settings.setSkillPaths(globalPaths);
  if (useProject) deps.settings.setProjectSkillPaths(projectPaths);
  // Durability matters here: the very next `pi_surface` re-reads from disk, and
  // a settings write that never lands would make the toggle look inverted.
  await deps.settings.flush?.();

  return skill;
}
