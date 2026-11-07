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

**Two things: one server, one client. Install them and you are done — no relay to configure,
no third service to deploy.**

The server embeds its own relay and serves the web client on the same port.

```
The machine that runs Pi                Your phone / browser / desktop
┌────────────────────────────┐
│  pi-supervisord            │   ← these two are all you install
│   · embedded relay         │      server on this side
│   · serves the web client  │      client on that side
│   · keeps Pi workspaces up │
└────────────────────────────┘
```

### Install the server

```bash
cd server && npm install && npm run build && npm install -g .
cd ../clients/web && npm install && npm run build
cd ../../server

remote-pi-server install         # user-level service, survives logout; one UAC prompt on Windows
remote-pi-server daemon status   # confirm it is running
```

The log (`~/.pi/remote/supervisord.log`) should contain:

```
[pi-supervisord] direct mode — local relay at http://127.0.0.1:4124 (no community relay)
```

That line is the whole point: self-contained mode, **zero public-network traffic**. The
service unit `install` writes carries no relay arguments and inherits this default.

### Connect a client

**Browser:** open `http://127.0.0.1:4124/remote-pi/connect`. **Type nothing** — the page pairs
itself over the same origin.

**Phone:** install the app, then Settings → Add pairing. The relay address field needs **nothing
from you** — pasting the code fills it in. Only two situations need a second look:

| Situation | What you do |
| --- | --- |
| Phone plugged into the machine over USB | run `adb reverse tcp:4124 tcp:4124`, then **just paste the code** |
| Phone on another device (Wi-Fi or the internet) | set up the tunnel in "Reaching the server from elsewhere" first, then **just paste the code** |

Get the pairing code on the server:

```bash
remote-pi-server pair
```

Paste the whole `remotepi://pair?…` string into the app's **pairing code** box. The relay
address **auto-fills from the code** (`r=`); you only touch it to point somewhere else.

### That is it

No Docker, no separate web host, no relay deployment, no `set-relay`.

### Common pitfalls

- **Starting `pi-supervisord` by hand after `install`.** They contend for the same supervisor
  socket (a named pipe on Windows, `/tmp/remote-pi-supervisor-<user>.sock` elsewhere) and the
  second one fails with *"Another pi-supervisord is already running"*. Once the service is
  installed, do not start it manually.
- **`daemon status` says "not running" while the page works.** Expected. Those commands manage
  the **installed service**, not a foreground process.
- **The page shows "Connect to a host" instead of connecting.** Same-origin auto-pairing did
  not happen (the page probably was not served by this server). Paste the output of
  `remote-pi-server pair` into the pairing-code box — the manual path always works.
- **Server code changes have no effect.** `pi-supervisord` is a long-lived process with no hot
  reload. `npm run build` **then** `remote-pi-server restart-supervisor`, see "Developing".

---

## Optional: reaching the server from elsewhere

`direct` binds `127.0.0.1` only, deliberately — nothing is exposed on the network unless you
open it. To reach it from another device, put a tunnel in front (frp / nginx / cloudflared /
SSH `-L`), then tell the server two things:

```bash
remote-pi-server set-public-relay "https://pi.example.com"   # what a PHONE should dial
remote-pi-server allow-host       "pi.example.com"           # hostname the origin gate accepts
remote-pi-server restart-supervisor
```

They solve **two independent problems**, and missing either one fails:

| Missing | Symptom |
| --- | --- |
| `set-public-relay` | the code carries `127.0.0.1`, so a remote phone dials **its own** localhost and times out |
| `allow-host` (when the tunnel forwards a name) | the proxy gets `403` before any page is served — the gate accepts only loopback and IP literals by default |

`set-public-relay` **affects only the pairing code**; the host keeps dialling its own address
and never loops out over the internet. Clear them with `set-public-relay -` / `allow-host -`.

Point the tunnel at loopback, **never** at `0.0.0.0`:

```toml
# type = tcp → reach it as http://PUBLIC_IP:7000, no allow-host needed
[[proxies]]
name = "remote-pi"
type = "tcp"
localIP = "127.0.0.1"
localPort = 4124
remotePort = 7000

# type = http → reach it by name, allow-host required
[[proxies]]
name = "remote-pi"
type = "http"
localIP = "127.0.0.1"
localPort = 4124
customDomains = ["pi.example.com"]
```

> **A LAN IP will not work.** `http://192.168.x.x:4124` is not a secure context, so the browser
> withholds `crypto.subtle` and the Ed25519 handshake fails outright. That is a platform rule,
> not an implementation gap. LAN access needs HTTPS (a self-signed certificate cannot be
> clicked through on a WebSocket), which in practice means the tunnel above.

## Optional: self-hosted or community relay

The embedded relay serves the single-machine case. Only a shared meeting point — cross-machine
Pi-to-Pi mesh, multi-device presence — needs the Rust relay in `relay/`:

```bash
docker compose -f docker-compose.relay.yml up -d   # host 3001 → container 3000
```

Point a reverse proxy or Cloudflare Tunnel at `127.0.0.1:3001` for both `https://` and
`wss://` on your domain, then:

```bash
remote-pi-server set-relay https://relay.example.com
remote-pi-server restart-supervisor
```

The community relay (`wss://relay.880160.xyz`) also works, but its operator can see your
message contents — do not use it for sensitive work.

**Skip this whole section if you are on the embedded relay.** Full trade-offs live in
[`relay/README.md`](./relay/README.md).

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
| [`relay/`](./relay) | Rust + Tokio | Optional standalone relay — only for a shared cross-machine meeting point (default uses the embedded one) |

## Architecture

```
Phone / browser / desktop client
        │  wss  (pair once — paste the code, nothing else)
        ▼
Host daemon  `pi-supervisord`   ──  room "host" · always on · survives Pi
        │  · embedded relay (default, same port)
        │  · serves the web client (same port)
        ├──►  Pi child  (`pi --mode rpc`)   ──  workspace · sessions · chat
        │
        └──►  UDS broker   ──  local agent mesh (`list_peers` / `agent_send`)
```

The default topology has **no machine in the middle**: the relay runs inside `pi-supervisord`.
Only a shared meeting point across machines swaps in the external Rust relay
([`relay/`](./relay)), and then clients dial that instead of the daemon.

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

## Relay (optional)

On the default path the relay lives inside the daemon and **this section can be skipped**.

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
