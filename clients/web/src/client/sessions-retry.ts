/**
 * Retry-budget accounting for the Sessions "not ready yet" path (plan/78
 * follow-up).
 *
 * ## Why this is a module and not three inline lines
 *
 * The original code had no budget here at all, and that produced a hang that is
 * invisible in review: the branch set `busy`, armed an 800 ms timer, and the
 * timer called the same function again. Nothing decremented, nothing gave up, and
 * because the Refresh control is `disabled={busy}` the user could not even retry
 * by hand. Pulling the accounting out makes the ONE invariant — a bounded number
 * of attempts, then a terminal state — directly testable without a browser.
 *
 * ## The asymmetry that caused the bug
 *
 * Retrying a not-connected transport must NOT spend the HOST retry budget (no
 * request was sent), which is correct. But "does not spend the host budget" was
 * read as "needs no budget", and those are different statements.
 */

/** Outcome of one attempt to re-ask while the transport is down. */
export type NotReadyDecision =
  /** Arm the timer again; this is attempt number `used + 1`. */
  | { kind: "retry"; used: number }
  /** Stop asking and surface the honest failure. `used` attempts were made. */
  | { kind: "give_up"; used: number };

/**
 * Decides whether another "transport not ready" retry is allowed.
 *
 * `used` is how many retries have already been consumed. A budget of `budget`
 * allows exactly `budget` retries: the `budget + 1`-th call gives up. That is
 * pinned by test because an off-by-one here means either one fewer attempt than
 * configured (harmless) or an unbounded loop (the bug).
 */
export function decideNotReadyRetry(used: number, budget: number): NotReadyDecision {
  if (budget <= 0) return { kind: "give_up", used };
  if (used >= budget) return { kind: "give_up", used };
  return { kind: "retry", used: used + 1 };
}
