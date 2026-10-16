#!/usr/bin/env bash
# Remote Pi relay — start bare-metal (no Docker).
#
# Builds on first run if the release binary is missing, then execs it.
# Everything the relay needs at runtime is in this file's env block below.
#
# Usage:
#   ./run.sh                      # build if needed, then run
#   ./run.sh --no-build           # run only (fail if binary missing)
#   ./run.sh --build              # build and exit (no run)
#
# Requirements:
#   - Linux/macOS (Windows: use Docker or WSL — the relay binds TCP only, but
#     this script uses POSIX tooling)
#   - Rust toolchain (only to build: https://rustup.rs). Runtime has NO
#     dependencies: `rusqlite` is compiled with the `bundled` feature, so
#     SQLite is linked into the binary — no libsqlite3 on the host.
#   - A writable directory for the SQLite file (default: ./data)
#   - One free TCP port (default: 3000), reachable from your clients

set -euo pipefail

# Absolutizar o diretório do script ANTES do `cd`: depois do cd, `$0`
# (caminho relativo, ex.: `relay/run.sh`) deixa de resolver e o `--help`
# falha com "sed: can't read relay/run.sh: No such file or directory".
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$SELF")"

# ── Environment ───────────────────────────────────────────────────────────────
# All four knobs the relay reads. Override any of them from the shell; the
# values below are the same defaults the Docker image uses (except the DB path,
# which defaults to a cwd-relative dir so bare-metal runs don't write to /data).

# TCP port serving WebSocket + /health + /mesh/* (all on the same port).
export REMOTEPI_RELAY_PORT="${REMOTEPI_RELAY_PORT:-3000}"

# SQLite database holding Owner-signed membership versions. Parent dir is
# created on first boot by the relay itself. Kept inside the repo dir and
# gitignored (`/data`), so `git status` stays clean.
export REMOTEPI_MESH_DB_PATH="${REMOTEPI_MESH_DB_PATH:-$PWD/data/mesh.db}"

# Comma-separated Origin allowlist for BROWSER WebSocket upgrades.
# Empty/unset (default) accepts every origin; native clients (app, remote-pi,
# Cockpit) send no Origin and are always accepted regardless.
export RELAY_ALLOWED_ORIGINS="${RELAY_ALLOWED_ORIGINS:-}"

# Outer-envelope size ceiling, in MiB. Default inside the binary is 4.
export RELAY_MAX_CT_MIB="${RELAY_MAX_CT_MIB:-4}"

# Log level filter (tracing). `info` is the useful default; `debug` is noisy.
export RUST_LOG="${RUST_LOG:-info}"

# ── Flags ─────────────────────────────────────────────────────────────────────
BUILD=auto
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=no ;;
    --build)    BUILD=yes ;;
    -h|--help)
      # `$SELF` (absoluto) e não `$0`: já estamos dentro do diretório do script.
      sed -n '2,20p' "$SELF" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "✗ Unknown argument: $arg" >&2
      echo "  Usage: $0 [--no-build|--build|--help]" >&2
      exit 2
      ;;
  esac
done

BIN="target/release/relay"

# ── Build ─────────────────────────────────────────────────────────────────────
if [[ "$BUILD" != "no" && ! -x "$BIN" ]]; then
  if ! command -v cargo >/dev/null 2>&1; then
    echo "✗ $BIN not found and cargo is not installed." >&2
    echo "  Install Rust from https://rustup.rs, or build the container from the repo:" >&2
    echo "    git clone https://github.com/exampleorg/remote_pi && cd remote_pi" >&2
    echo "    docker compose -f docker-compose.relay.yml up -d" >&2
    exit 1
  fi
  echo "→ Building release binary (first run)…"
  cargo build --release
fi

if [[ "$BUILD" == "yes" ]]; then
  echo "✓ Built $BIN"
  exit 0
fi

if [[ ! -x "$BIN" ]]; then
  echo "✗ $BIN not found. Run without --no-build to build it." >&2
  exit 1
fi

# ── Preflight ─────────────────────────────────────────────────────────────────
DB_DIR="$(dirname "$REMOTEPI_MESH_DB_PATH")"
if ! mkdir -p "$DB_DIR" 2>/dev/null; then
  echo "✗ Cannot create the DB directory: $DB_DIR" >&2
  echo "  Set REMOTEPI_MESH_DB_PATH to a writable location." >&2
  exit 1
fi
if [[ ! -w "$DB_DIR" ]]; then
  echo "✗ DB directory is not writable: $DB_DIR" >&2
  exit 1
fi

# Warn (don't fail) if the port is already taken: the relay would fail to bind
# with a clear error anyway, but catching it here is friendlier.
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":${REMOTEPI_RELAY_PORT} "; then
  echo "✗ Port ${REMOTEPI_RELAY_PORT} is already in use." >&2
  echo "  Set REMOTEPI_RELAY_PORT to a free port." >&2
  exit 1
fi

echo "→ relay listening on 0.0.0.0:${REMOTEPI_RELAY_PORT}"
echo "  health:  http://localhost:${REMOTEPI_RELAY_PORT}/health"
echo "  ws:      ws://localhost:${REMOTEPI_RELAY_PORT}/"
echo "  mesh:    http://localhost:${REMOTEPI_RELAY_PORT}/mesh/<owner_pk_hash>"
echo "  db:      ${REMOTEPI_MESH_DB_PATH}"
[[ -n "$RELAY_ALLOWED_ORIGINS" ]] \
  && echo "  origins: ${RELAY_ALLOWED_ORIGINS} (browser allowlist ACTIVE)" \
  || echo "  origins: (unrestricted — every browser origin accepted)"
echo

# `exec` so the shell is replaced: Ctrl-C and signals (docker stop, systemd
# stop) reach the relay directly instead of being swallowed by the wrapper.
exec "$BIN"
