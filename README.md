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

## Links

- **Official site** — <https://remote-pi.jacobmoura.work>
- **Package documentation** — <https://pi.dev/packages/remote-pi?name=remote-pi>
- **GitHub** — <https://github.com/jacobaraujo7/remote_pi>

### Downloads

| Platform | Status |
|---|---|
| Google Play (Android) | [Get it on Google Play](https://play.google.com/store/apps/details?id=work.jacobmoura.remotepi) |
| App Store (iOS) | [Download on the App Store](https://apps.apple.com/app/remote-pi-coding-agent/id6773499691) |
| APK (sideload, Android) | [GitHub Releases](https://github.com/jacobaraujo7/remote_pi/releases) |
| Desktop (Cockpit) | [GitHub Releases](https://github.com/jacobaraujo7/remote_pi/releases?q=cockpit-v) |

## What's in this repo

Remote Pi is not a single plug-in — it is the whole system that runs and manages Pi on a machine,
plus the clients that reach it.

| Package | Stack | Role |
|---|---|---|
| [`server/`](./remote-pi) | Node + TypeScript | **Daemon and control plane** — the `pi-supervisord` host daemon, the `remote-pi` CLI, the `/remote-pi` Pi command, and the local agent mesh |
| [`app/`](./app) | Flutter (iOS / Android) | Mobile client (operator console) |
| [`cockpit/`](./cockpit) | Flutter Desktop | Desktop client (macOS / Windows / Linux, + iPad / Android) |
| [`site/`](./site) | NextJS | Landing page, docs, and the browser client |
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

Install the package globally so the `remote-pi` CLI and the `pi-supervisord`
daemon are on your PATH:

```bash
npm install -g remote-pi
```

Install the daemon as a user-level system service (Linux `systemd --user`, macOS
launchd, Windows Task Scheduler). It auto-starts at login and survives reboots:

```bash
remote-pi install
```

The daemon comes up, connects to the relay, and holds the machine online — with
**no Pi running**.

### 2. Pair a client

Pair from the daemon itself (no Pi needed):

```bash
remote-pi pair        # prints the address + one-time/persistent code
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

## Status

The MVP is functional. Planning notes and roadmap live in [`plan/`](./plan).

## License

License is per-package — see each subproject's `LICENSE` file (the `remote-pi`
is MIT). A repository-wide license decision is pending.
