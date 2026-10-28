/**
 * Collapse the accumulated "Remote Pi Web" pairings down to the newest one.
 *
 * WHY THIS IS NEEDED: every pairing attempt mints a NEW peer key on the host, and
 * the host keeps them all (up to `MAX_PEERS`). A browser that re-pairs — which
 * happens on every clean profile, every harness run, and every `localStorage`
 * clear — leaves its previous identity behind. The host then treats those stale
 * identities as live peers, and because a child reply that does not name a
 * request is delivered to *all* active peers, one reply reaches the browser once
 * per stale identity. The client sees the same `in_reply_to` twice and reports
 * `duplicate_reply`, and the session list never settles.
 *
 * The correct fix for the product is on the host side (drop a peer when its key
 * goes away); this script exists so the local test environment is not permanently
 * poisoned by harness runs, and so a `duplicate_reply` seen during verification
 * can be told apart from a real protocol defect.
 *
 * Usage: node scripts/clean-stale-peers.mjs [--dry-run]
 */

import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PEERS = join(homedir(), ".pi", "remote", "peers.json");
const dryRun = process.argv.includes("--dry-run");

const raw = readFileSync(PEERS, "utf8");
const parsed = JSON.parse(raw);
const peers = Array.isArray(parsed) ? parsed : (parsed.peers ?? []);

/** Keep every non-web peer (real devices) and only the most recent web pairing. */
const web = peers.filter((p) => p.name === "Remote Pi Web");
const other = peers.filter((p) => p.name !== "Remote Pi Web");
const keep = [...other, ...web.slice(-1)];

console.log(`peers: ${String(peers.length)} → ${String(keep.length)}`);
console.log(`  web:   ${String(web.length)} → ${String(web.length === 0 ? 0 : 1)}`);
console.log(`  other: ${String(other.length)} (kept)`);

if (dryRun) {
  console.log("dry run: nothing written");
  process.exit(0);
}

// A timestamped backup, because this file holds the pairing identities: a wrong
// edit locks every already-paired device out and there is no undo.
const backup = `${PEERS}.bak-${String(Date.now())}`;
copyFileSync(PEERS, backup);
writeFileSync(PEERS, JSON.stringify({ peers: keep }, null, 2), "utf8");
console.log(`backup: ${backup}`);
console.log(`written: ${PEERS}`);
