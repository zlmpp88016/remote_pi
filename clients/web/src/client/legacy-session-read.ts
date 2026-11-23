/** Legacy-host foreground read. Request and watchdog ownership live together in
 * the session store; prefetch is separate and never opens a viewer. */
import type { SessionActions } from "./use-session-store";
import { SESSION_READ_FAILED, SESSION_READ_TIMEOUT_MS } from "./notices";

export interface LegacySessionReadRequest {
  id: string;
  room: string;
  sessionId: string;
}

export function ownsLegacySessionRead(
  pending: LegacySessionReadRequest | null,
  room: string,
  inReplyTo: unknown,
): pending is LegacySessionReadRequest {
  return pending !== null && pending.room === room && pending.id === inReplyTo;
}

export function openLegacySessionRead(
  actions: SessionActions,
  room: string,
  sessionId: string,
  send: () => string,
  timeoutMs = SESSION_READ_TIMEOUT_MS,
): void {
  actions.retireRead();
  const cached = actions.takeRead(sessionId);
  if (cached !== null) {
    actions.applyRead(sessionId, cached);
    return;
  }
  actions.beginRead(sessionId);
  try {
    const id = send();
    actions.readReq.current = { id, room, sessionId };
    actions.scheduleReadTimeout(id, timeoutMs, () => actions.setNotice(SESSION_READ_FAILED));
  } catch {
    actions.retireRead();
    actions.setNotice(SESSION_READ_FAILED);
  }
}
