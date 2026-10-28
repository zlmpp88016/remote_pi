/**
 * Real-time proof that the host-room supervision net recovers a HALF-OPEN
 * connection (one that dies without ever emitting `close`).
 *
 * This is a plain Node script rather than a vitest case on purpose: the
 * behaviour depends on real timer ordering (a 30s watchdog period plus a 3s
 * reconnect delay plus awaits inside `_connectOnce`), and faking the clock
 * introduced more error than signal. Run it directly:
 *
 *   cd server && npx tsx scripts/verify-host-supervision.mts
 *
 * It uses a controllable relay double, so it never touches the network.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pi-supervision-"));
process.env["REMOTE_PI_HOME"] = home;
process.env["REMOTE_PI_ALLOW_FILE_IDENTITY"] = "1";

const { HostBridge } = await import("../src/daemon/host_bridge.js");

class ControllableRelay extends EventEmitter {
  readonly outbound: string[] = [];
  open = true;
  connectCount = 0;
  async connect(): Promise<void> {
    this.connectCount += 1;
  }
  send(line: string): void {
    this.outbound.push(line);
  }
  close(): void {
    this.open = false;
  }
  isOpen(): boolean {
    return this.open;
  }
  /** Mirrors RelayClient.isAlive: open AND recently active. */
  isAlive(): boolean {
    return this.open && !this.silent;
  }
  /** When true, the socket still LOOKS open but no traffic arrives — the
   *  half-open state that `isOpen()` cannot distinguish from healthy. */
  silent = false;
}

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, extra = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  [PASS] ${label}${extra ? ` — ${extra}` : ""}`);
  } else {
    failures.push(label);
    console.log(`  [FAIL] ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

const fleet = {
  list: () => [],
  ensure: (cwd: string) => ({ ok: true, id: "x", cwd, name: "x" }),
  start: () => ({ ok: true, started: true }),
  stop: async () => ({ ok: true, stopped: true }),
  addWorkspace: (cwd: string) => ({ ok: true, cwd, added: true }),
  removeWorkspace: (cwd: string) => ({ ok: true, cwd, removed: true }),
};

const relays: ControllableRelay[] = [];
const bridge = new HostBridge({
  fleet: fleet as never,
  relayFactory: () => {
    const r = new ControllableRelay();
    relays.push(r);
    return r as never;
  },
  listPeersFn: async () => [],
});

console.log("\n== boot ==");
await bridge.start();
check("first connection built", relays.length === 1);

console.log("\n== healthy connection must NOT be recycled (8s) ==");
await new Promise((r) => setTimeout(r, 8_000));
check("no spurious reconnect while the socket reports open", relays.length === 1);

console.log("\n== half-open: kill it WITHOUT emitting close ==");
// The socket is dead, but nothing tells the bridge. This is the exact state
// that left the daemon parked forever with "host room online" in its log.
relays[0]!.open = false;
const before = relays.length;

// Watchdog period is 30s; the reconnect that follows adds 3s.
console.log("   waiting up to 60s for the watchdog to notice...");
const deadline = Date.now() + 60_000;
while (relays.length === before && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1_000));
}
const elapsed = Math.round((Date.now() - (deadline - 60_000)) / 1000);

check("a dead connection was rebuilt", relays.length > before, `after ${elapsed}s`);
check("the replacement is a FRESH client, not the corpse", relays[relays.length - 1] !== relays[0]);
check("the replacement is open", relays[relays.length - 1]!.open === true);

// The harder case: the socket still CLAIMS to be open but no traffic arrives.
// `isOpen()` alone cannot see this; `isAlive()` must.
console.log("\n== zombie: socket claims OPEN but has gone silent ==");
const cur = relays[relays.length - 1]!;
const beforeZombie = relays.length;
cur.silent = true; // open stays true — this is the lie
console.log("   waiting up to 60s for the watchdog to notice...");
const zombieDeadline = Date.now() + 60_000;
while (relays.length === beforeZombie && Date.now() < zombieDeadline) {
  await new Promise((r) => setTimeout(r, 1_000));
}
const zombieElapsed = Math.round((Date.now() - (zombieDeadline - 60_000)) / 1000);
check("a silent-but-open connection was rebuilt", relays.length > beforeZombie, `after ${zombieElapsed}s`);

console.log("\n== stop() must silence the net ==");
const atStop = relays.length;
await bridge.stop();
relays[relays.length - 1]!.open = false;
await new Promise((r) => setTimeout(r, 35_000));
check("no reconnect after stop()", relays.length === atStop);

rmSync(home, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
