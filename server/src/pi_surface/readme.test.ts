/**
 * Package README reading (plugins feature).
 *
 * The user asked to read what a plugin does before installing or keeping it.
 * Nothing on the wire carried that, so the host now reads the package's own
 * README from the directory the SDK reports as its install location.
 *
 * These tests pin the two things that could go wrong:
 *   1. HONESTY — a package with no README must report `null`, never an empty
 *      string that the UI would render as a blank panel, and never a guess.
 *   2. SAFETY — only a fixed set of filenames inside the SDK-provided install
 *      directory is ever read. There is no client-supplied path, so the fence
 *      is that no other file can be named at all.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { listPackages, README_MAX_BYTES, type PackageManagerLike, type SurfaceDeps } from "./surface.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rp-readme-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Minimal deps: only `packages` matters for `listPackages`. */
function deps(overrides: Partial<PackageManagerLike> & { installedPaths?: Record<string, string> }): SurfaceDeps {
  const paths = overrides.installedPaths ?? {};
  const packages: PackageManagerLike = {
    resolve: async () => ({ extensions: [], skills: [], prompts: [], themes: [] }),
    listConfiguredPackages: () =>
      Object.entries(paths).map(([source, installedPath]) => ({
        source,
        scope: "user" as const,
        installedPath,
      })),
    installAndPersist: async () => {},
    removeAndPersist: async () => true,
    update: async () => {},
    ...overrides,
  };
  return {
    agentDir: root,
    cwd: root,
    settings: {
      getSkillPaths: () => [],
      setSkillPaths: () => {},
      getGlobalSettings: () => ({ packages: Object.keys(paths) }),
      getProjectSettings: () => ({ packages: [] }),
      setProjectSkillPaths: () => {},
      isProjectTrusted: () => true,
    },
    packages,
    loadSkillsFn: () => ({ skills: [] }),
  };
}

describe("package README", () => {
  test("reads README.md from the install directory", async () => {
    const dir = join(root, "pkg-a");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), "# Plugin A\n\nDoes a thing.\n");

    const [pkg] = await listPackages(deps({ installedPaths: { "npm:a@1": dir } }));
    expect(pkg?.readme).toBe("# Plugin A\n\nDoes a thing.\n");
    expect(pkg?.readmePath).toBe(join(dir, "README.md"));
    expect(pkg?.readmeTruncated).toBe(false);
  });

  test("prefers README.md, and falls back through the fixed candidate list", async () => {
    const dir = join(root, "pkg-b");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.txt"), "plain text readme");

    const [pkg] = await listPackages(deps({ installedPaths: { "npm:b@1": dir } }));
    expect(pkg?.readme).toBe("plain text readme");
  });

  test("reports null when the package ships no README", async () => {
    const dir = join(root, "pkg-c");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.js"), "// no readme here");

    const [pkg] = await listPackages(deps({ installedPaths: { "npm:c@1": dir } }));
    /* null, NOT "" — the UI must be able to say "not provided" instead of
       rendering an empty document that looks like a loading bug. */
    expect(pkg?.readme).toBeNull();
    expect(pkg?.readmePath).toBeNull();
    expect(pkg?.readmeTruncated).toBe(false);
  });

  test("reports null when the host does not know the install path", async () => {
    /* A configured-but-not-installed npm source: `installedPath` is undefined. */
    const packages: PackageManagerLike = {
      resolve: async () => ({ extensions: [], skills: [], prompts: [], themes: [] }),
      listConfiguredPackages: () => [{ source: "npm:missing@1", scope: "user" }],
      installAndPersist: async () => {},
      removeAndPersist: async () => true,
      update: async () => {},
    };
    const [pkg] = await listPackages(deps({ ...packages }));
    expect(pkg?.readme).toBeNull();
  });

  test("cuts an oversized README and flags it instead of refusing", async () => {
    const dir = join(root, "pkg-big");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), "x".repeat(README_MAX_BYTES + 5_000));

    const [pkg] = await listPackages(deps({ installedPaths: { "npm:big@1": dir } }));
    expect(pkg?.readmeTruncated).toBe(true);
    expect(pkg?.readme?.length).toBe(README_MAX_BYTES);
  });

  test("will not read a file outside the install directory", async () => {
    /* The fence: only fixed names inside the SDK-provided dir are tried. A file
       in the PARENT directory must never be picked up, even if it is called
       README.md, because nothing here accepts a client-supplied path. */
    const dir = join(root, "pkg-d");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, "README.md"), "SECRET parent readme");

    const [pkg] = await listPackages(deps({ installedPaths: { "npm:d@1": dir } }));
    /* null proves it read nothing at all; the explicit check below documents
       what must never appear even if that ever changes. */
    expect(pkg?.readme).toBeNull();
    expect(pkg?.readme ?? "").not.toContain("SECRET");
  });

  test("a directory named README.md is not a document", async () => {
    const dir = join(root, "pkg-e");
    mkdirSync(join(dir, "README.md"), { recursive: true });

    const [pkg] = await listPackages(deps({ installedPaths: { "npm:e@1": dir } }));
    expect(pkg?.readme).toBeNull();
  });

  test("one unreadable package does not break the listing of the others", async () => {
    const good = join(root, "pkg-good");
    mkdirSync(good, { recursive: true });
    writeFileSync(join(good, "README.md"), "fine");

    const packages: PackageManagerLike = {
      resolve: async () => ({ extensions: [], skills: [], prompts: [], themes: [] }),
      listConfiguredPackages: () => [
        { source: "npm:gone@1", scope: "user", installedPath: join(root, "does-not-exist") },
        { source: "npm:good@1", scope: "user", installedPath: good },
      ],
      installAndPersist: async () => {},
      removeAndPersist: async () => true,
      update: async () => {},
    };
    const out = await listPackages(deps({ ...packages }));
    expect(out).toHaveLength(2);
    expect(out[0]?.readme).toBeNull();
    expect(out[1]?.readme).toBe("fine");
  });
});
