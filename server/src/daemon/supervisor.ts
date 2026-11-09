import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { addDaemon, listDaemons, migrateRegistryNames, removeDaemon } from "./registry.js";
import { addWorkspace, listWorkspaces, removeWorkspace } from "./workspaces.js";
import { daemonIdForCwd } from "./id.js";
import { defaultAgentName, type LocalConfig } from "../session/local_config.js";
import { resolvePublicRelayUrl } from "../config.js";
import { ipcAddress, usesNamedPipe } from "../session/ipc.js";
import {
  EXIT_DAEMON_FRESH_SESSION,
  EXIT_DAEMON_LOCK_HELD,
  EXIT_DAEMON_SWITCH_SESSION,
  RpcChild,
  type RpcChildExitEvent,
  type RpcChildOptions,
} from "./rpc_child.js";
import {
  type ControlReply,
  type ControlRequest,
  type CronJobView,
  type DaemonInfo,
  encodeReply,
  parseRequest,
} from "./control_protocol.js";
import { Cron } from "croner";
import {
  addJob as addCronJob,
  getJob as getCronJob,
  listJobs as listCronJobs,
  nextRunFor,
  recordRun,
  removeJob as removeCronJob,
  setJobEnabled,
  validateSchedule,
  type CronJob,
  type NewJobInput,
} from "./cron_registry.js";
import { appendCronLog, readCronLog, type CronResult } from "./cron_log.js";
import { HostBridge, deliverSseReply } from "./host_bridge.js";
import { hostSessionName, type FleetEntry, type FleetOps } from "./host_control.js";
import { roomIdFor } from "../rooms.js";
import type { RelayRoomInfo } from "../transport/embedded_relay.js";
import { HostPairingSession } from "../pairing/host_pairing.js";
import { buildQRUri } from "../pairing/qr.js";
import { getOrCreateEd25519Keypair } from "../pairing/storage.js";
import { HOST_ROOM_ID, SCHEDULE_PREVIEW_CHARS } from "../protocol/types.js";
import type { HostPairingRecord } from "../pairing/host_pairing.js";

/**
 * Central process that owns the daemon fleet (plan/26).
 *
 * Responsibilities:
 *   - Spawn one `pi --mode rpc` child per registry entry. Track them in
 *     `_children: Map<id, RpcChild>`.
 *   - Auto-restart crashed children with exponential backoff
 *     (1s, 5s, 30s, 5min). Give up after 4 attempts to avoid log spam
 *     when the agent is misconfigured.
 *   - Listen on `~/.pi/remote/supervisor.sock` for `ControlRequest`s from
 *     the `remote-pi` CLI. Each connection: 1 request → 1 reply → close.
 *   - Graceful shutdown on SIGTERM/SIGINT: stop all children + unlink
 *     the UDS file so a next supervisor can bind cleanly.
 *
 * The supervisor itself is the only long-running process the user
 * installs as a system service (plan/26 W3 will generate the unit/plist).
 * If it crashes, systemd/launchd restarts it; on restart it re-reads
 * the registry and re-spawns everything.
 */

const SUPERVISOR_SOCK_NAME = "supervisor.sock";

/** Backoff schedule for auto-restart after a crash. After exhausting, the
 *  child stays in `crashed` state until manual `restart_all` or fresh
 *  registry add. Keeps logs sane when the agent dies on every boot. */
const RESTART_BACKOFFS_MS = [1_000, 5_000, 30_000, 5 * 60_000];

function supervisorSockPath(): string {
  const root = process.env["REMOTE_PI_HOME"] || homedir();
  // POSIX → ~/.pi/remote/supervisor.sock; Windows → per-user named pipe (plan/40).
  return ipcAddress("supervisor", join(root, ".pi", "remote", SUPERVISOR_SOCK_NAME));
}

/** Thrown by `start()` when another live supervisor already holds the UDS.
 *  Prevents a second supervisor from orphaning the first's children. */
export class SupervisorAlreadyRunningError extends Error {
  constructor(public readonly sockPath: string) {
    super(
      `Another pi-supervisord is already running (UDS held at ${sockPath}). ` +
      "Refusing to start a second instance. Use `remote-pi-server daemon …` to control it, " +
      "or stop the running one first.",
    );
    this.name = "SupervisorAlreadyRunningError";
  }
}

/** Probes whether a live supervisor is accepting connections on `path`.
 *  Resolves true if the connect succeeds (a listener is there), false on
 *  ECONNREFUSED / ENOENT (stale socket file from a crashed supervisor). */
function _probeSupervisor(path: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sock = createConnection({ path });
    const done = (alive: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => done(false), 1_000);
    sock.once("connect", () => { clearTimeout(timer); done(true); });
    sock.once("error", () => { clearTimeout(timer); done(false); });
  });
}

export interface SupervisorOptions {
  /** Absolute path to remote-pi's dist/index.js — passed as -e to each
   *  spawned `pi`. Defaults to the location relative to where this file
   *  is bundled (so the supervisor finds itself). */
  extensionPath: string;
  /** Override the `pi` binary path. Defaults to "pi" on PATH. */
  piBin?: string;
  /** Plan/67 — skip the host-room relay (unit tests / offline). */
  skipHost?: boolean;
  /** Plan/69 — inject the HostBridge (tests). Defaults to a fresh one bound
   *  to this supervisor's fleet + pairing; `skipHost` still suppresses it. */
  host?: HostBridge;
  /** Plan/69 — override the host pairing-token store (tests). Defaults to a
   *  fresh `HostPairingSession` bound to `~/.pi/remote/pairing.json`. */
  pairing?: HostPairingSession;
}

/** Pure decision for `fireJob` (plan/39) — picks the action from the daemon's
 *  liveness/busy state + the job's flags. Tested in isolation for all 4 ramos. */
export type FireAction = "send" | "wake_and_send" | "skip_down" | "skip_busy";
export function decideFireAction(o: {
  running: boolean;
  busy: boolean;
  wake: boolean;
  skipIfBusy: boolean;
}): FireAction {
  if (!o.running) return o.wake ? "wake_and_send" : "skip_down";
  if (o.skipIfBusy && o.busy) return "skip_busy";
  return "send";
}

interface ChildSlot {
  id: string;
  cwd: string;
  child: RpcChild;
  restartTimer: ReturnType<typeof setTimeout> | null;
  restartAttempt: number;
  /** Plan/69 — reason of the most recent crash, pushed verbatim in
   *  `workspace_state.last_error` (never fabricated). Cleared on a fresh
   *  spawn: a running workspace carries no current error. */
  lastError: string | null;
}

export class Supervisor {
  private server: Server | null = null;
  private readonly children = new Map<string, ChildSlot>();
  /** Live croner schedules, keyed by cron job id (plan/39). */
  private readonly cronJobs = new Map<string, Cron>();
  private shuttingDown = false;
  /** Plan/67 — always-on relay room `host`. */
  private host: HostBridge | null = null;
  /** Plan/69 — the daemon-side pairing token (`~/.pi/remote/pairing.json`).
   *  Owned by the supervisor (NOT by any Pi process) so `remote-pi-server pair`
   *  works with zero Pi running; shared with the HostBridge, which consumes
   *  it on the host room. */
  private readonly pairing: HostPairingSession;

  constructor(private readonly opts: SupervisorOptions) {
    this.pairing = opts.pairing ?? new HostPairingSession();
  }

  /** Bind the control UDS + spawn all registered daemons. */
  async start(): Promise<void> {
    this._mkdirParent();
    // Backfill folder-derived names into legacy registry entries (pre-name
    // field) so every daemon has a stable name to inject via env.
    migrateRegistryNames();
    await this._bindUds();
    this._spawnAllFromRegistry();
    // Cron (plan/39): schedule all enabled jobs, then run any missed catchup.
    this._reconcileCron();
    this._runCatchup();
    if (!this.opts.skipHost) {
      /*
       * Plan/76 — `localPeer` is this supervisor's OWN public key. The in-process
       * SSE endpoint dials with the same identity (see `sse_endpoint.ts`), so the
       * host room must treat it as local rather than as an unknown device. It is
       * passed unconditionally: an SSE stream can only reach the relay when
       * `direct.ts` started one, and that path is loopback-bound.
       */
      const localKeypair = await getOrCreateEd25519Keypair();
      const localPeer = Buffer.from(localKeypair.publicKey).toString("base64");
      this.host =
        this.opts.host ??
        new HostBridge({
          fleet: this._fleetOps(),
          pairing: this.pairing,
          localPeer,
          /*
           * Plan/76 phase two: hand browser replies straight to their SSE stream
           * instead of pushing them through the relay to be routed back here.
           *
           * This sink DECLINES any peer it does not own (`deliverToPeer` returns
           * false for a WebSocket client), and `_reply` then falls through to the
           * relay. That fallback is essential: desktop, mobile and CLI clients
           * still speak raw WebSocket, and claiming their replies here would
           * black-hole every one of them.
           *
           * Child-daemon IPC is untouched: `_forwardToChild` still uses the relay
           * and `_isOwnKeyInbound` keeps its inference.
           */
          replySink: { deliver: deliverSseReply },
        });
      void this.host.start().catch((err) => {
        process.stderr.write(`[pi-supervisord] host room failed: ${String(err)}\n`);
      });
    }
  }

  /** Graceful shutdown: stop all children, close UDS. */
  async stop(): Promise<void> {
    this.shuttingDown = true;
    await this.host?.stop();
    this.host = null;
    // Stop all cron schedules (plan/39) so no fire races with teardown.
    for (const c of this.cronJobs.values()) c.stop();
    this.cronJobs.clear();
    // Cancel pending restart timers first so they don't race with stop().
    for (const slot of this.children.values()) {
      if (slot.restartTimer !== null) {
        clearTimeout(slot.restartTimer);
        slot.restartTimer = null;
      }
    }
    await Promise.all([...this.children.values()].map((s) => s.child.stop()));
    this.children.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
    // Best-effort: clear the socket file so a next supervisor bind succeeds.
    // Windows named pipes have no file (auto-removed on exit) → nothing to do.
    if (!usesNamedPipe()) {
      try { unlinkSync(supervisorSockPath()); } catch { /* ignored */ }
    }
  }

  // ── UDS binding ──────────────────────────────────────────────────────────

  private _mkdirParent(): void {
    // A named pipe has no parent directory to create (the addr is `\\.\pipe\…`).
    if (usesNamedPipe()) return;
    mkdirSync(dirname(supervisorSockPath()), { recursive: true });
  }

  private async _bindUds(): Promise<void> {
    const path = supervisorSockPath();
    const pipe = usesNamedPipe();
    // Single-instance guard. PROBE first: a live supervisor answering the
    // connect means we must NOT start a second one. Stealing the socket
    // (unlink + bind) would orphan the running supervisor's children — they'd
    // keep running, unreachable by the CLI. Only on POSIX, when the probe
    // fails (stale socket from a crash), do we unlink + bind. On Windows there
    // is no file: always probe, never unlink (the pipe self-cleans on exit).
    if (pipe || existsSync(path)) {
      const alive = await _probeSupervisor(path);
      if (alive) {
        throw new SupervisorAlreadyRunningError(path);
      }
      if (!pipe) {
        try { unlinkSync(path); } catch { /* will throw on bind if still held */ }
      }
    }
    const server = createServer((socket) => this._onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => resolve());
    });
    this.server = server;
  }

  private _onConnection(socket: Socket): void {
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      // Single request per connection; ignore anything past the newline.
      void this._handleRequest(line)
        .then((reply) => socket.end(encodeReply(reply)))
        .catch((err) => socket.end(encodeReply<unknown>({ ok: false, error: String(err) })));
    });
    socket.on("error", () => { /* client hung up; nothing to do */ });
  }

  // ── Request dispatch ─────────────────────────────────────────────────────

  private async _handleRequest(line: string): Promise<ControlReply<unknown>> {
    let req: ControlRequest;
    try { req = parseRequest(line); }
    catch (e) { return { ok: false, error: (e as Error).message }; }

    switch (req.op) {
      case "list":         return { ok: true, data: { daemons: this._listInfo() } };
      case "status":       return { ok: true, data: { daemons: this._listInfo() } };
      case "start_all":    return this._opStartAll();
      case "start":        return this._opStart(req.id);
      case "stop_all":     return this._opStopAll();
      case "stop":         return this._opStop(req.id);
      case "restart_all":  return this._opRestartAll();
      case "restart":      return this._opRestart(req.id);
      case "send":         return this._opSend(req.id, req.text);
      case "register":     return this._opRegister(req.cwd);
      case "unregister":   return this._opUnregister(req.id);
      case "cron_add":     return this._opCronAdd(req);
      case "cron_list":    return this._opCronList();
      case "cron_remove":  return this._opCronRemove(req.job_id);
      case "cron_enable":  return this._opCronEnable(req.job_id, req.enabled);
      case "cron_run":     return this._opCronRun(req.job_id);
      case "cron_log":     return this._opCronLog(req.job_id, req.tail);
      case "pair_show":    return this._opPairShow(req.ephemeral);
      case "pair_rotate":  return this._opPairRotate(req.ephemeral);
      default: {
        const unknown = (req as { op: string }).op;
        return { ok: false, error: `unknown op: ${unknown}` };
      }
    }
  }

  // ── Op handlers ──────────────────────────────────────────────────────────

  private _listInfo(): DaemonInfo[] {
    const registry = listDaemons();
    return registry.map((entry) => {
      const slot = this.children.get(entry.id);
      const name = entry.name ?? defaultAgentName(entry.cwd);
      const info: DaemonInfo = {
        id: entry.id,
        cwd: entry.cwd,
        name,
        state: slot?.child.state ?? "stopped",
      };
      if (slot) {
        if (slot.child.pid !== undefined) info.pid = slot.child.pid;
        if (slot.child.uptimeMs !== undefined) info.uptime_s = Math.floor(slot.child.uptimeMs / 1000);
        info.restart_count = slot.child.restartCount;
      }
      return info;
    });
  }

  private _opStartAll(): ControlReply<unknown> {
    const started: string[] = [];
    const already: string[] = [];
    for (const entry of listDaemons()) {
      const slot = this.children.get(entry.id);
      if (slot && slot.child.state === "running") {
        already.push(entry.id);
        continue;
      }
      this._spawnEntry(entry.id, entry.cwd);
      started.push(entry.id);
    }
    return { ok: true, data: { started, already_running: already } };
  }

  /** Spawn a single registered daemon by id. Idempotent: a daemon already
   *  running returns `started: false`. Unknown id → ok:false. This is what
   *  `/remote-pi create` calls so a freshly-registered folder boots its Pi
   *  immediately instead of waiting for the next supervisor restart. */
  private _opStart(id: string): ControlReply<unknown> {
    const entry = listDaemons().find((d) => d.id === id);
    if (!entry) return { ok: false, error: `no daemon with id ${id}` };
    const slot = this.children.get(id);
    if (slot && slot.child.state === "running") {
      return { ok: true, data: { id, state: slot.child.state, started: false } };
    }
    this._spawnEntry(entry.id, entry.cwd, entry.name);
    const state = this.children.get(id)?.child.state ?? "starting";
    return { ok: true, data: { id, state, started: true } };
  }

  private async _opStopAll(): Promise<ControlReply<unknown>> {
    const stopped: string[] = [];
    const already: string[] = [];
    for (const [id, slot] of this.children) {
      if (slot.child.state !== "running") {
        already.push(id);
        continue;
      }
      if (slot.restartTimer !== null) {
        clearTimeout(slot.restartTimer);
        slot.restartTimer = null;
      }
      await slot.child.stop();
      stopped.push(id);
    }
    return { ok: true, data: { stopped, already_stopped: already } };
  }

  /**
   * Plan/68 — resolve an id to a cwd across both catalogs. `daemons.json`
   * wins when a cwd appears in both, mirroring `_catalogEntries`.
   */
  private _findEntry(id: string): { id: string; cwd: string; name: string } | undefined {
    const daemon = listDaemons().find((d) => d.id === id);
    if (daemon) return daemon;
    const ws = listWorkspaces().find((w) => daemonIdForCwd(w.cwd) === id);
    return ws ? { id, cwd: ws.cwd, name: ws.name } : undefined;
  }

  /** Stop a single registered daemon (or an added workspace) by id. Idempotent:
   *  one that isn't running returns `stopped: false`. Unknown id → ok:false.
   *  Mirrors the per-id semantics of `_opStart`. Cancels any pending restart
   *  backoff so a deliberate stop stays stopped. */
  private async _opStop(id: string): Promise<ControlReply<unknown>> {
    const entry = this._findEntry(id);
    if (!entry) return { ok: false, error: `no daemon with id ${id}` };
    const slot = this.children.get(id);
    if (!slot || slot.child.state !== "running") {
      return { ok: true, data: { id, state: slot?.child.state ?? "stopped", stopped: false } };
    }
    if (slot.restartTimer !== null) {
      clearTimeout(slot.restartTimer);
      slot.restartTimer = null;
    }
    await slot.child.stop();
    return { ok: true, data: { id, state: slot.child.state, stopped: true } };
  }

  /** Restart a single registered daemon by id (stop-if-running, then spawn).
   *  Unknown id → ok:false. Resets the crash backoff. */
  private async _opRestart(id: string): Promise<ControlReply<unknown>> {
    const entry = listDaemons().find((d) => d.id === id);
    if (!entry) return { ok: false, error: `no daemon with id ${id}` };
    const slot = this.children.get(id);
    if (slot && slot.child.state === "running") {
      if (slot.restartTimer !== null) {
        clearTimeout(slot.restartTimer);
        slot.restartTimer = null;
      }
      await slot.child.stop();
    }
    this._spawnEntry(entry.id, entry.cwd, entry.name);
    const state = this.children.get(id)?.child.state ?? "starting";
    return { ok: true, data: { id, state, restarted: true } };
  }

  private async _opRestartAll(): Promise<ControlReply<unknown>> {
    const stopReply = await this._opStopAll();
    if (!stopReply.ok) return stopReply;
    const startReply = this._opStartAll();
    if (!startReply.ok) return startReply;
    const restarted = (startReply.data as { started: string[] }).started;
    return { ok: true, data: { restarted } };
  }

  private _opSend(id: string, text: string): ControlReply<unknown> {
    const slot = this.children.get(id);
    if (!slot) return { ok: false, error: `daemon ${id} not running` };
    if (slot.child.state !== "running") {
      return { ok: false, error: `daemon ${id} state is ${slot.child.state}` };
    }
    const ok = slot.child.sendPrompt(text);
    return { ok: true, data: { id, delivered: ok } };
  }

  private _opRegister(rawCwd: string): ControlReply<unknown> {
    try {
      const { id, cwd } = addDaemon(rawCwd);
      return { ok: true, data: { id, cwd } };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  private async _opUnregister(id: string): Promise<ControlReply<unknown>> {
    // Stop the child first so we don't leave an orphan when the registry
    // entry is gone.
    const slot = this.children.get(id);
    if (slot) {
      if (slot.restartTimer !== null) {
        clearTimeout(slot.restartTimer);
        slot.restartTimer = null;
      }
      await slot.child.stop();
      this.children.delete(id);
    }
    try {
      const result = removeDaemon(id);
      return { ok: true, data: result };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  // ── Cron ops + engine (plan/39) ────────────────────────────────────────────

  private _opCronAdd(req: Extract<ControlRequest, { op: "cron_add" }>): ControlReply<unknown> {
    const v = validateSchedule(req.schedule, req.tz);
    if (!v.ok) return { ok: false, error: v.error ?? "invalid schedule" };
    const input: NewJobInput = { daemon_id: req.daemon_id, schedule: req.schedule, prompt: req.prompt };
    if (req.tz !== undefined) input.tz = req.tz;
    if (req.skip_if_busy !== undefined) input.skip_if_busy = req.skip_if_busy;
    if (req.wake !== undefined) input.wake = req.wake;
    if (req.catchup !== undefined) input.catchup = req.catchup;
    const job = addCronJob(input);
    this._scheduleCron(job);
    return { ok: true, data: { job: this._jobView(job) } };
  }

  private _opCronList(): ControlReply<unknown> {
    const jobs = listCronJobs().map((j) => this._jobView(j));
    return { ok: true, data: { jobs } };
  }

  private _opCronRemove(jobId: string): ControlReply<unknown> {
    const removed = removeCronJob(jobId);
    this._stopCron(jobId);
    return { ok: true, data: { removed } };
  }

  private _opCronEnable(jobId: string, enabled: boolean): ControlReply<unknown> {
    const updated = setJobEnabled(jobId, enabled);
    if (updated) {
      this._stopCron(jobId);
      const job = getCronJob(jobId);
      if (enabled && job) this._scheduleCron(job);
    }
    return { ok: true, data: { job_id: jobId, enabled, updated } };
  }

  private async _opCronRun(jobId: string): Promise<ControlReply<unknown>> {
    if (!getCronJob(jobId)) return { ok: false, error: `no cron job with id ${jobId}` };
    const result = await this.fireJob(jobId, { manual: true });
    return { ok: true, data: { job_id: jobId, result } };
  }

  private _opCronLog(jobId: string | undefined, tail: number | undefined): ControlReply<unknown> {
    const opts: { jobId?: string; tail?: number } = {};
    if (jobId !== undefined) opts.jobId = jobId;
    if (tail !== undefined) opts.tail = tail;
    return { ok: true, data: { entries: readCronLog(opts) } };
  }

  // ── Pairing ops (plan/69) ─────────────────────────────────────────────────

  /**
   * Returns the active host pairing code, issuing a persistent one when
   * none exists yet (or when the stored one is a spent ephemeral token).
   * `ephemeral: true` always issues a fresh short-TTL token.
   */
  private async _opPairShow(ephemeral?: boolean): Promise<ControlReply<unknown>> {
    if (ephemeral) return this._pairView(await this.pairing.issue({ ephemeral: true }));
    const current = await this.pairing.show();
    if (current && current.persistent) return this._pairView(current);
    return this._pairView(await this.pairing.issue({}));
  }

  /** Invalidates the previous code and issues a fresh one (persistent by
   *  default, ephemeral on request). */
  private async _opPairRotate(ephemeral?: boolean): Promise<ControlReply<unknown>> {
    return this._pairView(await this.pairing.issue({ ephemeral }));
  }

  /**
   * Builds the frozen pairing URI from the stored token. `epk` is the Pi's
   * long-term Ed25519 key (the same identity the HostBridge relays under),
   * `rm=host` addresses the machine room and `r` names the configured relay
   * so a self-hosted relay is discoverable from the code alone.
   */
  private async _pairView(record: HostPairingRecord): Promise<ControlReply<unknown>> {
    const keypair = await getOrCreateEd25519Keypair();
    /*
     * The `r` parameter is what a PHONE dials, so it must be the address the
     * phone can reach — the public one when the host sits behind a tunnel — not
     * necessarily the address this host connects to. Under `--direct` those
     * differ: the host is on 127.0.0.1:PORT while the phone needs the public
     * name, and emitting the loopback address made every remote pairing dial its
     * own localhost.
     */
    const { url } = resolvePublicRelayUrl();
    const uri = buildQRUri(record.token, keypair.publicKey, hostSessionName(), HOST_ROOM_ID, url);
    return {
      ok: true,
      data: {
        uri,
        token: record.token,
        expires_at: record.expires_at,
        persistent: record.persistent,
        room_id: HOST_ROOM_ID,
      },
    };
  }

  private _jobView(job: CronJob): CronJobView {
    const next = nextRunFor(job);
    return { ...job, next_run: next ? next.toISOString() : null };
  }

  /** Rebuild all live `Cron` schedules from the registry (enabled jobs only).
   *  Called on start; mutations reconcile incrementally via _scheduleCron/_stopCron. */
  private _reconcileCron(): void {
    for (const c of this.cronJobs.values()) c.stop();
    this.cronJobs.clear();
    for (const job of listCronJobs()) {
      if (job.enabled) this._scheduleCron(job);
    }
  }

  private _scheduleCron(job: CronJob): void {
    this._stopCron(job.id);
    try {
      const opts = job.tz ? { timezone: job.tz, name: job.id } : { name: job.id };
      const cron = new Cron(job.schedule, opts, () => { void this.fireJob(job.id); });
      this.cronJobs.set(job.id, cron);
    } catch (e) {
      process.stderr.write(`[remote-pi-supervisord] cron schedule failed for ${job.id}: ${String(e)}\n`);
    }
  }

  private _stopCron(jobId: string): void {
    const c = this.cronJobs.get(jobId);
    if (c) { c.stop(); this.cronJobs.delete(jobId); }
  }

  /** Detail 2: on start, run a catchup job once if its previous scheduled run
   *  was missed while the supervisor was down. Opt-in (`catchup`), at most 1×. */
  private _runCatchup(): void {
    for (const job of listCronJobs()) {
      if (!job.enabled || !job.catchup) continue;
      try {
        const cron = new Cron(job.schedule, job.tz ? { timezone: job.tz } : {});
        const prev = cron.previousRun();
        cron.stop();
        if (!prev) continue;
        const lastRunMs = job.last_run ? Date.parse(job.last_run) : 0;
        if (prev.getTime() > lastRunMs) void this.fireJob(job.id, { manual: true });
      } catch { /* skip a malformed schedule */ }
    }
  }

  /**
   * Fires a cron job: resolves the daemon, decides the action (decideFireAction),
   * acts, and records the outcome — ALWAYS one `last_status` update + one JSONL
   * line, for both fires and skips. Returns the result. `manual` bypasses the
   * disabled-skip (used by `cron run` + catchup).
   */
  async fireJob(jobId: string, opts: { manual?: boolean } = {}): Promise<CronResult | "missing"> {
    const job = getCronJob(jobId);
    if (!job) return "missing";

    let result: CronResult;
    if (!job.enabled && !opts.manual) {
      result = "skipped_disabled";
    } else {
      const slot = this.children.get(job.daemon_id);
      const running = !!slot && slot.child.state === "running";
      let busy = false;
      if (running && job.skip_if_busy) busy = await slot!.child.refreshBusy();
      const action = decideFireAction({ running, busy, wake: job.wake, skipIfBusy: job.skip_if_busy });
      if (action === "skip_down") {
        result = "skipped_down";
      } else if (action === "skip_busy") {
        result = "skipped_busy";
      } else if (action === "wake_and_send") {
        const entry = listDaemons().find((d) => d.id === job.daemon_id);
        if (!entry) {
          result = "skipped_down";
        } else {
          this._spawnEntry(entry.id, entry.cwd, entry.name);
          const woke = this.children.get(job.daemon_id);
          result = woke
            ? await this._deliverPrompt(woke.child, job)
            : "deliver_failed";
        }
      } else {
        result = await this._deliverPrompt(slot!.child, job);
      }
    }

    const at = new Date().toISOString();
    recordRun(job.id, at, result);
    appendCronLog({ job_id: job.id, daemon_id: job.daemon_id, schedule: job.schedule, result, prompt: job.prompt });

    /*
     * Automations — tell connected clients a fire happened.
     *
     * Deliberately AFTER the two records above: a client that reacts by
     * re-listing tasks must read the settled state, not race the write.
     *
     * `this.host` is absent under `skipHost` (tests, diag), so this is a no-op
     * there rather than an error — the fire itself already succeeded and was
     * recorded, and failing it because nobody is listening would be wrong.
     */
    this.host?.pushScheduleFired({
      job_id: job.id,
      daemon_id: job.daemon_id,
      result,
      fired_at: at,
      prompt_preview: job.prompt.slice(0, SCHEDULE_PREVIEW_CHARS),
    });
    return result;
  }

  // ── Child lifecycle ──────────────────────────────────────────────────────

  /**
   * Delivers one schedule fire into a running child, honouring the job's model
   * pin and session choice.
   *
   * Why this is a sequence and not one `sendPrompt`:
   *
   * - The RPC `prompt` command carries no model field (see `RpcTypes`), so a pin
   *   can only be applied with `set_model` BEFORE the prompt. Sending early would
   *   run the fire with the previous model — silently, and that is precisely the
   *   guarantee the pin exists to provide.
   * - `set_model` is process-wide, not per-turn, so the previous model has to be
   *   restored afterwards. Without the restore, one scheduled fire would
   *   permanently change the model the human sees in their own session.
   * - `fresh_session` opens a new session first; the prompt then lands in it
   *   instead of in the conversation the user is reading.
   *
   * Every step is confirmed before the next one runs, and any unconfirmed step
   * aborts the fire as `deliver_failed` rather than sending under the wrong
   * model or into the wrong session.
   */
  private async _deliverPrompt(child: RpcChild, job: CronJob): Promise<CronResult> {
    const previous = job.model !== undefined || job.fresh_session === true
      ? await child.getModel()
      : null;

    if (job.model !== undefined) {
      const applied = await child.setModel(job.model.provider, job.model.id);
      if (!applied) return "deliver_failed";
    }

    if (job.fresh_session === true) {
      const opened = await child.newSession();
      if (!opened) {
        await this._restoreModel(child, job, previous);
        return "deliver_failed";
      }
    }

    const delivered = child.sendPrompt(job.prompt);
    await this._restoreModel(child, job, previous);
    return delivered ? "delivered" : "deliver_failed";
  }

  /** Puts back the model a fire borrowed. Best-effort: a failure here must not
   *  turn a delivered prompt into a failed fire, since the message is already
   *  in flight. */
  private async _restoreModel(
    child: RpcChild,
    job: CronJob,
    previous: { provider: string; id: string } | null,
  ): Promise<void> {
    if (job.model === undefined || previous === null) return;
    if (previous.provider === job.model.provider && previous.id === job.model.id) return;
    await child.setModel(previous.provider, previous.id);
  }

  private _spawnAllFromRegistry(): void {
    for (const entry of listDaemons()) {
      this._spawnEntry(entry.id, entry.cwd, entry.name);
    }
  }

  private _spawnEntry(id: string, cwd: string, name?: string): void {
    // Clean up any prior slot (e.g. crashed + waiting for backoff).
    const existing = this.children.get(id);
    if (existing) {
      if (existing.restartTimer !== null) clearTimeout(existing.restartTimer);
      // If somehow the child is still alive, stop it first so we don't
      // leak. Fire-and-forget — caller doesn't await.
      if (existing.child.state === "running") void existing.child.stop();
    }

    // Build the daemon's config and inject it via REMOTE_PI_DIRECT_CONFIG —
    // no per-cwd config file needed. The daemon scopes by (cwd, name) like any
    // agent (plan/38); relay on.
    const config: LocalConfig = {
      agent_name: name ?? defaultAgentName(cwd),
      auto_start_relay: true,
    };
    const childOpts: RpcChildOptions = {
      extensionPath: this.opts.extensionPath,
      cwd,
      config,
    };
    if (this.opts.piBin !== undefined) childOpts.piBin = this.opts.piBin;
    const child = new RpcChild(childOpts);
    const slot: ChildSlot = { id, cwd, child, restartTimer: null, restartAttempt: 0, lastError: null };
    this.children.set(id, slot);

    child.on("exit", (evt: RpcChildExitEvent) => this._onChildExit(id, evt));
    child.spawn();
    // Plan/69 — the spawn itself is a lifecycle transition (start / restart):
    // mirror the slot to the host room. `state` is `running` on a successful
    // spawn (RpcChild.spawn publishes it synchronously).
    this._pushWorkspaceState(id);
  }

  /**
   * Plan/69 — push the ChildSlot's current state to the host room. Mirrors
   * the slot verbatim: `state` is the child's own DaemonState, `restarts`
   * its restart counter, `last_error` the recorded crash reason (null when
   * none / freshly spawned). No-op without a host bridge (skipHost).
   */
  private _pushWorkspaceState(id: string): void {
    const slot = this.children.get(id);
    if (!slot || !this.host) return;
    this.host.pushWorkspaceState({
      cwd: slot.cwd,
      state: slot.child.state,
      last_error: slot.lastError,
      restarts: slot.child.restartCount,
    });
  }

  private _onChildExit(id: string, evt: RpcChildExitEvent): void {
    if (this.shuttingDown) return;
    const slot = this.children.get(id);
    if (!slot) return;

    if (evt.isCrash) {
      slot.lastError =
        evt.error ??
        (evt.signal !== null
          ? `killed by signal ${evt.signal}`
          : `exited with code ${evt.code ?? "null"}`);
    }
    /*
     * The one-process-per-workspace rule refusing this start.
     *
     * Checked BEFORE the clean-exit branch on purpose: the child exits 0 for
     * this, so `isCrash` is false and the code below would return with
     * `last_error` left null — the user then saw a daemon that would not run,
     * with no explanation anywhere. It must also NOT be retried: the lock is
     * still held by a live process, so every respawn fails identically and only
     * burns the crash budget and the log.
     */
    if (evt.code === EXIT_DAEMON_LOCK_HELD) {
      slot.lastError =
        "another Pi agent already owns this folder — stop it, then start this workspace again";
      process.stderr.write(
        `[remote-pi-supervisord] ${id} refused to start: the workspace lock is held by another live agent\n`,
      );
      this._pushWorkspaceState(id);
      return;
    }

    // Plan/69 — every exit is a transition (crash → `crashed` + last_error;
    // clean stop → `stopped`), pushed BEFORE any restart decision so the app
    // sees the down state even when a backoff respawn follows immediately.
    this._pushWorkspaceState(id);

    if (!evt.isCrash) {
      // Clean shutdown (e.g. via `stop_all`). Don't auto-restart.
      return;
    }

    if (evt.code === EXIT_DAEMON_FRESH_SESSION) {
      // App-triggered daemon `/new`: this is an intentional recycle, not a
      // crash. Restart immediately and don't burn the crash backoff budget.
      slot.restartAttempt = 0;
      slot.lastError = null;  // fresh spawn — no current error
      slot.child.noteRecycle();
      slot.child.spawn();
      this._pushWorkspaceState(id);
      return;
    }

    if (evt.code === EXIT_DAEMON_SWITCH_SESSION) {
      // App-triggered daemon `session_switch`: also a deliberate recycle. The
      // target session file was staged by the child, and `spawn()` picks it up
      // to pass `--session <path>` — so this must restart the SAME way, without
      // counting as a crash attempt.
      slot.restartAttempt = 0;
      slot.lastError = null;
      slot.child.noteRecycle();
      slot.child.spawn();
      this._pushWorkspaceState(id);
      return;
    }

    // Crash: schedule restart with backoff. After exhausting the schedule
    // we give up and stay in `crashed`.
    if (slot.restartAttempt >= RESTART_BACKOFFS_MS.length) {
      process.stderr.write(
        `[remote-pi-supervisord] giving up restart for ${id} after ${slot.restartAttempt} attempts\n`,
      );
      return;
    }
    const delay = RESTART_BACKOFFS_MS[slot.restartAttempt]!;
    process.stderr.write(
      `[remote-pi-supervisord] scheduling restart of ${id} in ${delay}ms (attempt ${slot.restartAttempt + 1})\n`,
    );
    slot.restartTimer = setTimeout(() => {
      slot.restartTimer = null;
      slot.restartAttempt += 1;
      slot.lastError = null;  // fresh spawn — no current error
      slot.child.noteRestart();
      slot.child.spawn();
      // Plan/69 — the backoff respawn is the `restart` transition: restarts
      // counter already bumped by noteRestart(), state now `running`.
      this._pushWorkspaceState(id);
    }, delay);
  }

  /**
   * Plan/67–68 — the room catalog the embedded relay reports to clients.
   *
   * One room per fleet entry, carrying the `cwd` the app needs to open its
   * workspace dock. The relay is started before this Supervisor (its address
   * must be in the environment first), so `direct.ts` holds a provider that
   * delegates here lazily rather than receiving data at start time.
   *
   * `peer` is THIS machine's own key: clients index the catalog by the machine
   * they are paired with, never by their own identity.
   */
  async roomCatalog(): Promise<{ peer: string; rooms: RelayRoomInfo[] }> {
    const now = Date.now();
    return {
      peer: await this._ownPeerKey(),
      rooms: this._catalogEntries().map((e) => ({
        room_id: roomIdFor(e.cwd, e.name),
        started_at: now,
        name: e.name,
        cwd: e.cwd,
        working: false,
      })),
    };
  }

  /**
   * This machine's own relay identity, memoised.
   *
   * `getOrCreateEd25519Keypair()` may touch the OS keyring, and the relay
   * answers `subscribe_rooms` on the hot path of every client connect — so
   * resolve once and reuse. The identity never changes within a process run.
   */
  private _ownPeerCache: string | null = null;

  private async _ownPeerKey(): Promise<string> {
    if (this._ownPeerCache !== null) return this._ownPeerCache;
    const kp = await getOrCreateEd25519Keypair();
    this._ownPeerCache = Buffer.from(kp.publicKey).toString("base64");
    return this._ownPeerCache;
  }

  /** Plan/67–68 — fleet surface for the host room (daemons ∪ added workspaces). */
  private _fleetOps(): FleetOps {
    return {
      list: () => this._catalogEntries(),
      // Plan/68 — persist an unregistered cwd in workspaces.json (NOT
      // daemons.json) so `workspace_start` can boot a folder picked by
      // navigating the host filesystem, without promoting it to a supervised
      // always-on daemon.
      ensure: (cwd) => {
        try {
          const { cwd: resolved } = addWorkspace(cwd);
          return { ok: true, id: daemonIdForCwd(resolved), cwd: resolved, name: defaultAgentName(resolved) };
        } catch (e) {
          const message = (e as Error).message;
          return { ok: false, error: /ENOENT|not directory|ENOTDIR|required/i.test(message) ? "not_found" : message };
        }
      },
      start: (id) => {
        // Registered daemon → normal supervised start.
        if (listDaemons().some((d) => d.id === id)) {
          const r = this._opStart(id);
          if (!r.ok) return { ok: false, error: r.error };
          const data = r.data as { started?: boolean } | undefined;
          return { ok: true, started: data?.started !== false };
        }
        // Plan/68 — added workspace: spawn a slot for it (in-memory; it is not
        // in daemons.json, so it is not auto-started on supervisor boot).
        const entry = this._findEntry(id);
        if (!entry) return { ok: false, error: `no workspace with id ${id}` };
        const slot = this.children.get(id);
        if (slot && slot.child.state === "running") return { ok: true, started: false };
        this._spawnEntry(entry.id, entry.cwd, entry.name);
        return { ok: true, started: true };
      },
      stop: async (id) => {
        const r = await this._opStop(id);
        if (!r.ok) return { ok: false, error: r.error };
        const data = r.data as { stopped?: boolean } | undefined;
        return { ok: true, stopped: data?.stopped !== false };
      },
      addWorkspace: (cwd) => {
        try {
          const { cwd: resolved, added } = addWorkspace(cwd);
          return { ok: true, cwd: resolved, added };
        } catch (e) {
          const message = (e as Error).message;
          return { ok: false, error: /ENOENT|not directory|ENOTDIR|required/i.test(message) ? "not_found" : message };
        }
      },
      removeWorkspace: (cwd) => {
        try {
          const { cwd: resolved, removed } = removeWorkspace(cwd);
          return { ok: true, cwd: resolved, removed };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      },
      /*
       * Automations — the cron engine, exposed to the host room.
       *
       * Wired here rather than inside HostBridge so the bridge stays a pure
       * dispatcher with no storage knowledge. Every mutation goes through the
       * same registry functions the control ops use, so a task created from the
       * browser and one created by `remote-pi-server cron add` are
       * indistinguishable rows.
       */
      schedule: {
        list: () => listCronJobs(),
        add: (input) => {
          const v = validateSchedule(input.schedule, input.tz);
          if (!v.ok) return { error: v.error ?? "invalid schedule" };
          const job = addCronJob(input);
          this._scheduleCron(job);
          return job;
        },
        remove: (id) => {
          this._stopCron(id);
          return removeCronJob(id);
        },
        setEnabled: (id, enabled) => {
          const ok = setJobEnabled(id, enabled);
          if (ok) this._reconcileCron();
          return ok;
        },
        runNow: async (id) => {
          const r = await this.fireJob(id, { manual: true });
          return typeof r === "string" ? r : "unknown";
        },
        log: (jobId, tail) => readCronLog(tail === undefined ? { jobId } : { jobId, tail }),
        names: () => {
          const out: Record<string, string> = {};
          for (const entry of this._catalogEntries()) out[entry.id] = entry.name ?? entry.cwd;
          return out;
        },
      },
    };
  }

  /**
   * Plan/68 — the host-room catalog: registered daemons ∪ explicitly added
   * workspaces. A cwd present in both is reported once, as its daemon row
   * (the daemon is the stronger identity: it has a real supervisor slot).
   */
  private _catalogEntries(): FleetEntry[] {
    const rows: FleetEntry[] = [];
    const seen = new Set<string>();
    for (const d of this._listInfo()) {
      seen.add(d.cwd);
      rows.push({
        id: d.id,
        cwd: d.cwd,
        name: d.name,
        live: d.state === "running",
        source: "daemon",
      });
    }
    for (const w of listWorkspaces()) {
      if (seen.has(w.cwd)) continue;
      rows.push({
        id: daemonIdForCwd(w.cwd),
        cwd: w.cwd,
        name: w.name,
        // An added workspace has no supervisor slot yet: it is not `live`
        // until the user starts it (which promotes it to a fleet slot).
        live: this.children.get(daemonIdForCwd(w.cwd))?.child.state === "running",
        source: "added",
      });
    }
    return rows;
  }
}

/** Test helper: derive id from cwd without going through the registry. */
export function _idForCwdForTest(cwd: string): string { return daemonIdForCwd(cwd); }

/** Test helper: read the host-room catalog (registered ∪ added) off a live
 *  supervisor without opening the relay. Used by plan/68 catalog tests. */
export function _catalogEntriesForTest(s: Supervisor): FleetEntry[] {
  return (s as unknown as { _catalogEntries(): FleetEntry[] })._catalogEntries();
}

/** Test helper: the host-room fleet surface (plan/68), for tests that drive
 *  `ensure`/`start` directly without a relay round-trip. */
export function _fleetOpsForTest(s: Supervisor): FleetOps {
  return (s as unknown as { _fleetOps(): FleetOps })._fleetOps();
}

/** Exported for the bin/supervisord entry + tests to know where the
 *  supervisor will bind. */
export function getSupervisorSockPath(): string { return supervisorSockPath(); }
