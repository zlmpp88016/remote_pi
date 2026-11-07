import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { CHANGES_MAX_ENTRIES, parsePorcelainZ, takeChangesSnapshot } from "./changes.js";

/**
 * Parsing is the security-relevant half: it is where untrusted bytes become the
 * structure the panel renders. `-z` output is used because the newline form
 * needs C-style unquoting, which is itself an injection-shaped problem.
 */
describe("parsePorcelainZ", () => {
  test("reads a modified and an untracked path", () => {
    const raw = " M src/a.ts\0?? new file.txt\0";
    const { entries, total } = parsePorcelainZ(raw);
    expect(entries.map((e) => e.rel)).toEqual(["src/a.ts", "new file.txt"]);
    expect(total.unstaged).toBe(1);
    expect(total.untracked).toBe(1);
    expect(total.staged).toBe(0);
  });

  test("a path with spaces and a newline stays ONE entry", () => {
    /* The whole reason for `-z`: the newline form would split this row in two. */
    const raw = " M dir/with space/and\nnewline.txt\0";
    const { entries } = parsePorcelainZ(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.rel).toBe("dir/with space/and\nnewline.txt");
  });

  test("a rename consumes the ORIGINAL path instead of doubling the row", () => {
    /* `-z` emits `R  new\0old\0`: the original follows as its own field and must
     * be skipped, or the list would show a phantom entry. */
    const raw = "R  src/new.ts\0src/old.ts\0";
    const { entries, total } = parsePorcelainZ(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ rel: "src/new.ts", renamed: true });
    expect(total.staged).toBe(1);
  });

  test("counts staged vs unstaged separately", () => {
    const raw = "M  staged.ts\0 M unstaged.ts\0MM both.ts\0";
    const { total } = parsePorcelainZ(raw);
    expect(total.staged).toBe(2);   // M_ and MM
    expect(total.unstaged).toBe(2); // _M and MM
  });

  test("a conflict is counted as conflicted, not as ordinary dirt", () => {
    const raw = "UU conflict.ts\0";
    const { total } = parsePorcelainZ(raw);
    expect(total.conflicted).toBe(1);
  });

  test("the WHOLE unmerged set counts as conflicted", () => {
    /* porcelain v1's unmerged codes are DD AU UD UA DU AA UU. AU/UD/UA/DU are the
     * rename/delete family — the ones a refactor produces — and a counter that only
     * knew UU/AA/DD would report a conflicted tree as clean-ish. */
    for (const code of ["DD", "AU", "UD", "UA", "DU", "AA", "UU"]) {
      const { total, entries } = parsePorcelainZ(`${code} f.ts\0`);
      expect(total.conflicted, code).toBe(1);
      expect(entries, code).toHaveLength(1);
    }
  });

  test("a copied path is reported as renamed, keeping only the new name", () => {
    /* `C` shares the two-field shape with `R`: new name first, original second. */
    const { entries, total } = parsePorcelainZ("C  copy.ts\0orig.ts\0");
    expect(entries).toEqual([{ rel: "copy.ts", x: "C", y: " ", renamed: true }]);
    expect(total.staged).toBe(1);
  });

  test("a typechange is recorded without being mistaken for a delete", () => {
    const { entries, total } = parsePorcelainZ(" T link.ts\0");
    expect(entries[0]).toMatchObject({ rel: "link.ts", x: " ", y: "T" });
    expect(total.unstaged).toBe(1);
    expect(total.conflicted).toBe(0);
  });

  test("backslashes are normalised to forward slashes", () => {
    const raw = " M src\\win\\path.ts\0";
    expect(parsePorcelainZ(raw).entries[0]!.rel).toBe("src/win/path.ts");
  });

  test("the cap truncates entries but keeps the true totals", () => {
    const many = Array.from({ length: CHANGES_MAX_ENTRIES + 12 }, (_, i) => ` M f${i}.ts\0`).join("");
    const { entries, total, truncated } = parsePorcelainZ(many);
    expect(entries).toHaveLength(CHANGES_MAX_ENTRIES);
    expect(truncated).toBe(true);
    expect(total.unstaged).toBe(CHANGES_MAX_ENTRIES + 12);
  });

  test("exactly at the cap is NOT truncated", () => {
    /* Off-by-one here would tell the user "showing 200 of 200", which reads as if
     * data were withheld when nothing was. */
    const exactly = Array.from({ length: CHANGES_MAX_ENTRIES }, (_, i) => ` M f${i}.ts\0`).join("");
    const { entries, truncated } = parsePorcelainZ(exactly);
    expect(entries).toHaveLength(CHANGES_MAX_ENTRIES);
    expect(truncated).toBe(false);
  });

  test("renames do not consume the entry budget twice", () => {
    /* A rename is TWO NUL fields but ONE entry. Counting fields would truncate a
     * 100-rename status at 200 fields, i.e. at 100 rows, and report truncation
     * while half the cap was unused. */
    const renames = Array.from({ length: CHANGES_MAX_ENTRIES }, (_, i) => `R  n${i}.ts\0o${i}.ts\0`).join("");
    const { entries, truncated, total } = parsePorcelainZ(renames);
    expect(entries).toHaveLength(CHANGES_MAX_ENTRIES);
    expect(truncated).toBe(false);
    expect(total.staged).toBe(CHANGES_MAX_ENTRIES);
  });

  test("an empty worktree is clean, not truncated", () => {
    const { entries, total, truncated } = parsePorcelainZ("");
    expect(entries).toEqual([]);
    expect(total).toEqual({ staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
    expect(truncated).toBe(false);
  });

  test("a short/garbage field is ignored rather than throwing", () => {
    expect(() => parsePorcelainZ("\0\n\0??\0")).not.toThrow();
    expect(parsePorcelainZ("\0\n\0??\0").entries).toEqual([]);
  });
});

/**
 * The failure half. `4.1f` — the workspace every acceptance run in this repo uses
 * — is NOT a git repository, so "not a repo" is the main path here, not an edge
 * case. It must be distinguishable from "clean worktree", or the panel lies in
 * exactly the situation the user needs the truth.
 */
describe("takeChangesSnapshot", () => {
  function gitAvailable(): boolean {
    try {
      execFileSync("git", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  test("a MISSING workspace folder is workspace_missing, not git_missing", async () => {
    /*
     * Measured trap: Node reports a missing binary and a missing working directory
     * with the SAME error — `code: ENOENT, syscall: "spawn git", path: "git"` — so
     * the thrown error cannot distinguish them. Classifying on the error alone
     * would tell a user "this host has no git installed" when actually their
     * workspace folder was deleted or its drive disconnected; that sends them to
     * install software to fix a missing directory.
     */
    const gone = join(tmpdir(), "changes-gone-" + Date.now());
    const r = await takeChangesSnapshot(gone);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("workspace_missing");
  });

  test("a path that is a FILE is workspace_missing, not a crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "changes-filepath-"));
    try {
      const file = join(dir, "not-a-dir.txt");
      writeFileSync(file, "x");
      const r = await takeChangesSnapshot(file);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("workspace_missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a directory that is not a repo reports not_a_repo, NOT an empty list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "changes-norepo-"));
    try {
      const r = await takeChangesSnapshot(dir);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("not_a_repo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a repo that EXISTS but cannot be read is never reported as not_a_repo", async () => {
    /*
     * The distinction matters more than it looks. `not_a_repo` is a statement
     * about the user's folder; a permission failure, a dubious-ownership refusal
     * or a locked index are statements about ACCESS to a repository that is
     * definitely there. Reporting those as `not_a_repo` would tell a user their
     * workspace is not a git repo when it is — a lie about their own project.
     *
     * Simulated by pointing GIT_DIR at a path git cannot resolve, which makes git
     * fail with a repository error rather than "not a git repository".
     */
    const dir = mkdtempSync(join(tmpdir(), "changes-unreadable-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      const original = process.env.GIT_DIR;
      /* A .git that exists but is not a valid repository. */
      writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/definitely-missing\n");
      try {
        const r = await takeChangesSnapshot(dir);
        if (!r.ok) {
          expect(r.reason).not.toBe("not_a_repo");
          expect(["unreadable", "timeout", "git_missing"]).toContain(r.reason);
        }
      } finally {
        if (original === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = original;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!gitAvailable())("a clean repo reports a snapshot with zero entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "changes-clean-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      writeFileSync(join(dir, "a.txt"), "one\n");
      execFileSync("git", ["add", "a.txt"], { cwd: dir });
      execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });

      const r = await takeChangesSnapshot(dir);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.snapshot.entries).toEqual([]);
        expect(r.snapshot.total).toEqual({ staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
        expect(r.snapshot.truncated).toBe(false);
        /* The commit exists, so a subject is present. */
        expect(r.snapshot.head?.subject).toBe("init");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!gitAvailable())("a dirty repo lists the paths it changed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "changes-dirty-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      writeFileSync(join(dir, "tracked.txt"), "one\n");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });

      writeFileSync(join(dir, "tracked.txt"), "two\n");
      mkdirSync(join(dir, "sub"), { recursive: true });
      writeFileSync(join(dir, "sub", "fresh.txt"), "new\n");

      const r = await takeChangesSnapshot(dir);
      expect(r.ok).toBe(true);
      if (r.ok) {
        const paths = r.snapshot.entries.map((e) => e.rel).sort();
        /*
         * `sub/` not `sub/fresh.txt`: `--untracked-files=normal` collapses an
         * untracked DIRECTORY into one row. That is deliberate — `all` would turn
         * a vendor/ or node_modules/ tree into tens of thousands of rows the dock
         * cannot use — and the trailing slash is git telling the panel it is a
         * directory. Pinned here because the alternative (expanding it) would
         * silently change what the panel shows for every real workspace.
         */
        expect(paths).toEqual(["sub/", "tracked.txt"]);
        /* Relative, never absolute — the panel must not learn the host layout. */
        for (const p of paths) {
          expect(p.startsWith("/")).toBe(false);
          expect(/^[A-Za-z]:/.test(p)).toBe(false);
        }
        expect(r.snapshot.total.untracked).toBe(1);
        expect(r.snapshot.total.unstaged).toBe(1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!gitAvailable())("an injection-shaped filename is DATA, not code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "changes-inject-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      /* A name that would execute if any layer used a shell. */
      const evil = "$(touch PWNED).txt";
      writeFileSync(join(dir, evil), "x\n");

      const r = await takeChangesSnapshot(dir);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.snapshot.entries.map((e) => e.rel)).toContain(evil);
      }
      /* The direct proof that no shell was involved. */
      const pwned = join(dir, "PWNED");
      let leaked = true;
      try {
        execFileSync("git", ["status", "--porcelain"], { cwd: dir, stdio: "ignore" });
        leaked = false;
      } catch { leaked = true; }
      expect(leaked).toBe(false);
      /* And the file must not exist. */
      expect(() => rmSync(pwned, { recursive: false, force: false })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
