/**
 * Plan/78 — host-side git working-tree snapshot for the web client's Changes
 * dock tab.
 *
 * ## What this is, and what it deliberately is not
 *
 * This reports STATUS, not content: which paths are staged, modified,
 * untracked or conflicted, plus a short branch/HEAD summary. It never returns
 * file bodies and never returns a diff.
 *
 * That line is drawn for one concrete reason: `fs_read` (plan/77) is fenced by
 * a positive allowlist — `plan/`, `.workflow/`, `docs/` only — precisely so a
 * pairing token cannot exfiltrate `~/.ssh/id_rsa` or `.env`. A diff is BY
 * DEFINITION the content of arbitrary files in the worktree, so adding a
 * `changes.diff` verb here would silently widen the same token's grant to
 * "every file you ever edited", which is exactly the hole `fs_read` refused to
 * open. The panel therefore answers "is this worktree safe to hand to an agent
 * right now, and which files are dirty" and stops there. Paths are repo-
 * RELATIVE and never absolute (same policy as the Plan panel, which strips to
 * basename for the same reason: a narrow dock needs the differing part, not the
 * host's directory layout).
 *
 * ## Failure is a first-class answer
 *
 * `4.1f` — the workspace used for every acceptance run in this repo — is not a
 * git repository. So "no changes" and "cannot tell" MUST be different replies:
 * collapsing them into an empty list would make the panel lie in exactly the
 * situation a user most needs the truth. Every failure is a closed enum the
 * client turns into its own fixed sentence; git's stderr is never forwarded.
 *
 * ## Why argv and never a shell
 *
 * All git invocations go through `execFile` with an argv array. A filename like
 * `$(touch pwned).txt` or `; rm -rf ~` is data in argv, not code, so the
 * injection surface is structurally zero rather than sanitised. The env is
 * scrubbed of `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` so a repo-local config
 * or a lingering environment cannot redirect the query at a different tree than
 * the workspace the user is actually looking at.
 */

import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Hard cap on entries handed to a paired device. */
export const CHANGES_MAX_ENTRIES = 200;

/** Per-command budget. A huge repo's `git status` can be slow; the panel must
 *  answer rather than hang the dock. */
const GIT_TIMEOUT_MS = 5_000;

/** Nothing git prints should ever approach this; it is a runaway guard. */
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

/** Why a snapshot could not be produced. Closed set: the client owns the copy. */
export type ChangesUnavailableReason =
  | "not_a_repo"
  | "git_missing"
  | "timeout"
  /* The workspace folder itself is gone (deleted, or an unmounted network drive).
   * Distinct from `git_missing`: git may be installed and fine, there is simply
   * nothing at that path. Saying "git is not installed" here would send the user
   * to install software to fix a missing directory. */
  | "workspace_missing"
  /* The repository IS there but could not be read: permissions, a dubious-owner
   * refusal, a locked index, a corrupt object store. Distinct from `not_a_repo`
   * because telling a user their folder is not a repository when it is one is a
   * lie about their own workspace. */
  | "unreadable";

/** One changed path. `x` is the index status, `y` the worktree status — the two
 *  porcelain columns, verbatim. They are single characters from git's own closed
 *  vocabulary (`. M A D R C U ? !`), not free text, so passing them through is
 *  not "echoing host prose". */
export interface ChangesEntry {
  /** Repo-relative path, forward-slashed. Never absolute. */
  rel: string;
  x: string;
  y: string;
  /** True when git renamed the path; `rel` is then the NEW name. */
  renamed: boolean;
}

export interface ChangesSnapshot {
  /** Always true here — a false value is expressed as a failure instead, so the
   *  client has exactly one shape to render. */
  is_repo: true;
  /** Short branch name, or null on a detached HEAD. */
  branch: string | null;
  /** Short HEAD sha (7 chars) and subject, or null on an unborn branch. */
  head: { sha7: string; subject: string } | null;
  ahead: number | null;
  behind: number | null;
  entries: ChangesEntry[];
  total: { staged: number; unstaged: number; untracked: number; conflicted: number };
  /** True when `entries` was cut at CHANGES_MAX_ENTRIES. `total` still counts
   *  everything, so the panel can say "showing 200 of N". */
  truncated: boolean;
}

export type ChangesResult =
  | { ok: true; snapshot: ChangesSnapshot }
  | { ok: false; reason: ChangesUnavailableReason };

/**
 * A scrubbed environment.
 *
 * `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` are removed rather than overridden
 * so a stray export cannot point the query at a tree other than `cwd`. Locks are
 * disabled because this is a read-only probe that must never make an editor or
 * a concurrent git command wait on it.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["GIT_DIR"];
  delete env["GIT_WORK_TREE"];
  delete env["GIT_INDEX_FILE"];
  delete env["GIT_OBJECT_DIRECTORY"];
  delete env["GIT_ALTERNATE_OBJECT_DIRECTORIES"];
  /* Deterministic, parseable output regardless of the user's global config. */
  env["GIT_OPTIONAL_LOCKS"] = "0";
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["LC_ALL"] = "C";
  return env;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: gitEnv(),
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
    encoding: "utf8",
  });
  return stdout;
}

/**
 * Maps a thrown exec error to the closed failure set.
 *
 * Every branch here answers a DIFFERENT user question, so the mapping must not
 * collapse them: "this folder is not a repository", "git is not installed",
 * "reading timed out" and "the repository exists but could not be read" are four
 * different facts. The last one is the trap — a permission failure, a dubious-
 * ownership refusal (`safe.directory`), a locked index or a corrupt repo all mean
 * the repo IS there and cannot be read, and reporting that as `unsupported` or
 * `not_a_repo` would tell the user something false about their folder.
 */
function classify(err: unknown): ChangesUnavailableReason {
  const e = err as {
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
    stderr?: unknown;
    message?: unknown;
    path?: unknown;
    syscall?: unknown;
  };
  /* Node's own timeout is `killed:true` + `signal:SIGTERM` + a null exit code,
   * not an ordinary non-zero exit — checking only `code` would misclassify it. */
  if (e?.killed === true || e?.signal === "SIGTERM" || e?.code === "ETIMEDOUT") return "timeout";
  const stderr = typeof e?.stderr === "string" ? e.stderr : "";
  const message = typeof e?.message === "string" ? e.message : "";
  /*
   * An ENOENT means TWO different things, and conflating them lies to the user.
   *
   * Node reports ENOENT both when the BINARY is absent and when the CWD does not
   * exist (measured: a deleted directory yields `reason: git_missing`, i.e. "this
   * host has no git installed" — false, git was right there). The discriminator is
   * `syscall`: `spawn git` with a missing cwd fails as `chdir`. So a chdir error is
   * "that folder is gone", and only a genuine binary lookup is `git_missing`.
   */
  if (e?.code === "ENOENT") {
    if (e?.syscall === "chdir" || /ENOENT.*chdir|chdir.*ENOENT/i.test(message)) return "workspace_missing";
    return "git_missing";
  }
  /* Only an explicit git statement that this is not a repository earns
   * `not_a_repo`. Anything else falls through to `unreadable`, which says the
   * truth: the repository could not be read, which is NOT the same as absent. */
  if (/(not a git repository|not a git repo)/i.test(stderr) || /(not a git repository|not a git repo)/i.test(message)) {
    return "not_a_repo";
  }
  if (/ENOENT/.test(message)) return "git_missing";
  return "unreadable";
}

/**
 * Parses `git status --porcelain=v1 -z`.
 *
 * `-z` is used rather than the newline form because it is the only one that is
 * unambiguous for paths containing spaces, quotes or newlines: entries are
 * NUL-separated, and a rename contributes TWO NUL-separated fields (the new name
 * follows the `XY` pair as a second field). Parsing the newline form would need
 * C-style unquoting, which is itself an injection-shaped problem.
 *
 * Exported for tests: this is the one place wire bytes become structure.
 */
export function parsePorcelainZ(raw: string, limit = CHANGES_MAX_ENTRIES): {
  entries: ChangesEntry[];
  total: ChangesSnapshot["total"];
  truncated: boolean;
} {
  const total = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
  const entries: ChangesEntry[] = [];
  const fields = raw.split("\0");
  let i = 0;
  while (i < fields.length) {
    const field = fields[i] ?? "";
    i += 1;
    /* Trailing empty field after the final NUL. */
    if (field.length < 4) continue;
    const x = field.slice(0, 1);
    const y = field.slice(1, 2);
    /* `field[2]` is the separator (a space in v1). */
    const rel = field.slice(3);
    if (rel === "") continue;

    const renamed = x === "R" || y === "R" || x === "C" || y === "C";
    if (renamed) {
      /* The ORIGINAL path follows as its own NUL-separated field. It is consumed
       * and discarded: showing both would double-count the entry, and the new
       * name is what exists on disk. */
      i += 1;
    }

    if (x === "?" || y === "?") total.untracked += 1;
    else if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) total.conflicted += 1;
    if (x !== " " && x !== "?" && x !== "!") total.staged += 1;
    if (y !== " " && y !== "?" && y !== "!") total.unstaged += 1;

    if (entries.length < limit) {
      entries.push({ rel: rel.split("\\").join("/"), x, y, renamed });
    }
  }
  return { entries, total, truncated: entries.length >= limit && total.staged + total.unstaged + total.untracked + total.conflicted > limit };
}

/**
 * Takes the snapshot for `cwd`.
 *
 * Every step is a separate git call so a failure can be attributed: a missing
 * binary and a non-repo abandon the whole thing, while the optional summary
 * fields (branch/head/ahead) degrade to null on their own without losing the
 * file list — a detached HEAD or an unborn branch is not a reason to hide the
 * dirty files the user asked about.
 */
export async function takeChangesSnapshot(cwd: string): Promise<ChangesResult> {
  /*
   * Probe cwd BEFORE shelling out.
   *
   * Node reports a missing binary and a missing working directory with the SAME
   * error (`code: ENOENT, syscall: "spawn git", path: "git"` — measured), so the
   * thrown error cannot tell them apart. Without this check a deleted workspace
   * would be reported as `git_missing`, telling the user to install git to fix a
   * folder that no longer exists. A stat is one syscall and removes the ambiguity
   * entirely.
   */
  try {
    if (!statSync(cwd).isDirectory()) return { ok: false, reason: "workspace_missing" };
  } catch {
    return { ok: false, reason: "workspace_missing" };
  }

  /* Cheapest decisive probe: `rev-parse --is-inside-work-tree` answers both
   * "is git installed" and "is this a repo". */
  try {
    const inside = (await git(cwd, ["rev-parse", "--is-inside-work-tree"])).trim();
    if (inside !== "true") return { ok: false, reason: "not_a_repo" };
  } catch (err) {
    return { ok: false, reason: classify(err) };
  }

  let statusRaw: string;
  try {
    statusRaw = await git(cwd, [
      "status",
      "--porcelain=v1",
      "-z",
      /* Untracked directories are reported collapsed; `normal` is the default
       * and the truthful one. `all` would explode a vendor/ tree into tens of
       * thousands of rows the dock cannot use. */
      "--untracked-files=normal",
      "--ignore-submodules=none",
    ]);
  } catch (err) {
    return { ok: false, reason: classify(err) };
  }

  const { entries, total, truncated } = parsePorcelainZ(statusRaw);

  /* Optional decorations. Each is independently best-effort. */
  let branch: string | null = null;
  try {
    const b = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    /* "HEAD" means detached; there is no branch name to show. */
    branch = b !== "" && b !== "HEAD" ? b : null;
  } catch { /* unborn branch: leave null */ }

  let head: ChangesSnapshot["head"] = null;
  try {
    const raw = await git(cwd, ["log", "-1", "--format=%h%x00%s"]);
    const [sha7, subject] = raw.replace(/\n$/, "").split("\0");
    if (typeof sha7 === "string" && sha7 !== "" && typeof subject === "string") {
      head = { sha7: sha7.slice(0, 12), subject: subject.slice(0, 120) };
    }
  } catch { /* no commits yet: leave null */ }

  let ahead: number | null = null;
  let behind: number | null = null;
  try {
    const raw = (await git(cwd, ["rev-list", "--count", "--left-right", "@{upstream}...HEAD"])).trim();
    const [bStr, aStr] = raw.split("\0").length === 2 ? raw.split("\0") : raw.split(/\s+/);
    const b = Number(bStr);
    const a = Number(aStr);
    if (Number.isFinite(b) && Number.isFinite(a)) { behind = b; ahead = a; }
  } catch { /* no upstream configured: leave null */ }

  return {
    ok: true,
    snapshot: {
      is_repo: true,
      branch,
      head,
      ahead,
      behind,
      entries,
      total,
      truncated,
    },
  };
}
