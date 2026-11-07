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
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
  /**
   * Whether this package's resources will actually LOAD.
   *
   * False only when the settings entry is the object form with all four arrays
   * empty, which is how Pi spells "disabled": `applyPackageFilter` then marks
   * every resource of every type as not enabled. The files stay on disk, so this
   * is reversible and distinct from removing the package.
   *
   * An entry that pins a SUBSET of its resources is still `true` here — it is
   * filtered, not disabled, and saying otherwise would tell the user their
   * plugin is off when part of it is running.
   */
  enabled: boolean;
  /**
   * The package's own README, or `null` when there is none to show.
   *
   * This exists because the user asked to READ what a plugin does before they
   * install or keep it, and nothing on the wire carried that. The host is the
   * only party that can answer: only it knows where the package was installed.
   *
   * `null` is a real answer here, not a placeholder: a package may legitimately
   * ship no README, or the file may be too large to send. The UI must render
   * that as "not provided" rather than an empty box.
   */
  readme: string | null;
  /** Path of the README that was read, for provenance. `null` with `readme`. */
  readmePath: string | null;
  /** True when the README exists but exceeded the cap and was cut. */
  readmeTruncated: boolean;
}

/** Structural subset of the SDK's `SettingsManager` we depend on. */
export interface SettingsLike {
  getSkillPaths(): string[];
  setSkillPaths(paths: string[]): void;
  /**
   * The RAW `packages` entries, needed to tell a disabled package from an
   * enabled one.
   *
   * `listConfiguredPackages()` cannot answer that: it collapses every object-form
   * entry to `filtered: true`, which is also true for a package that merely
   * pins a subset of its resources. Only the original entry says whether all
   * four arrays are empty (= disabled).
   */
  getGlobalSettings(): { packages?: readonly PackageEntryLike[] };
  /** Project-scope `skills` patterns and its own raw `packages` entries. */
  getProjectSettings(): { skills?: string[]; packages?: readonly PackageEntryLike[] };
  setProjectSkillPaths(paths: string[]): void;
  isProjectTrusted(): boolean;
  /** Durably writes pending changes. Optional so a fake need not implement it. */
  flush?(): Promise<void>;
}

/** One `packages` entry: the plain form, or the filtering object form. */
export type PackageEntryLike =
  | string
  | {
      source: string;
      extensions?: string[];
      skills?: string[];
      prompts?: string[];
      themes?: string[];
    };

export interface ConfiguredPackageLike {
  source: string;
  scope: "user" | "project";
  /** Absolute path where the package sits on disk, when it is installed.
   *  Absent for a configured-but-not-yet-installed npm/git source. */
  installedPath?: string;
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
 * Cap on the README text handed to a paired device.
 *
 * A README is documentation, not data: 256 KB covers every real one with room
 * to spare. Oversized files are cut and flagged rather than refused, because a
 * long README is still worth reading.
 */
export const README_MAX_BYTES = 256 * 1024;

/** Candidate filenames, in the order a human would look for them. */
const README_NAMES = ["README.md", "readme.md", "Readme.md", "README.markdown", "README.txt"] as const;

/**
 * Read one package's README from its install directory.
 *
 * SECURITY: the only path ever touched is one the SDK itself returned by
 * `getInstalledPath` — i.e. a directory the host already installed INTO, derived
 * from the source string. Nothing here accepts a path from the client, so this
 * cannot be used to read arbitrary files; there is no traversal to escape
 * because there is no user-supplied path at all. The candidate names are a
 * fixed list, never a glob.
 *
 * Every failure mode returns `null` instead of throwing: a package without a
 * README is normal, and one unreadable file must not break the whole listing.
 */
function readPackageReadme(dir: string | undefined): {
  readme: string | null;
  readmePath: string | null;
  readmeTruncated: boolean;
} {
  const none = { readme: null, readmePath: null, readmeTruncated: false };
  if (dir === undefined || dir === "") return none;
  for (const name of README_NAMES) {
    const candidate = join(dir, name);
    let stat;
    try {
      stat = statSync(candidate);
    } catch {
      continue; // not this one
    }
    if (!stat.isFile()) continue;
    try {
      const truncated = stat.size > README_MAX_BYTES;
      const buf = readFileSync(candidate);
      const text = truncated ? buf.subarray(0, README_MAX_BYTES).toString("utf8") : buf.toString("utf8");
      return { readme: text, readmePath: candidate, readmeTruncated: truncated };
    } catch {
      return none; // unreadable: report honestly rather than guessing
    }
  }
  return none;
}

/**
 * Is this settings entry the "disabled" spelling?
 *
 * Pi spells disabled as the object form with all four resource arrays EMPTY:
 * `applyPackageFilter` then adds every file with `enabled: false`, so nothing
 * loads, while the package stays installed on disk. An entry that pins a subset
 * is filtered, not disabled, and must not be reported as off.
 *
 * A missing array is treated as "no constraint on this type" (the SDK does the
 * same), so only an EXPLICIT empty array counts — an entry with `extensions: []`
 * alone disables extensions while leaving skills on, which is not a disable.
 */
function isEntryDisabled(entry: PackageEntryLike | undefined): boolean {
  if (entry === undefined || typeof entry === "string") return false;
  const kinds = [entry.extensions, entry.skills, entry.prompts, entry.themes];
  return kinds.every((k) => Array.isArray(k) && k.length === 0);
}

/**
 * The configured packages, each annotated with the resource kinds it
 * contributes and its own README, if it ships one.
 *
 * `resolve()` only reports resources for packages that are present on disk (an
 * uninstalled npm/git source contributes nothing yet). The README comes from
 * the install directory the SDK reports for that package.
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
  /*
   * The raw settings entries, by (scope, source). Read HERE rather than from the
   * SDK's `filtered` flag, which is true for any object-form entry and therefore
   * cannot distinguish "disabled" from "pins a subset".
   */
  const userEntries = deps.settings.getGlobalSettings().packages ?? [];
  const projectEntries = deps.settings.getProjectSettings().packages ?? [];
  const entryFor = (p: { source: string; scope: "user" | "project" }): PackageEntryLike | undefined => {
    const list = p.scope === "project" ? projectEntries : userEntries;
    return list.find((e) => (typeof e === "string" ? e : e.source) === p.source);
  };

  return configured.map((p) => ({
    source: p.source,
    scope: p.scope,
    resources: resolved ? resourcesForSource(resolved, p.source) : [],
    enabled: !isEntryDisabled(entryFor(p)),
    ...readPackageReadme(p.installedPath),
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

/**
 * Turn a configured package's resources on or off WITHOUT uninstalling it.
 *
 * Pi's only disable mechanism is the object form of a package entry with every
 * resource array empty: `applyPackageFilter` then adds all files with
 * `enabled: false`, so nothing loads while the code stays on disk. Enable writes
 * the plain string form back, which means "load everything".
 *
 * Distinguishing the two operations matters to the user: remove deletes the
 * code (npm uninstall / git clone removal) and cannot be undone offline, while
 * disable is a one-line settings flip that a restart reverses.
 *
 * Returns the package's new state, read back from the real listing rather than
 * assumed, so the UI reflects what Pi will actually load.
 */
export async function setPackageEnabled(
  deps: SurfaceDeps,
  source: string,
  scope: "user" | "project",
  enabled: boolean,
): Promise<PackageRecord> {
  const wanted = source.trim();
  if (wanted === "") throw new Error("package source is required");
  if (scope === "project" && !deps.settings.isProjectTrusted()) {
    throw new Error("project is not trusted; cannot write project settings");
  }

  const write = deps.settings as unknown as {
    setPackages?: (packages: PackageEntryLike[]) => void;
    setProjectPackages?: (packages: PackageEntryLike[]) => void;
  };
  const current =
    (scope === "project"
      ? deps.settings.getProjectSettings().packages
      : deps.settings.getGlobalSettings().packages) ?? [];

  const index = current.findIndex((e) => (typeof e === "string" ? e : e.source) === wanted);
  if (index < 0) {
    throw new Error(`package "${wanted}" is not configured at ${scope} scope`);
  }

  const next: PackageEntryLike[] = [...current];
  next[index] = enabled
    ? wanted
    : { source: wanted, extensions: [], skills: [], prompts: [], themes: [] };

  const setter = scope === "project" ? write.setProjectPackages : write.setPackages;
  if (typeof setter !== "function") {
    throw new Error("this settings manager cannot write package entries");
  }
  setter.call(deps.settings, next);
  // A write that never lands would make the switch look inverted on the next
  // listing, so flush before reporting success.
  await deps.settings.flush?.();

  /*
   * The new state is KNOWN here — it is what we just wrote — so it is reported
   * directly instead of re-listing.
   *
   * Re-listing looked safer but was worse in two ways: it costs a second
   * `resolve()` (which walks every package tree), and it can disagree with the
   * write when the package manager's own view lags the settings file, turning a
   * successful write into a bogus "disappeared after the settings write" error.
   * The other fields (resources, readme) still come from a real listing so the
   * caller gets an honest record.
   */
  const after = await listPackages(deps);
  const known = after.find((p) => p.source === wanted && p.scope === scope);
  return {
    source: wanted,
    scope,
    resources: known?.resources ?? [],
    enabled,
    readme: known?.readme ?? null,
    readmePath: known?.readmePath ?? null,
    readmeTruncated: known?.readmeTruncated ?? false,
  };
}
