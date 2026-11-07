import { platform as osPlatform, userInfo } from "node:os";

/**
 * Cross-platform local-IPC address resolution (plan/40).
 *
 * Node's `net` implements local IPC differently per OS:
 *   - **POSIX**: a filesystem Unix-domain socket — a `.sock` path under
 *     `~/.pi/remote/`. The file lingers if the owner crashes (stale-socket
 *     cleanup via `unlink` matters).
 *   - **Windows**: a **named pipe** (`\\.\pipe\<name>`). There is NO file —
 *     `existsSync`/`unlink` don't apply, and the pipe vanishes automatically
 *     when the owning process exits (so there's never a stale pipe to clean).
 *     Pipes are machine-global, so the name embeds the user to avoid collisions
 *     between two accounts on the same host.
 *
 * The `net` API itself (`createServer().listen(addr)`, `createConnection({ path:
 * addr })`, framing) is identical — only the address STRING and the lifecycle
 * (skip file cleanup on Windows) change. `platform`/`user` are injectable so
 * tests can exercise the win32 branch on a POSIX dev host.
 */

export type Plat = NodeJS.Platform;

/** True when local IPC uses named pipes (no socket files to manage). */
export function usesNamedPipe(plat: Plat = osPlatform()): boolean {
  return plat === "win32";
}

/** Keep a name component safe for a Windows pipe path. */
function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/**
 * Discriminator for a SECOND stack on the same machine (`REMOTE_PI_INSTANCE`).
 *
 * `REMOTE_PI_HOME` already isolates the state files, but the IPC names are not
 * derived from it: on Windows the pipe carries the suffix plus the user name
 * only, so two supervisors built from different homes collide on
 * `remote-pi-supervisor-<user>` and the second refuses to start. The same
 * collision reaches brokers and cwd locks, letting a child of instance B talk
 * to instance A's broker.
 *
 * Folding the instance into the ADDRESS keeps the stacks apart in every layer.
 * Unset → empty suffix → today's names, so existing installs are untouched.
 */
function instanceSuffix(): string {
  const raw = (process.env["REMOTE_PI_INSTANCE"] ?? "").trim();
  return raw === "" ? "" : `.${safe(raw)}`;
}

/**
 * Resolve a local-IPC address. On Windows returns a per-user named pipe
 * (`\\.\pipe\remote-pi-<suffix>-<user>`); on POSIX returns `filePath` (the
 * filesystem UDS path) unchanged.
 *
 * With `REMOTE_PI_INSTANCE` set, the instance is folded into the address on both
 * platforms (`…-supervisor.<instance>-<user>`, `supervisor.<instance>.sock`).
 */
export function ipcAddress(
  suffix: string,
  filePath: string,
  plat: Plat = osPlatform(),
  user?: string,
  instance: string = instanceSuffix(),
): string {
  if (plat === "win32") {
    const u = safe((user ?? userInfo().username) || "user");
    return `\\\\.\\pipe\\remote-pi-${safe(suffix)}${instance}-${u}`;
  }
  if (instance === "") return filePath;
  // POSIX: keep the `.sock` extension so existing globs/cleanup still match.
  const cut = filePath.lastIndexOf(".sock");
  if (cut < 0) return `${filePath}${instance}`;
  return `${filePath.slice(0, cut)}${instance}${filePath.slice(cut)}`;
}
