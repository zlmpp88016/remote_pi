<p align="center">
  <img src="branding/logo-full.svg" width="140" alt="Remote Pi logo" />
</p>

<h1 align="center">Remote Pi</h1>

<p align="center">
  Operate and manage your <a href="https://github.com/earendil-works/pi">Pi coding agents</a> from anywhere.<br/>
  A resident daemon on the target machine is the front door: pair once, then browse folders,
  start Pi in any directory, drive its sessions, and watch its work — from your phone, browser, or desktop.
</p>

---

## Deploy

Three roles. Pick the plan that matches what you have.

| Role | Where it runs | What it does |
| --- | --- | --- |
| **relay** | A host with a public IP — or nowhere at all | Lets both sides talk without either being reachable. **Omit it entirely** when you use `--direct`: that mode embeds its own relay. |
| **server** | The machine that actually runs Pi | `pi-supervisord` keeps Pi workspaces alive and answers pairing |
| **client** | Your browser / phone / desktop | Web, iOS, or the Electron shell |

### Plan 1 — Single machine (try it in five minutes)

Everything on one box. `--direct` starts an embedded relay and serves the web
client itself, so there is **no Docker and no separate web host**.

```bash
cd server && npm install && npm run build && npm install -g .
node dist/bin/supervisord.js --direct
```

It logs `direct mode — local relay at http://127.0.0.1:4124 (no community relay)`.
Open `http://127.0.0.1:4124/remote-pi/connect`.

For the pairing code, in a second terminal:

```bash
remote-pi-server pair
```

Paste the whole `remotepi://pair?…` string into the **pairing code** box, and
`ws://127.0.0.1:4124` into the **relay address** box.

> The web client must exist under `clients/web/dist` for this plan. If you have
> not built it, the daemon still runs but serves no page — it says so in the log.
> Build it once with `cd clients/web && npm install && npm run build`. This is the
> **only** plan where the server machine needs the web build.

### Plan 2 — Two machines (Pi on A, browser on B) — recommended

Machine A runs Pi. Machine B only opens a page. **A does not build the web client
in this plan** — B serves it.

#### Machine A

```bash
cd server && npm install && npm run build && npm install -g .
remote-pi-server set-relay https://relay.example.com   # http(s) only, never ws://
remote-pi-server install                              # user-level service, survives logout
remote-pi-server daemon status                        # confirm it is running
remote-pi-server pair                                 # print the pairing URI
```

`install` writes a systemd `--user` unit, a LaunchAgent, or a Task Scheduler
entry — no root, except the very first Windows install raises one UAC prompt.

#### Machine B

```bash
cd clients/web && npm install && npm run build
npx serve dist -p 5173
```

Open `http://localhost:5173/remote-pi/connect`:

| Field | Value |
| --- | --- |
| Relay address | `wss://relay.example.com` |
| Pairing code | the whole `remotepi://pair?…` string from A |

### Plan 3 — Production (own relay + own domain)

#### Relay host

```bash
docker compose -f docker-compose.relay.yml up -d   # host 3001 → container 3000
```

Point a reverse proxy or Cloudflare Tunnel at `127.0.0.1:3001` so both
`https://` and `wss://` on your domain land there. `RELAY_ALLOWED_ORIGINS` is the
browser-origin allowlist and defaults to permissive.

#### Server host

```bash
cd server && npm install && npm run build && npm install -g .
remote-pi-server set-relay https://relay.example.com
remote-pi-server install
remote-pi-server pair          # --rotate to invalidate the previous code
```

#### Client host

Publish `clients/web/dist` to any static host (Nginx, Cloudflare Pages, Vercel)
behind HTTPS, then connect with the relay address and pairing code above.

### Reaching a `--direct` daemon from another machine

`--direct` binds `127.0.0.1` only — the host and port are not configurable through
it. To reach it from elsewhere, put a tunnel or reverse proxy in front **and**
allow the hostname the browser will send:

```bash
REMOTE_PI_ALLOWED_HOSTS="your-tunnel-host.example.com" \
  node dist/bin/supervisord.js --direct
```

That variable is not optional: without it the proxy gets `403` before any page is
served, because the strict same-origin gate only accepts loopback `Host` values by
default. If the browser page is served from a different origin than the daemon,
list it in `REMOTE_PI_ALLOWED_ORIGINS` too.

### Common pitfalls

- **Pairing code in the wrong box.** The page has two inputs. The relay address
  takes `wss://…`; the pairing code takes the full `remotepi://pair?…` URI.
  Pasting the URI into the address field is the single most common failure.
- **`set-relay` rejects `ws://`.** It takes `http://` or `https://` only and
  converts to WebSocket internally. Passing `ws://` is refused outright.
- **`install` and `--direct` are mutually exclusive.** They contend for the same
  supervisor socket (a named pipe on Windows,
  `/tmp/remote-pi-supervisor-<user>.sock` elsewhere). Starting one while the other
  runs fails with *"Another pi-supervisord is already running"*. Stop the service
  first: `remote-pi-server daemon stop`.
- **`daemon status` says "not running" while `--direct` works.** Expected. Those
  commands manage the installed service, not a foreground process.
- **`403` from a tunnel.** Missing `REMOTE_PI_ALLOWED_HOSTS`, see above.

---

## Links

- **Official site** — <https://remote-pi.example.invalid>
- **Package documentation** — <https://pi.dev/packages/remote-pi?name=remote-pi>
- **GitHub** — <https://github.com/exampleorg/remote_pi>

### Downloads

| Platform | Status |
|---|---|
| Google Play (Android) | [Get it on Google Play](https://play.google.com/store/apps/details?id=com.example.remotepi) |
| App Store (iOS) | [Download on the App Store](https://apps.apple.com/app/remote-pi-coding-agent/id6773499691) |
| APK (sideload, Android) | [GitHub Releases](https://github.com/exampleorg/remote_pi/releases) |
| Desktop (Cockpit) | [GitHub Releases](https://github.com/exampleorg/remote_pi/releases?q=cockpit-v) |

## What's in this repo

Remote Pi is not a single plug-in — it is the whole system that runs and manages Pi on a machine,
plus the clients that reach it.

| Package | Stack | Role |
|---|---|---|
| [`server/`](./server) | Node + TypeScript | **Daemon and control plane** — the `pi-supervisord` host daemon, the `remote-pi` CLI, the `/remote-pi` Pi command, and the local agent mesh |
| [`clients/mobile/`](./clients/mobile) | Flutter (iOS / Android) | Mobile client (operator console) |
| [`clients/desktop/`](./clients/desktop) | Flutter Desktop | Desktop client (macOS / Windows / Linux, + iPad / Android) |
| [`clients/web/`](./clients/web) | NextJS | Landing page, docs, and the browser client |
| [`relay/`](./relay) | Rust + Tokio | WebSocket routing + signed mesh membership storage |

## Architecture

```
Phone / browser / desktop client
        │  wss  (pair once — address + code)
        ▼
   Relay (Rust)
        ▲  wss
        │
Host daemon  `pi-supervisord`   ──  room "host" · always on · survives Pi
        │  spawns on demand
        ├──►  Pi child  (`pi --mode rpc`)   ──  workspace · sessions · chat
        │
        └──►  UDS broker   ──  local agent mesh (`list_peers` / `agent_send`)
```

The **host is the connection**. Clients attach to the machine's daemon (room `host`), never to a
particular Pi process. A Pi that is stopped, crashed, or never started does not drop the connection —
the daemon keeps the machine online, publishes workspace state, and can start or restart a Pi on any
directory the operator picks.

- **Pair once, without Pi running** — the daemon accepts pairing itself (address + code); a Pi process is not a prerequisite
- **Workspace lifecycle** — browse the host filesystem, register a directory, start / stop / restart its Pi, and switch sessions
- **Ed25519 authentication** — the Relay handshake proves possession of the connection key; App↔host pairing is enforced by the endpoints. For Pi↔Pi routing, the current Relay permits a route when a correctly signed Owner blob lists both Pi keys; that check does not prove the Owner paired with or controls either Pi
- **TLS protects traffic in transit**, but current payloads are not E2E; see [`relay/README.md`](./relay/README.md) for the exact trust boundary

## Local agent mesh

When multiple Pi agents run on the same machine, they discover each other through
a **Unix Domain Socket broker** managed by the daemon. One agent wins the
leader election and binds the socket; the others connect as clients. For targets
on that same machine, agents use the opaque addresses returned by `list_peers` —
no relay, no network, no extra config.

Three LLM-facing tools are exposed in the Pi chat:

- `list_peers` — lists local and cross-PC addresses available to the agent
- `agent_send` — sends a unicast message and waits for a delivery ACK. Compatible ACK values are `received`, `busy`, `denied`, and `timeout`; current brokers return `received`, `denied`, or `timeout`, while `busy` only indicates a dropped message from an old broker leader that must be restarted before resending. Broadcast is `sent` with no ACK. Asynchronous content replies use `re`
- `agent_request` — request/response with timeout, available only as deprecated legacy behavior

This lets you set up local multi-agent workflows (e.g. a `backend` agent asks a
`frontend` agent for help) entirely on your machine, in parallel with the remote
operator clients.

## Relay

A free community relay is available at:

```
wss://relay.880160.xyz
```

It's enough to get started, but the relay operator can see the content of your
messages and is a single point of trust for routing. **For sensitive work, we
strongly recommend running your own relay** — it's a single Docker command and
the only thing your traffic ever touches is your own infrastructure.

Full security trade-offs and the self-hosting guide live in
**[`relay/README.md`](./relay/README.md)**.

### Recommended companion: `@eko24ive/pi-ask`

```bash
pi install npm:@eko24ive/pi-ask
```

With pi-ask installed, the agent's `ask_user` clarification prompts (structured
questions with options, multi-select, and previews) render natively in the
mobile app — answer from your phone and the flow resolves on the desktop.
Without it, the agent simply asks in plain chat text (also answerable from the
phone, just unstructured). Remote Pi works either way; pi-ask is optional.

## Developing (after you changed code)

This is the part that trips people up once the daemon is installed as a
**service**: the service keeps running the code it loaded at start, so editing
files changes nothing until you deliberately reload the right piece.

There are **two independent processes**, and they reload differently:

| You changed | Runs as | How the change takes effect |
|---|---|---|
| `server/` (daemon, CLI, `/remote-pi` command) | `pi-supervisord` service | rebuild **and** restart the supervisor |
| `clients/web/` (the browser UI) | `next` (dev server or Docker) | dev server hot-reloads; just refresh the page |
| `clients/mobile/`, `clients/desktop/` | your own build/run | rebuild that client |

### Server changes — rebuild, then restart the supervisor

`daemon restart` is **not** enough. It respawns the workspace Pi processes, but
the supervisor itself keeps the code it already loaded (`pi-supervisord` is a
long-running Node process with no hot-reload). Use `restart-supervisor`:

```bash
cd server
npm run build                     # tsc → dist/
remote-pi-server restart-supervisor   # respawns pi-supervisord on the new dist/
```

`restart-supervisor` re-spawns every workspace daemon as a side effect, so you do
not need `daemon restart` afterwards. Check it came back:

```bash
remote-pi-server daemon status        # pid, uptime, restart count per workspace
```

**Verify the restart actually happened.** Comparing the supervisor's PID before
and after is the only proof — the command exiting 0 is not enough (see the
Windows note below):

```powershell
# Windows
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*supervisord.js*' } |
  Select-Object ProcessId, CreationDate
```

```bash
# Linux / macOS
pgrep -af supervisord.js
```

The `CreationDate` must be *after* your `npm run build`. If it is older, the old
code is still serving.

> **Windows:** Task Scheduler's `schtasks /End` reports success while the node
> process keeps running, so a naive `End` + `Run` pair silently does nothing.
> `restart-supervisor` therefore waits for the old `supervisord.js` to disappear
> and force-stops it if it overstays, failing loudly (non-zero exit) rather than
> claiming success. If it still reports the process as running, stop it by hand:
>
> ```powershell
> Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
>   Where-Object { $_.CommandLine -like '*supervisord.js*' } |
>   ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
> remote-pi-server restart-supervisor
> ```

Both commands are un-elevated on every platform (Windows included) — only the
very first `install` needs elevation.

> **Why not just restart the OS service yourself?** You can (`systemctl --user
> restart <unit>` on Linux, `launchctl kickstart -k` on macOS, `schtasks /End &&
> schtasks /Run` on Windows). `restart-supervisor` is exactly that, wrapped so it
> works the same everywhere.

If you are **not** running the service (plain `pi` session, no supervisor), skip
all of this: restart your Pi session and it picks up the new `dist/`.

### Web changes — refresh the page

With the dev server running, edits hot-reload:

```bash
cd clients/web
npm run dev                       # http://localhost:3000/remote-pi/connect
```

A hard refresh (**Ctrl/Cmd+Shift+R**) is usually still needed after a change to
connection/state code, because the browser keeps an open WebSocket to the relay
and the old client code with it. Reloading also re-pairs from the stored
credential, which is what re-runs the connect-time prefetch.

Production/web-service deployments use the Docker image instead — see
[Client — web](#4-client--web); rebuild and restart the container after a change.

### Verifying a web change

```bash
cd clients/web
npm run verify:web                # all Node runners (no browser needed)
npm run lint && npx tsc --noEmit  # static checks
npm run build                     # production build still compiles
```

## Status

The MVP is functional. Planning notes and roadmap live in [`plan/`](./plan).

## License

License is per-package — see each subproject's `LICENSE` file (the `remote-pi`
is MIT). A repository-wide license decision is pending.
