/**
 * Plan 86 P3 — the React seam for host-native history.
 *
 * WHAT THIS HOOK OWNS, AND WHAT IT DELIBERATELY DOES NOT
 *
 * The rules (single-flight, promotion, epochs, paging identity, cache budgets)
 * live in `history-query.ts` / `history-list.ts` as plain classes, because they
 * are state machines rather than rendering concerns. This hook only:
 *
 *   • creates ONE controller pair per adapter binding generation and disposes it
 *     with the binding (a reconnect must not inherit another connection's cache
 *     or in-flight requests);
 *   • wires the ports to `adapter.sendHistory` and the barrier stream to
 *     `HistoryQueryController.onBarrier`;
 *   • turns controller notifications into a render tick;
 *   • records the scalar metric ring the acceptance report reads.
 *
 * It is intentionally not a "data fetching hook": nothing here decides WHEN to
 * read. The container does, at the two moments that matter (a pointer crossing a
 * row, and a click), which is what keeps hover → click a single request.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { RemotePiAdapter } from "@/lib/remote-pi/adapter";
import {
  supportsWorkspaceHistory,
  type HistoryBodyRef,
  type HistoryFailure,
  type HistoryMetricsSample,
  type HistoryScope,
} from "@/lib/remote-pi/history";
import { registerHistoryProbeSource } from "@/lib/remote-pi/history-probe";
import { HistoryCache, HistoryListCache } from "@/lib/remote-pi/history-cache";
import { HistoryListController, type HistoryListView } from "@/lib/remote-pi/history-list";
import { HistoryQueryController, type BodyResult, type HistoryPriority, type HistoryView } from "@/lib/remote-pi/history-query";

/** How many metric samples the diagnostic ring keeps. */
const METRIC_RING = 200;

export interface HistoryMetricRecord extends HistoryMetricsSample {
  /** Wall-clock ms at which the sample was recorded (diagnostics only). */
  at: number;
}

/**
 * Process-wide scalar metric ring.
 *
 * Module-level so the acceptance bench can read it after driving the modules,
 * and so a component remount does not lose the samples that explain a slow open.
 * Never contains message text, ids beyond the request id, or credentials.
 */
const metricRing: HistoryMetricRecord[] = [];

/** Record one already-sanitised sample. */
export function recordHistoryMetric(sample: HistoryMetricsSample): void {
  metricRing.push({ ...sample, at: Date.now() });
  if (metricRing.length > METRIC_RING) metricRing.splice(0, metricRing.length - METRIC_RING);
}

/** Recent samples (oldest first), for diagnostics and the acceptance bench. */
export function historyMetricsSnapshot(): readonly HistoryMetricRecord[] {
  return [...metricRing];
}

/** Drop the ring (tests, and a fresh measurement run). */
export function clearHistoryMetrics(): void {
  metricRing.length = 0;
}

/**
 * The renderside half: plain snapshots, recomputed when either controller
 * notifies. Nothing here is a ref, so reading it during render is safe.
 */
export interface HistoryRenderState {
  /** True when the host announced `workspace_history_v1`. */
  readonly available: boolean;
  /** Host + active workspace identity, or null when there is nothing to read. */
  readonly scope: HistoryScope | null;
  /** Snapshot of the OPEN session's transcript, or null. */
  readonly view: HistoryView | null;
  /** Snapshot of the active workspace's session list, or null. */
  readonly listView: HistoryListView | null;
}

/** The action half: called from handlers/effects only, never during render. */
export interface HistoryHostActions {
  openSession: (sessionId: string, priority: HistoryPriority, subscriber: string) => void;
  promoteSession: (sessionId: string, subscriber: string) => boolean;
  leaveSession: (sessionId: string, subscriber: string) => void;
  loadOlder: (sessionId: string) => void;
  loadBody: (sessionId: string, ref: HistoryBodyRef, mode: "preview" | "full") => Promise<BodyResult>;
  /** `loadOlder` for the session currently on screen. */
  loadOlderForViewing: () => void;
  loadNewerForViewing: () => void;
  showHeadForViewing: () => void;
  /** `loadBody` for the session currently on screen. */
  loadBodyForViewing: (ref: HistoryBodyRef, mode: "preview" | "full") => Promise<BodyResult>;
  /** Release the viewer's interest in whatever it is showing. */
  leaveViewing: () => void;
  openList: () => void;
  refreshList: () => void;
  loadMoreSessions: () => void;
  invalidateSession: (sessionId: string) => void;
  /** The ACTIVE workspace was deleted: drop everything cached for it. */
  invalidateWorkspace: () => void;
  /** Consume an inbound frame if it belongs to either controller. */
  feed: (msg: unknown) => boolean;
  /** Connection generation changed: drop everything attributable to it. */
  reset: () => void;
}

export interface HistoryHostApi extends HistoryRenderState {
  readonly actions: HistoryHostActions;
}

interface Controllers {
  generation: number;
  /** The adapter this pair was built for: a re-pair rebuilds, never reuses. */
  adapter: RemotePiAdapter;
  host: string;
  query: HistoryQueryController;
  list: HistoryListController;
  hostCache: HistoryCache;
  hostListCache: HistoryListCache;
  /** Release the transport subscriptions (barrier + both notice streams). */
  off: () => void;
}

export interface UseHostHistoryParams {
  /** The live adapter, or null while there is no binding. */
  adapter: RemotePiAdapter | null;
  /** Adapter state generation: a new number means a new connection. */
  generation: number;
  /** Host capabilities from `host_hello_ok`. */
  capabilities: readonly string[] | null | undefined;
  /** Active workspace's `daemon_id` (never a path). */
  daemonId: string | null;
  /**
   * The session the viewer is showing, when one is open.
   *
   * Passed IN so the hook can publish `view` as plain render data and bind the
   * viewing-scoped actions itself. That keeps the container from reading the
   * session store's viewed id once per derived value — one read, one place.
   */
  viewingSessionId: string | null;
}

/**
 * Bind the controllers to one connection.
 *
 * CREATION IS LAZY, NEVER DURING RENDER. The controllers are built on the first
 * callback that needs them (the container opens the list from an effect, and a
 * click/hover comes from a handler), so there is no setState inside an effect and
 * no controller created for a render that never reads anything. A rollover to a
 * new adapter/generation disposes the previous pair FIRST: a stale subscription
 * must not deliver into the new connection's view.
 *
 * The controller pair is STATE because `view()` / `listView()` are called during
 * render — reading the ref there would be the very pattern the hooks lint rule
 * forbids — while the callbacks below read the ref, which is always current.
 */
export function useHostHistory(params: UseHostHistoryParams): HistoryHostApi {
  const available = supportsWorkspaceHistory(params.capabilities);
  const [tick, setTick] = useState(0);
  const [controllers, setControllers] = useState<Controllers | null>(null);
  const controllersRef = useRef<Controllers | null>(null);

  const adapter = params.adapter;
  const generation = params.generation;
  const hostPeer = adapter?.boundHostPeer ?? null;

  const dispose = useCallback((target: Controllers): void => {
    target.off();
    target.query.invalidateAll();
    target.list.invalidateAll();
  }, []);

  /** Create (or roll over) the pair. Called from handlers/effects only. */
  const ensure = useCallback((): Controllers | null => {
    if (!available || adapter === null || adapter.boundHostPeer === null) return null;
    const current = controllersRef.current;
    if (current !== null && current.generation === generation && current.adapter === adapter) {
      return current;
    }
    if (current !== null) dispose(current);
    const host = adapter.boundHostPeer;
    const hostCache = new HistoryCache();
    const hostListCache = new HistoryListCache();
    const query = new HistoryQueryController({
      cache: hostCache,
      listCache: hostListCache,
      ports: {
        sendList: (request, priority) => {
          adapter.sendHistory(request, priority);
        },
        sendRead: (request, priority) => {
          adapter.sendHistory(request, priority);
        },
        sendBody: (request, priority) => {
          adapter.sendHistory(request, priority);
        },
        makeId: () => makeRequestId(),
        reprioritize: (requestId, priority) => {
          adapter.reprioritizeHistory(requestId, priority);
        },
        metrics: recordHistoryMetric,
      },
    });
    const list = new HistoryListController({
      cache: hostListCache,
      ports: {
        sendList: (request, priority) => {
          adapter.sendHistory(request, priority);
        },
        makeId: () => makeRequestId(),
        metrics: recordHistoryMetric,
      },
    });
    const bump = (): void => setTick((value) => value + 1);
    const offProbe = registerHistoryProbeSource("query", () => query.diagnostics());
    const offListProbe = registerHistoryProbeSource("list", () => list.diagnostics());
    const offQuery = query.subscribe(bump);
    const offList = list.subscribe(bump);
    const offBarrier = adapter.onHistoryBarrier((event) => {
      query.onBarrier(event.epoch, event.cleared);
    });
    const next: Controllers = {
      generation,
      adapter,
      host,
      query,
      list,
      hostCache,
      hostListCache,
      off: () => {
        offQuery();
        offProbe();
        offListProbe();
        offList();
        offBarrier();
      },
    };
    controllersRef.current = next;
    setControllers(next);
    return next;
  }, [adapter, dispose, generation, available]);

  /* Unmount: release the subscriptions. Reads the ref inside a cleanup, which is
   * not a render. */
  useEffect(
    () => () => {
      const current = controllersRef.current;
      controllersRef.current = null;
      if (current !== null) dispose(current);
    },
    [dispose],
  );

  /* Memoised so the callbacks below keep a stable identity: a fresh scope object
   * on every render would rebuild every handler and defeat the memo boundaries
   * downstream. */
  const scope: HistoryScope | null = useMemo(
    () =>
      available && hostPeer !== null && params.daemonId !== null
        ? { host: hostPeer, daemon_id: params.daemonId }
        : null,
    [available, hostPeer, params.daemonId],
  );

  useEffect(() => () => {
    const current = controllersRef.current;
    if (current !== null && scope !== null) {
      current.query.releaseScope(scope);
      current.list.releaseScope(scope);
    }
  }, [scope]);

  /* The viewed session id is needed by ACTION closures too; a ref keeps them
   * stable without re-creating every handler on each render. */
  const viewingRef = useRef<string | null>(params.viewingSessionId);
  useEffect(() => {
    viewingRef.current = params.viewingSessionId;
  }, [params.viewingSessionId]);

  /* RENDER DATA. `controllers` is state, so this recomputes exactly when a
   * controller notified (via the tick) or the scope changed — never per keystroke. */
  const view: HistoryView | null = useMemo(() => {
    // Controller notifications are the revision of these mutable stores.
    void tick;
    if (controllers === null || controllers.adapter !== adapter || controllers.generation !== generation || scope === null || params.viewingSessionId === null) return null;
    return controllers.query.view(scope, params.viewingSessionId);
  }, [controllers, adapter, generation, params.viewingSessionId, scope, tick]);

  const listView: HistoryListView | null = useMemo(() => {
    void tick;
    if (controllers === null || controllers.adapter !== adapter || controllers.generation !== generation || scope === null) return null;
    return controllers.list.view(scope);
  }, [controllers, adapter, generation, scope, tick]);

  const openSession = useCallback(
    (sessionId: string, priority: HistoryPriority, subscriber: string): void => {
      const current = ensure();
      if (current === null || scope === null) return;
      current.query.open(scope, sessionId, { subscriber, priority });
    },
    [ensure, scope],
  );

  const promoteSession = useCallback(
    (sessionId: string, subscriber: string): boolean => {
      const current = ensure();
      if (current === null || scope === null) return false;
      return current.query.promote(scope, sessionId, subscriber);
    },
    [ensure, scope],
  );

  const leaveSession = useCallback(
    (sessionId: string, subscriber: string): void => {
      const current = controllersRef.current;
      if (current === null || scope === null) return;
      current.query.leave(scope, sessionId, subscriber);
    },
    [scope],
  );

  const loadOlder = useCallback(
    (sessionId: string): void => {
      const current = ensure();
      if (current === null || scope === null) return;
      current.query.loadOlder(scope, sessionId);
    },
    [ensure, scope],
  );

  const loadBody = useCallback(
    (sessionId: string, ref: HistoryBodyRef, mode: "preview" | "full"): Promise<BodyResult> => {
      const current = ensure();
      if (current === null || scope === null) {
        return Promise.resolve({ ok: false, code: "transport", detail: "no history connection" } as HistoryFailure);
      }
      const snapshot = current.query.view(scope, sessionId)?.snapshot ?? "";
      return current.query.loadBody(scope, sessionId, { snapshot, ref, mode });
    },
    [ensure, scope],
  );

  const loadOlderForViewing = useCallback((): void => {
    const sessionId = viewingRef.current;
    if (sessionId !== null) loadOlder(sessionId);
  }, [loadOlder]);

  const loadNewerForViewing = useCallback((): void => {
    const sessionId = viewingRef.current;
    const current = controllersRef.current;
    if (current !== null && scope !== null && sessionId !== null) current.query.loadNewer(scope, sessionId);
  }, [scope]);

  const showHeadForViewing = useCallback((): void => {
    const sessionId = viewingRef.current;
    const current = controllersRef.current;
    if (current !== null && scope !== null && sessionId !== null) current.query.showHead(scope, sessionId);
  }, [scope]);

  const loadBodyForViewing = useCallback(
    (ref: HistoryBodyRef, mode: "preview" | "full"): Promise<BodyResult> => {
      const sessionId = viewingRef.current;
      if (sessionId === null) {
        return Promise.resolve({ ok: false, code: "transport", detail: "no viewed session" } as HistoryFailure);
      }
      return loadBody(sessionId, ref, mode);
    },
    [loadBody],
  );

  const leaveViewing = useCallback((): void => {
    const sessionId = viewingRef.current;
    if (sessionId !== null) leaveSession(sessionId, "viewer");
  }, [leaveSession]);

  const openList = useCallback((): void => {
    const current = ensure();
    if (current === null || scope === null) return;
    current.list.open(scope);
  }, [ensure, scope]);

  const refreshList = useCallback((): void => {
    const current = ensure();
    if (current === null || scope === null) return;
    current.list.refresh(scope);
  }, [ensure, scope]);

  const loadMoreSessions = useCallback((): void => {
    const current = ensure();
    if (current === null || scope === null) return;
    current.list.loadMore(scope);
  }, [ensure, scope]);

  const invalidateSession = useCallback(
    (sessionId: string): void => {
      const current = controllersRef.current;
      if (current === null || scope === null) return;
      current.query.invalidateSession(scope, sessionId);
    },
    [scope],
  );

  const invalidateWorkspace = useCallback((): void => {
    const current = controllersRef.current;
    if (current === null || scope === null) return;
    current.query.invalidateScope(scope);
    current.list.invalidateScope(scope);
  }, [scope]);

  const feed = useCallback((msg: unknown): boolean => {
    const current = controllersRef.current;
    if (current === null) return false;
    // Reads and bodies first: their reply TYPES are unambiguous. A typed
    // `history_error` is then routed by its request id in whichever controller
    // owns it.
    if (current.query.onFrame(msg)) return true;
    return current.list.onFrame(msg);
  }, []);

  const reset = useCallback((): void => {
    const current = controllersRef.current;
    controllersRef.current = null;
    if (current !== null) dispose(current);
    setControllers(null);
  }, [dispose]);

  const actions = useMemo<HistoryHostActions>(
    () => ({
      openSession,
      promoteSession,
      leaveSession,
      loadOlder,
      loadBody,
      loadOlderForViewing,
      loadNewerForViewing,
      showHeadForViewing,
      loadBodyForViewing,
      leaveViewing,
      openList,
      refreshList,
      loadMoreSessions,
      invalidateSession,
      invalidateWorkspace,
      feed,
      reset,
    }),
    [
      openSession,
      promoteSession,
      leaveSession,
      loadOlder,
      loadBody,
      loadOlderForViewing,
      loadNewerForViewing,
      showHeadForViewing,
      loadBodyForViewing,
      leaveViewing,
      openList,
      refreshList,
      loadMoreSessions,
      invalidateSession,
      invalidateWorkspace,
      feed,
      reset,
    ],
  );

  return useMemo<HistoryHostApi>(
    () => ({ available, scope, view, listView, actions }),
    [available, scope, view, listView, actions],
  );
}

/** Request id, matching the client's own generator shape. */
function makeRequestId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (crypto !== undefined && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `hist-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}
