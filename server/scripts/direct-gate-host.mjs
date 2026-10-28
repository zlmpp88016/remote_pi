/**
 * Host side of the direct-connect gate.
 *
 * Kept as a REAL FILE (not a string embedded in the gate) because inlining it
 * meant every backslash and newline passed through an outer template literal,
 * where escapes are re-interpreted: a newline escape became a real newline that
 * split a string literal, and comments containing backslashes broke parsing.
 * A file has exactly one escaping layer — its own.
 *
 * This is the same wiring `pi-supervisord --direct` performs:
 *   1. start the embedded relay,
 *   2. publish it through REMOTE_PI_RELAY (the env tier resolveRelayUrl reads),
 *   3. run a real HostBridge, which connects via resolveRelayUrl,
 *   4. build the pairing URI from the SAME resolved address.
 *
 * It prints one JSON line the gate reads: { uri, relayUrl, port }.
 */
import { startEmbeddedRelay } from "../dist/transport/embedded_relay.js";
import { HostBridge } from "../dist/daemon/host_bridge.js";
import { addWorkspace, listWorkspaces } from "../dist/daemon/workspaces.js";
import { daemonIdForCwd } from "../dist/daemon/id.js";
import { buildQRUri } from "../dist/pairing/qr.js";
import { getOrCreateEd25519Keypair } from "../dist/pairing/storage.js";
import { HostPairingSession } from "../dist/pairing/host_pairing.js";
import { HOST_ROOM_ID } from "../dist/protocol/types.js";

const relay = await startEmbeddedRelay();
const httpUrl = relay.url.replace("ws://", "http://");
process.env.REMOTE_PI_RELAY = httpUrl;

/*
 * A real workspace, so the gate can tell "listed one" from "listed nothing".
 * Registered BEFORE the bridge starts, so the first workspace_list already has
 * it.
 */
const seedCwd = process.env.DIRECT_SEED_CWD || process.cwd();
const seed = addWorkspace(seedCwd);
process.stderr.write(`[host] seeded workspace: ${seed.cwd}\n`);

const fleet = {
  list: () =>
    listWorkspaces().map((w) => ({
      id: daemonIdForCwd(w.cwd),
      cwd: w.cwd,
      name: w.name,
      live: false,
      source: "added",
    })),
  ensure: (cwd) => {
    const r = addWorkspace(cwd);
    return { ok: true, id: daemonIdForCwd(r.cwd), cwd: r.cwd, name: r.name };
  },
  start: () => ({ ok: true, started: true }),
  stop: async () => ({ ok: true, stopped: true }),
  addWorkspace: (cwd) => {
    const r = addWorkspace(cwd);
    return { ok: true, id: daemonIdForCwd(r.cwd), cwd: r.cwd, name: r.name, added: r.added };
  },
  removeWorkspace: () => ({ ok: true, removed: true }),
};

/*
 * The pairing token must be REAL: handlePairRequest calls pairing.consume(token)
 * and rejects anything else (host_control.ts:97). An invented token makes the
 * browser open the socket, receive pair_error, and fall back to the launcher —
 * which reads like a relay fault but is really a bad token.
 */
const pairing = new HostPairingSession();
const record = await pairing.issue({});

const bridge = new HostBridge({ fleet, pairing });
await bridge.start();

const kp = await getOrCreateEd25519Keypair();
const uri = buildQRUri(record.token, kp.publicKey, "lei", HOST_ROOM_ID, httpUrl);

process.stdout.write(
  JSON.stringify({ uri, relayUrl: httpUrl, port: new URL(httpUrl).port }) + "\n",
);

const shutdown = async () => {
  await bridge.stop();
  await relay.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
