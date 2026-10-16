# Remote Pi — Relay

A lightweight WebSocket relay server that connects the **Remote Pi** clients
(mobile, browser, desktop) to the **host daemon** running on your operating
system. It handles peer routing, presence, authorized Pi-to-Pi forwarding, and
signed membership metadata.

For a full overview of the project, see the
[root README](../README.md).

---

## Start

```bash
# Option A — public relay, no setup
# https://relay.880160.xyz

# Option B — self-host with Docker. No image is published: build it locally.
git clone https://github.com/exampleorg/remote_pi && cd remote_pi
docker compose -f docker-compose.relay.yml up -d

# Option C — build from source (or use the helper script)
cargo build --release
./target/release/relay
# Custom port: REMOTEPI_RELAY_PORT=8080 ./target/release/relay

# Option D — helper scripts in this directory
./run.sh                 # build (first run) + run, bare-metal
./run.sh --help          # all flags

docker compose up -d     # Option B, but using the relay-local compose
                         # (from inside this directory; named volume, same build)
```

No image is published to any registry, so every Docker path builds locally.
The \`remote-pi-relay\` tag produced by the \`docker build\` below is local-only.

Health check: `GET /health` returns `200 OK`. Details, env vars and the systemd
unit live in
[Self-hosted relay](#self-hosted-relay-recommended-for-privacy).

---

## Protocol & Security

For wire format, identity model, ACK protocol, cross-PC routing, mesh
membership, trust model, and failure modes, see
[PROTOCOL.md](../PROTOCOL.md) at the repo root. It is the canonical reference
for everything the relay enforces on the wire.

---

## How it works

Every device authenticates with an Ed25519 keypair during the WebSocket handshake
(challenge-response). The Relay then applies these content boundaries:

- For App↔Pi traffic, the outer `ct` remains opaque and is never decoded.
- Pi→Pi `pi_envelope` frames and signed membership blobs are parsed in memory only
  as needed for routing and authorization.
- No envelope body, key material, or signature is logged or persisted as a message
  payload. SQLite persistence is limited to Owner-signed membership authorization
  metadata, not message traffic.
- A route is eligible when any correctly signed Owner blob directly lists both
  canonical Pi keys. This does not prove that the Owner paired with or controls
  either Pi, and is not a stronger trust guarantee. Membership is not transitive
  across overlapping Owner blobs.
- The positive authorization cache can retain a revoked permission for at most
  60 seconds. Negative sender misses are cached for 1 second, and the cache is
  bounded.

---

## Public relay

A shared relay is available at:

```
https://relay.880160.xyz
```

You can use it to get started without any setup. However, be aware of the security
trade-offs below.

### Security considerations

Messages are protected in two ways on the public relay:

- **TLS (SSL)** — the WebSocket connection is encrypted in transit.
- **Ed25519 connection key** — challenge-response authenticates possession of the
  announced connection key. It does not itself prove App pairing or authorize every
  route.

App↔Pi pairing and room addressing are client protocol responsibilities. Pi→Pi
forwarding has separate Relay route eligibility: any correctly signed Owner blob
must directly list both Pi keys. This does not prove that the Owner paired with
or controls either Pi, and is not a stronger trust guarantee.

The shipped Relay never decodes the outer `ct` and does not log or persist message
traffic. That implementation behavior is not an end-to-end trust boundary: the
relay operator controls the TLS endpoint, executable, and host, and a compromised
or malicious operator could replace or instrument the service to inspect or retain
traffic. Pi→Pi envelope content is also parsed transiently in the Relay process for
routing and authorization.

**If you handle sensitive work — private code, credentials, proprietary data — we
strongly recommend running your own relay.**

---

## Self-hosted relay (recommended for privacy)

Running your own relay removes the shared Relay operator from the trust path and
places the TLS endpoint, executable, and storage under infrastructure you control.

### Docker (quickest)

```bash
git clone https://github.com/exampleorg/remote_pi
cd remote_pi/relay
docker build -t remote-pi-relay .

docker run -d \
  --name remote-pi-relay \
  -p 3000:3000 \
  -v remote-pi-data:/data \
  --restart unless-stopped \
  remote-pi-relay
```

`remote-pi-relay` is a local tag. There is no published image to pull, so the
`docker build` line is required. Substitute your own `registry/name` if you
publish one.

The relay listens on a **single port** (`3000` by default) and serves three
surfaces at once:

- `GET /` — WebSocket upgrade (the peer protocol)
- `GET /health` — health check (returns `200 OK`)
- `GET / POST /mesh/<owner_pk_hash>` — signed membership versions

Point your app and `remote-pi` to `ws://<your-server-ip>:3000` (or `wss://`
if you put it behind a TLS-terminating reverse proxy such as Caddy or nginx).

**`/data` volume**: the relay stores its SQLite database (signed membership
versions) at `/data/mesh.db` inside the container. Mount a named volume (as in
the example above) or a host directory (`-v /srv/remote-pi:/data`) so the state
survives `docker rm` and image upgrades. Without a mount, the database is
recreated empty each time the container starts and clients re-publish their
state at the next mutation.

### Bare-metal (no Docker)

Two options that need no container runtime.

**Quick start** — `run.sh` builds on first run, then execs the binary. It reads
the same four environment variables as the Docker image and defaults
`REMOTEPI_MESH_DB_PATH` to `./data/mesh.db` (gitignored), so `git status`
stays clean:

```bash
cd relay
./run.sh                 # build if needed, then run
./run.sh --no-build      # run only (fail if the binary is missing)
./run.sh --build         # build and exit
```

**As a systemd service** — `relay.service` is a hardened unit (dedicated
unprivileged user, `ProtectSystem=strict` with a single `ReadWritePaths`
exception for the DB). Adjust the paths and create the user first:

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin relay
sudo mkdir -p /opt/remote-pi-relay /var/lib/remote-pi-relay
sudo chown relay:relay /var/lib/remote-pi-relay

# Ship the binary + the unit
cargo build --release
sudo install -m 0755 target/release/relay /opt/remote-pi-relay/relay
sudo install -m 0644 relay.service /etc/systemd/system/remote-pi-relay.service

sudo systemctl daemon-reload
sudo systemctl enable --now remote-pi-relay
systemctl status remote-pi-relay
journalctl -u remote-pi-relay -f
```

Port `3000` is above 1024, so the service needs **no root and no
`CAP_NET_BIND_SERVICE`**.

**Docker Compose** — `docker-compose.yml` mirrors the `docker run` above with a
named volume for the DB and a healthcheck:

```bash
cd relay
RELAY_ALLOWED_ORIGINS=https://app.example.com docker compose up -d   # builds locally
docker compose logs -f
```

#### Runtime requirements

The container image bundles everything; a bare-metal install needs only:

| Need | Why | Notes |
|---|---|---|
| Linux or macOS | The relay binds TCP and writes SQLite | Windows: use Docker or WSL |
| A writable directory | SQLite stores Owner-signed membership versions | Default `./data`; parent dir is created on first boot |
| One free TCP port | WS + `/health` + `/mesh/*` share it | Default `3000`; `REMOTEPI_RELAY_PORT` |
| TLS terminator (production) | The relay speaks plain HTTP/WS | Caddy/nginx in front for `wss://` |

**No system libraries are required.** `rusqlite` is compiled with the
`bundled` feature, so SQLite is linked into the binary — there is no
`libsqlite3` dependency and no runtime package to install. The build stage
needs a Rust toolchain (1.94+, edition 2024); the produced binary is
self-contained.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `REMOTEPI_RELAY_PORT` | `3000` | TCP port that serves the WebSocket upgrade, `/health`, and `/mesh/*` (all on the same port) |
| `REMOTEPI_MESH_DB_PATH` | `/data/mesh.db` in Docker · `data/mesh.db` (cwd-relative) for bare-metal builds | Path to the SQLite database that stores signed membership versions. The parent directory is created automatically on first boot. The Docker image presets this to `/data/mesh.db` and declares `/data` as a volume — see the volume note above |
| `RELAY_ALLOWED_ORIGINS` | _(empty)_ | Comma-separated `Origin` allowlist for browser WebSocket upgrades. Empty/unset (the default) accepts every origin; when set, browser handshakes whose `Origin` is not listed are refused with `403`. See the allowlist section below |
| `RUST_LOG` | _(none)_ | Log level filter — e.g. `info`, `debug`, `warn` |

Example with a custom port and logging (volume mount is the same):

```bash
docker run -d \
  --name remote-pi-relay \
  -p 8080:8080 \
  -v remote-pi-data:/data \
  -e REMOTEPI_RELAY_PORT=8080 \
  -e RUST_LOG=info \
  --restart unless-stopped \
  remote-pi-relay        # the tag built above
```

### WebSocket origin allowlist (browser clients)

Browsers attach an `Origin` header to every WebSocket handshake. The relay
lets you restrict which origins may open **browser** connections without
affecting native clients:

```bash
docker run -d \
  --name remote-pi-relay \
  -p 3000:3000 \
  -v remote-pi-data:/data \
  -e RELAY_ALLOWED_ORIGINS="https://app.example.com,https://cockpit.example.com" \
  --restart unless-stopped \
  remote-pi-relay        # the tag built above
```

```bash
RELAY_ALLOWED_ORIGINS="https://app.example.com" RUST_LOG=info ./target/release/relay
```

- **Unset / empty / whitespace-only (default): every origin is accepted** —
  the relay's historical behaviour. Deployments that don't serve a web client
  need no change.
- **Set:** handshakes carrying an `Origin` outside the list are refused with
  `403 Forbidden` before the upgrade completes. Entries are matched
  **exactly** (case-sensitive; scheme + host + port; no wildcards and no
  paths). Browsers lowercase scheme and host, so write entries in lowercase.
- **No `Origin` header (app, `remote-pi`, Cockpit): always accepted**, so
  an active allowlist never breaks native clients.

This is a browser-context restriction, **not** an authentication mechanism —
a non-browser client can simply omit the header. WebSocket authentication
remains the Ed25519 hello/challenge handshake.

**WebSocket subprotocol echo:** if the client sends
`Sec-WebSocket-Protocol`, the relay echoes the first requested protocol back
in the `101` response. The relay frames nothing protocol-specific — the echo
only satisfies browser clients that require one. No header → no echo, which
is valid per RFC 6455.

### Mesh membership endpoint

The `/mesh/<owner_pk_hash>` endpoint stores **Owner-signed** lists of Pi keys,
keyed by `sha256(owner_pk)` in lowercase hex. It enables an app on a new device
(same Apple ID / Google account) to recover its peer list automatically after
restoring the Owner Ed25519 key from iCloud Keychain / Block Store.

The relay verifies every `POST` against the embedded `owner_pk` using Ed25519
and only accepts versions strictly greater than the current one (monotonic).
Bodies are capped at 500 KB. The relay does not create membership: it stores the
Owner-signed authorization metadata and treats Pi A↔B as route-eligible when any
correctly signed Owner blob directly lists both keys, without transitive
authorization across blobs. This does not prove that the Owner paired with or
controls either Pi, and is not a stronger trust guarantee. The shipped POST
endpoint prevents an unprivileged caller from modifying a particular Owner slot
without that Owner private key. This is not protection against Relay/operator
compromise: an operator controls the executable and SQLite authorization state.
A positive authorization cache entry can delay a revocation for at most 60
seconds; negative sender misses are cached for 1 second, and the cache is bounded.

**Self-hosting note**: the SQLite database at `REMOTEPI_MESH_DB_PATH`
(`/data/mesh.db` inside the official Docker image) is your operational
responsibility — make sure `/data` is on a persistent volume and back it up
alongside any other server state. If you lose it, clients re-publish their
current view at their next mutation.

**Storage layout**: SQLite runs in the default rollback-journal mode (NOT
WAL), so only `mesh.db` persists. During a write transaction a transient
`mesh.db-journal` may appear in the same directory and is deleted on commit.
Both files live under `REMOTEPI_MESH_DB_PATH`'s parent directory — typically
`/data/` in Docker or `data/` next to the binary on bare metal. The directory
is created automatically on first boot. This database contains membership
authorization metadata only, never message traffic.

For upgrades, deploy Relay 0.3 first: old Extensions can consume its UUID
errors. Then coordinate the Extension 0.6 rollout and minimize mixed old/new
Extensions because mixed wire-label interoperability is deferred. Extension
0.6's old-Relay error shim is for an old Relay or Relay rollback, not the reason
Relay-first is safe. The centralized rollout gates are in
[Plan 51](../plan/51-cross-pc-mesh-routing-hardening.md).

### Behind a reverse proxy (HTTPS/WSS)

For production use, put the relay behind a TLS-terminating proxy. Example Caddy config:

```
relay.yourdomain.com {
    reverse_proxy localhost:3000
}
```

Then set your app and `remote-pi` relay URL to `wss://relay.yourdomain.com`.

---

## Building from source

```bash
cargo build --release
./target/release/relay
```

```bash
REMOTEPI_RELAY_PORT=8080 RUST_LOG=info ./target/release/relay
```

## Running tests

```bash
cargo test
cargo clippy -- -D warnings
```
