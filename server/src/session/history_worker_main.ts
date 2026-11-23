/**
 * Plan 86 P2 — `worker_threads` entry for the host history workers.
 *
 * TWO roles share this entry:
 *   writer — the only SQLite writer (schema/migration/upsert/delete/generation)
 *   reader — a read-only connection + body sidecar
 *
 * `workerData.role` selects the role; the role is enforced per thread so a
 * reader message can never reach the writer connection (and vice versa). Kept
 * intentionally tiny: the implementation lives in `history_worker.ts` so the
 * SAME handler runs under a real Worker thread and under the inline test shim.
 * Nothing here imports the SDK or the supervisor.
 */

import { parentPort, workerData } from "node:worker_threads";
import { attachHistoryWorker, type HistoryWorkerRole } from "./history_worker.js";

const role: HistoryWorkerRole =
  typeof workerData === "object" && workerData !== null && (workerData as { role?: unknown }).role === "writer"
    ? "writer"
    : "reader";

if (parentPort !== null) {
  attachHistoryWorker(parentPort, role);
}
