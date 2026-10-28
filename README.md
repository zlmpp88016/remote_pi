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

Three machines. Run in order. Commands are Linux/bash (WSL on Windows).

### 1. Relay — a VPS or any host with a public IP

```bash
curl -fsSL https://get.docker.com | sh

git clone https://github.com/exampleorg/remote_pi
cd remote_pi
docker compose -f docker-compose.relay.yml up -d
```

The relay now listens on `127.0.0.1:3001`, with SQLite state in the `relay-data` volume.

### 2. Cloudflare Tunnel — public `wss://`, no open inbound ports

On the same host:

```bash
curl -fsSL -o /usr/local/bin/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x /usr/local/bin/cloudflared

cloudflared tunnel login
cloudflared tunnel create remote-pi
cloudflared tunnel route dns remote-pi relay.example.com

# 127.0.0.1:3001 is the port the relay is published on (step 1)
cloudflared tunnel run --url http://127.0.0.1:3001 remote-pi
```

Verify: `curl https://relay.example.com/health` returns 200.

### 3. Server — the machine that runs Pi (no public IP needed)

Not the VPS. This is the machine you want to reach.

Needs Node >= 20.6 and the Pi coding agent installed.

#### Build and install from a local checkout

This repo is not published to npm. Install the CLI from the working copy, which
npm links rather than copies — so a rebuild is enough to pick up code changes.

**Requires npm >= 11.** npm 10 crashes on this dependency tree with
`Cannot read properties of null (reading 'edgesOut')` (an arborist bug in the
peer-set resolver, triggered by vitest 4). Upgrade once with `npm install -g npm@11`.

Under nvm, that upgrade rewrites `npm-cli.js` and nvm's integrity check then blocks
every npm call (`NVM4306: delegated script changed since it was trusted`). Re-shim
once after upgrading:

```bash
nvm reshim
```

```bash
git clone https://github.com/exampleorg/remote_pi
cd remote_pi/server

npm install          # dependencies
npm run build        # tsc → dist/
npm install -g .     # links this checkout as the global `remote-pi-server`

remote-pi-server set-relay https://relay.example.com   # http(s), not wss
remote-pi-server pair                                 # prints address + code
```

`npm install -g .` symlinks the checkout, so after changing code:

```bash
git pull && cd server && npm install && npm run build
remote-pi-server restart-supervisor   # supervisor has no hot-reload
```

`restart-supervisor` is the only command that reloads the server code: the
supervisor is a long-running Node process, and `daemon restart` respawns the
workspace `pi` children without touching it (see
[Server changes](#server-changes--rebuild-then-restart-the-supervisor)).

The daemon is launched with an explicit `-e dist/index.js`, so it does not go
through `pi install`. Use `pi install "$PWD"` only if you also want the extension
available inside your **interactive** Pi sessions (`/remote-pi start`):

```bash
pi install "$PWD"      # optional — interactive use only
```

Already have an older global install under a different name? npm will not delete
another package's binaries, so remove them first:

```bash
npm uninstall -g remote-pi            # the pre-rename package
npm install -g .                      # then this
```

#### Run it

Two modes. Pick based on whether you want Pi reachable while you are not sitting
at the machine.

**Foreground (interactive)** — the extension inside Pi. Nothing resident; `/remote-pi`
commands work only while that Pi session is open.

```bash
pi                                    # then use /remote-pi start, /remote-pi pair
```

**Resident daemon** — a supervisor that keeps Pi workspaces running in the
background and answers pairing with no interactive session. Use this to reach
the machine from your phone or browser at any time.

```bash
remote-pi-server create /path/to/a/workspace --name "my project"
remote-pi-server install              # registers the user-level service
remote-pi-server daemon status        # confirm it is running
```

`install` writes a **user-level** unit — systemd `--user` on Linux, a LaunchAgent
on macOS, a Task Scheduler entry on Windows. It does not need root.

Windows is the one exception: the very first `install` has to create the
scheduled task, which lives in the machine-wide store, so it raises one UAC
prompt. `uninstall` needs one too — `schtasks /Delete` modifies that same store.
`restart-supervisor` and `daemon restart` never elevate.

#### Restart / stop

```bash
remote-pi-server restart-supervisor   # reload the SERVER code (after a rebuild)
remote-pi-server daemon restart       # only respawn the workspace `pi` processes
remote-pi-server daemon start|stop    # start or stop the resident supervisor
remote-pi-server daemon status        # pid, uptime, restart count per workspace
remote-pi-server daemons              # list registered workspaces
remote-pi-server uninstall            # remove the service (workspaces kept)
```

Which restart you want depends on **what you changed**:

| You changed | Use | Why |
|---|---|---|
| `server/` code (`host_bridge`, `index`, CLI, `/remote-pi`) | `restart-supervisor` | The code runs *inside* the supervisor process, which never hot-reloads. |
| A workspace's Pi state (stuck child, model, auth) | `daemon restart` | Respawning the child is enough; the supervisor keeps its loaded code. |
| Only `clients/web/` | neither | The dev server hot-reloads; just refresh the page. |

`restart-supervisor` re-spawns every workspace daemon as a side effect, so you
never need `daemon restart` after it.

#### Uninstall

```bash
remote-pi-server uninstall
```

What it does, and what it deliberately keeps:

| | Effect |
|---|---|
| Stops the service | `launchctl bootout` (macOS), `systemctl --user disable --now` (Linux), `schtasks /End` (Windows) |
| Removes the unit | Deletes the LaunchAgent plist / systemd unit / Task Scheduler XML + its `wscript` launcher |
| Removes CLI shims | Deletes the `remote-pi-server` / `pi-supervisord` links under `~/.local/bin` only. **npm-global bins are never touched** — those live in a different prefix. |
| Keeps `~/.pi/remote/daemons.json` | The workspace registry survives, so `remote-pi-server install` brings everything back without re-registering. |
| Keeps `~/.pi/remote/peers.json`, `identity.json`, `pairing.json` | Pairings stay valid; clients reconnect after a re-install. |

On Windows the first `install` needs one UAC prompt (creating the scheduled task
touches the machine-wide store). `uninstall` also needs it, because
`schtasks /Delete` is what modifies that store. `restart-supervisor` and
`daemon restart` never elevate.

To remove the CLI entirely as well:

```bash
remote-pi-server uninstall
npm uninstall -g remote-pi-server     # drop the npm link
```

#### Relay choice

Set the relay **before** pairing: the pairing payload carries the relay URL, so a
client that pairs first would point at the wrong relay. `set-relay` accepts
`http://`/`https://` only — the clients convert to `ws(s)://` themselves. Skip it
to use the community relay `https://relay.880160.xyz`.

```bash
remote-pi-server set-relay https://relay.example.com
```

The effective value and where it came from live in `~/.pi/remote/config.json`;
inside Pi, `/remote-pi config` prints the same thing.

### 4. Client — web

```bash
cd clients/web
docker build -t remote-pi-web .
docker run -d --restart unless-stopped -p 3000:3000 remote-pi-web
```

Open `http://<that-host>:3000/remote-pi/connect` and paste the address + code
from step 3. No environment variables: the relay URL and the pairing code are
typed into the page (and stored in the browser afterwards).

### 5. Optional — mobile app

[Google Play](https://play.google.com/store/apps/details?id=com.example.remotepi) ·
[App Store](https://apps.apple.com/app/remote-pi-coding-agent/id6773499691) ·
[APK](https://github.com/exampleorg/remote_pi/releases)

Scan the QR printed by `remote-pi-server pair`, or enter the same address + code.


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

## Getting started

### 1. Run the host daemon

Install the CLI globally from a local checkout (the package is not on npm):

```bash
cd remote_pi/server && npm install && npm run build && npm install -g .
```

Install the daemon as a user-level system service (Linux `systemd --user`, macOS
launchd, Windows Task Scheduler). It auto-starts at login and survives reboots:

```bash
remote-pi-server install
```

The daemon comes up, connects to the relay, and holds the machine online — with
**no Pi running**.

### 2. Pair a client

Pair from the daemon itself (no Pi needed):

```bash
remote-pi-server pair        # prints the address + one-time/persistent code
```

Enter that address and code in the mobile app, the browser client, or Cockpit.
Once paired, the client can browse the host filesystem, register a directory, and
start a Pi there.

### 3. Or run Pi locally as usual

The `/remote-pi` Pi command still works for the everyday local case. Inside any
Pi session:

```text
/remote-pi
```

The wizard asks for an agent name, session name, and relay choice, then prints a
QR code. Scan it with the mobile app — useful when you want the current Pi
session itself reachable without a resident daemon.

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
