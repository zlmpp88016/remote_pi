/* Pure remote-path helpers for the Remote Pi web shell.
 *
 * These functions exist for ONE job: turning the host's own answers into the
 * next `fs_list` request without ever inventing a filesystem fact.
 *
 *   • the host (plan 68 `fs_nav.handleFsList`) is the ONLY canonicalizer — it
 *     expands `~`, runs `realpath` and returns the authoritative `path` +
 *     `parent`. The browser never resolves anything.
 *   • so a descent is `joinRemotePath(hostCanonicalDir, entry.name)`: the
 *     canonical directory the host reported, plus the DIRECT child name the
 *     host reported. No listing string is concatenated by hand, no relative
 *     path is expanded here, and `..` is never computed from a display value.
 *   • `remoteParent` is the pure fallback for a root/null guard (a root has no
 *     parent), never a replacement for the host's `parent` field.
 *
 * String-only, no I/O, no `node:path` (which would import the LOCAL platform
 * separator and silently disagree with a POSIX host driven from Windows or a
 * Windows host driven from the browser).
 */

/** A separator is chosen from the parent the host gave us. A path with a
 *  backslash and no forward slash is a native Windows/UNC form; anything with
 *  a forward slash (POSIX, `//server/share`, `C:/x`) keeps forward slashes. */
export function remoteSeparator(parent: string): "/" | "\\" {
  const back = parent.includes("\\");
  const forward = parent.includes("/");
  if (forward) return "/";
  if (back) return "\\";
  return "/";
}

/** Native UNC form (`\\server\share`, `\\server`). */
const UNC_BACKSLASH = /^\\\\/;
/** POSIX-rooted or `//server/share` form. */
const UNC_FORWARD = /^\/\//;
/** `C:\` / `C:/` — a drive with a root separator. */
const DRIVE_ROOTED = /^[A-Za-z]:[\\/]/;
/** `C:` — a bare drive letter, treated as that drive's root for joining. */
const DRIVE_BARE = /^[A-Za-z]:$/;

/**
 * True when `path` is absolute *for the host's own family*: a POSIX root, a
 * forward-slash UNC share, a `C:\` drive root, or a native `\\server\share`.
 * Used only to refuse a double join (`/a` + `/b`), never to resolve a path.
 */
export function remoteIsAbsolute(path: string): boolean {
  if (path === "") return false;
  return (
    path.startsWith("/") ||
    UNC_BACKSLASH.test(path) ||
    DRIVE_ROOTED.test(path)
  );
}

/**
 * The visible parent of a remote path, or `null` when there is none (a root).
 *
 * `null` is returned for: `""`, `"/"`, `"\\"`, `"C:"`, `"C:\"`, `"~"`, a
 * relative leaf with no separator (`"name"`), a native UNC share root
 * (`"//server/share"`, `"\\server\share"`) and a bare UNC server
 * (`"\\server"`). The host's `fs_list_ok.parent` stays AUTHORITATIVE; this is
 * the pure fallback when only a path is known.
 */
export function remoteParent(path: string): string | null {
  if (path === "") return null;

  if (UNC_BACKSLASH.test(path) || UNC_FORWARD.test(path)) {
    const native = UNC_BACKSLASH.test(path);
    const sep = native ? "\\" : "/";
    let p = path;
    while (p.length > 2 && (p.endsWith("/") || p.endsWith("\\"))) p = p.slice(0, -1);
    const parts = p.slice(2).split(/[\\/]/).filter((part) => part !== "");
    // `\\server` / `\\server\share` are share roots: nothing above them here.
    if (parts.length <= 2) return null;
    const head = parts.slice(0, parts.length - 1).join(sep);
    return native ? `\\\\${head}` : `//${head}`;
  }

  const sep = remoteSeparator(path);
  let p = path;
  while (p.length > 1 && p.endsWith(sep)) p = p.slice(0, -1);

  if (p === "/" || p === "\\") return null;
  if (DRIVE_BARE.test(p)) return null;

  if (sep === "\\") {
    const idx = p.lastIndexOf("\\");
    if (idx < 0) return null;
    if (idx === 2 && DRIVE_ROOTED.test(p)) return p.slice(0, 3); // "C:\a" → "C:\"
    if (idx === 0) return null;
    return p.slice(0, idx);
  }

  const idx = p.lastIndexOf("/");
  if (idx < 0) return null;
  if (idx === 0) return "/";
  return p.slice(0, idx);
}

/**
 * Join a host-canonical directory with a DIRECT child name (`entry.name` from
 * `fs_list_ok`). Preserves the parent's family and never doubles a separator:
 *
 *   ("/", "usr")            → "/usr"          (POSIX root keeps one slash)
 *   ("/usr/", "bin")        → "/usr/bin"      (trailing separator preserved)
 *   ("C:", "Users")         → "C:\Users"      (bare drive = drive root)
 *   ("C:\Users", "jacob")   → "C:\Users\jacob"
 *   ("C:/Users", "jacob")   → "C:/Users/jacob" (style kept as given)
 *   ("\\srv\share", "a")    → "\\srv\share\a" (native UNC)
 *   ("//srv/share", "a")    → "//srv/share/a"
 *   ("", "x")               → "x"             (nothing to join yet)
 *   ("~", "projects")       → "~/projects"
 *
 * An already-absolute child is returned UNCHANGED (the host-absolute path
 * wins) and an empty child returns the parent, so a stale row can never turn
 * into `/usr//` or `C:\C:\x`.
 */
export function joinRemotePath(parent: string, name: string): string {
  if (name === "") return parent;
  if (remoteIsAbsolute(name)) return name;
  if (parent === "") return name;
  if (DRIVE_BARE.test(parent)) return `${parent}\\${name}`;
  if (parent.endsWith("/") || parent.endsWith("\\")) return `${parent}${name}`;
  return `${parent}${remoteSeparator(parent)}${name}`;
}
