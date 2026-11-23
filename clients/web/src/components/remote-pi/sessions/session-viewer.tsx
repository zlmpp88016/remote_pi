"use client";

/* Read-only viewer for a session that is NOT the live one.
 *
 * This is the whole point of the split: clicking a session in the dock READS it
 * and shows the transcript here, without changing the workspace Pi's active
 * session. Reading is a pure disk read on the host, so it is instant and safe to
 * do casually, as often as you like.
 *
 * Resuming is the opposite kind of action: it exits the daemon and the
 * supervisor respawns a new Pi onto the target session file, which is why it is
 * ONE explicit button here rather than a control on every row. The button is
 * also the only place that states the consequence before it happens.
 *
 * ── Plan 86 P3: paged, windowed, honest ────────────────────────────────────
 *
 * Three things changed here, and each is a correctness rule rather than a
 * preference:
 *
 *  1. WINDOWED. A long history is loaded in pages; mounting every row means the
 *     DOM grows with each page and a hundred pages of Markdown is paid for on
 *     every scroll frame. Only the visible range plus a near-viewport overscan
 *     is mounted, with exact spacer heights so the scroll box keeps its size and
 *     the scroll position is preserved (see `virtual-window.ts`).
 *  2. PAGED. "Load older" consumes the host's opaque `older_cursor` and merges by
 *     stable `event_id` (never by array index). A prepended page does not move
 *     what the reader is looking at: the anchor row and its on-screen offset are
 *     captured BEFORE the request and restored after the items change.
 *  3. HONEST. A cache-first paint is labelled `stale`; a host `truncated` item is
 *     labelled `partial`; a bounded body preview can be expanded explicitly, and
 *     a `body_too_large` refusal is shown as a refusal, never as empty content.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../core/icons";
import { Markdown } from "../chat/markdown";
import css from "./session-viewer.module.css";
import type { HistoryBodyRef, HistoryFailure } from "@/lib/remote-pi/history";
import type { WireSessionEvent } from "@/lib/remote-pi/protocol";
import { sessionLabel, type WireSessionInfo } from "@/lib/remote-pi/sessions";
import { historyProbeCount, registerHistoryProbeSource } from "@/lib/remote-pi/history-probe";
import { captureRowAnchor, pruneRowHeights, restoreRowAnchor, type RowAnchor } from "./viewer-state";
import {
  computeWindow,
  DEFAULT_MAX_RENDERED,
  type VirtualWindow,
} from "./virtual-window";

/**
 * Project history items onto the viewer's row shape.
 *
 * `key` is the host's stable `event_id` and `partial` is the host's own
 * `truncated` flag — never inferred from a preview's length, because a preview
 * that LOOKS short may simply be a short value.
 */
export function toViewerRows(
  items: readonly import("@/lib/remote-pi/history").HistoryItem[],
): readonly ViewerRow[] {
  historyProbeCount("rowProjection");
  return items.map((item) => ({
    key: item.event_id,
    event: item.event,
    partial: item.truncated === true,
    ...(item.body_refs === undefined ? {} : { bodyRefs: item.body_refs }),
  }));
}

/** One mountable row. `key` is the host's stable `event_id`. */
export interface ViewerRow {
  key: string;
  event: WireSessionEvent;
  /** True when the host marked this item as PARTIAL (`truncated`). */
  partial: boolean;
  /** Large payloads the wire could not carry inline. */
  bodyRefs?: readonly HistoryBodyRef[];
}

export interface SessionViewerProps {
  /** The session being read (from the list). */
  session: WireSessionInfo;
  /** Its transcript rows, oldest-first, or null while the first read is in flight. */
  rows: readonly ViewerRow[] | null;
  /** True while the FIRST page is in flight and nothing is painted. */
  loading: boolean;
  /** Fixed, client-authored failure text, or null. */
  notice: string | null;
  /** Closes the viewer and returns to the live transcript. */
  onClose: () => void;
  /** SWITCHES the live session to this one (the state-changing control). */
  onSwitch: () => void;
  /** True while the switch is in flight (the host is respawning onto it). */
  switchBusy?: boolean;
  /** Host-stated capability; false renders the control inert with a reason. */
  canSwitch?: boolean;
  /** True when this session is ALSO the live one (it cannot be switched to). */
  isLive: boolean;
  /** Painted from cache and not yet confirmed by a live reply. */
  stale?: boolean;
  /** The host says an older page exists. */
  hasOlder?: boolean;
  /** An older page is in flight. */
  loadingOlder?: boolean;
  /** Consume `older_cursor`. */
  onLoadOlder?: () => void;
  hasNewer?: boolean;
  loadingNewer?: boolean;
  onLoadNewer?: () => void;
  onShowHead?: () => void;
  /** Zero-based host pagination positions within the current snapshot. */
  pageStart?: number;
  pageEnd?: number;
  /** Materialize one large field, or return its typed refusal. */
  onLoadBody?: (ref: HistoryBodyRef, mode: "preview" | "full") => Promise<BodyLoad>;
  /** Resolved palette for the Markdown render cache (`light` | `dark`). */
  theme?: string;
}

/** Result shape of `onLoadBody` — the typed refusal is rendered verbatim-ish. */
export type BodyLoad =
  | { ok: true; text: string | null }
  | { ok: false; code: HistoryFailure["code"]; detail?: string };

/**
 * Rough row height before it has been measured.
 *
 * Only used until the row has been mounted once; an estimate only has to be
 * close enough that the scrollbar does not jump on the first pass.
 */
function estimateRowHeight(event: WireSessionEvent): number {
  const textLength =
    event.type === "user_input" || event.type === "agent_message"
      ? event.text.length
      : event.type === "compaction"
        ? event.summary.length
        : 0;
  if (event.type === "tool_request" || event.type === "tool_result") return 34;
  if (event.type === "compaction") return 38;
  const base = event.type === "user_input" ? 62 : 92;
  const lines = Math.ceil(Math.max(1, textLength) / 72);
  return Math.min(520, base + lines * 19);
}

/** One rendered row. Tool calls are summarised, not expanded: this is a
 *  transcript read, not a debugging surface. */
const EventRow = memo(function EventRow({
  row,
  theme,
  width,
  onLoadBody,
}: {
  row: ViewerRow;
  theme: string;
  width: number;
  onLoadBody?: SessionViewerProps["onLoadBody"];
}) {
  const { event } = row;
  const body =
    row.bodyRefs === undefined || row.bodyRefs.length === 0 ? null : (
      <BodyRefs refs={row.bodyRefs} onLoadBody={onLoadBody} />
    );
  /** PARTIAL is a host statement (item.truncated); it is never inferred. */
  const marker =
    row.partial === true ? (
      <span className={css.partialChip} title="The host returned only part of this item.">
        partial
      </span>
    ) : null;

  if (event.type === "user_input") {
    return (
      <div className={css.userTurn}>
        <div className={css.userBubble}>
          {event.text}
          {body}
        </div>
      </div>
    );
  }
  if (event.type === "agent_message") {
    return (
      <div className={css.agentTurn}>
        <div className={css.agentHead}>
          <span className={css.agentMark}>
            <Icon name="cpu" size={12} />
          </span>
          <b className={css.agentName} style={{ fontFamily: "var(--ff-display)" }}>
            Pi
          </b>
          {marker}
        </div>
        <div className={css.agentBody}>
          <Markdown text={event.text} cacheIdentity={{ theme, width }} />
          {body}
        </div>
      </div>
    );
  }
  if (event.type === "tool_request") {
    return (
      <div className={css.toolRow}>
        <Icon name="term" size={11} />
        <span className={css.toolName}>{event.tool}</span>
        {body}
      </div>
    );
  }
  if (event.type === "tool_result") {
    // An `error` is a FLAG: its text is host/tool output and is not rendered.
    return (
      <div className={css.toolResult}>
        <span className={event.error === undefined ? css.ok : css.error}>
          {event.error === undefined ? "ok" : "failed"}
        </span>
        {body}
      </div>
    );
  }
  return (
    <div className={css.marker}>
      <Icon name="refresh" size={11} />
      <span>context compacted ({event.tokens_before} tokens before)</span>
    </div>
  );
});

/**
 * Large-field expansion.
 *
 * The wire carries a bounded PREVIEW for a payload the event cannot hold inline
 * (object `args`, binary images, text over the row budget). Expanding is an
 * EXPLICIT action: it costs a `history_body` round trip per 64 KiB chunk, so it
 * never happens implicitly while scrolling.
 */
function BodyRefs({
  refs,
  onLoadBody,
}: {
  refs: readonly HistoryBodyRef[];
  onLoadBody?: SessionViewerProps["onLoadBody"];
}) {
  const [state, setState] = useState<Record<string, { busy: boolean; text: string | null; failure: string | null }>>({});

  const expand = useCallback(
    (ref: HistoryBodyRef) => {
      if (onLoadBody === undefined) return;
      const id = `${ref.field}|${ref.ref}`;
      setState((prev) => ({ ...prev, [id]: { busy: true, text: null, failure: null } }));
      void onLoadBody(ref, "full")
        .then((result) => {
          setState((prev) => ({
            ...prev,
            [id]:
              result.ok && result.text !== null
                ? { busy: false, text: result.text, failure: null }
                : {
                    busy: false,
                    text: null,
                    failure:
                      result.ok === false
                        ? result.code === "body_too_large"
                          ? "too large to load in full"
                          : `could not load (${result.code})`
                        : "no text for this field",
                  },
          }));
        })
        .catch(() => {
          setState((prev) => ({ ...prev, [id]: { busy: false, text: null, failure: "could not load" } }));
        });
    },
    [onLoadBody],
  );

  return (
    <div className={css.bodyRefs}>
      {refs.map((ref) => {
        const id = `${ref.field}|${ref.ref}`;
        const local = state[id];
        const preview = ref.preview;
        return (
          <div key={id} className={css.bodyRef}>
            <div className={css.bodyRefHead}>
              <span className={css.bodyRefField}>{ref.field}</span>
              <span className={css.bodyRefMeta}>
                {ref.representation} · {formatBytes(ref.total_bytes)}
                {ref.preview_truncated ? " · preview" : ""}
              </span>
              {onLoadBody !== undefined && local?.text == null ? (
                <button
                  type="button"
                  className={css.bodyRefAction}
                  disabled={local?.busy === true}
                  onClick={() => expand(ref)}
                  title="Load the full value from the host in 64 KiB chunks."
                >
                  {local?.busy === true ? "loading…" : ref.preview_truncated ? "load full" : "load"}
                </button>
              ) : null}
            </div>
            {local?.text == null && preview !== null ? (
              <pre className={css.bodyRefPreview}>{preview}</pre>
            ) : null}
            {local?.text != null ? <pre className={css.bodyRefPreview}>{local.text}</pre> : null}
            {local?.failure !== null && local?.failure !== undefined ? (
              <p role="status" className={css.bodyRefFailure}>
                {local.failure}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

const MeasuredRow = memo(function MeasuredRow({ row, theme, width, onLoadBody, onHeight }: {
  row: ViewerRow; theme: string; width: number;
  onLoadBody?: SessionViewerProps["onLoadBody"];
  onHeight: (key: string, height: number) => void;
}) {
  const observerRef = useRef<ResizeObserver | null>(null);
  const attach = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (node === null) { historyProbeCount("rowDetach"); return; }
    historyProbeCount("rowAttach");
    if (typeof ResizeObserver !== "function") {
      onHeight(row.key, node.getBoundingClientRect().height);
      return;
    }
    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (entry) onHeight(row.key, entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
    });
    // The virtual geometry includes padding/borders, so changes to those must
    // deliver notifications too (the default content-box ignores them).
    observer.observe(node, { box: "border-box" });
    observerRef.current = observer;
  }, [row.key, onHeight]);
  return <div className={css.measuredRow} ref={attach} data-row-key={row.key}>
    <EventRow row={row} theme={theme} width={width} onLoadBody={onLoadBody} />
  </div>;
});

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function SessionViewer({
  session,
  rows,
  loading,
  notice,
  onClose,
  onSwitch,
  switchBusy = false,
  canSwitch = true,
  isLive,
  stale = false,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
  hasNewer = false,
  loadingNewer = false,
  onLoadNewer,
  onShowHead,
  pageStart = 0,
  pageEnd = 0,
  onLoadBody,
  theme = "dark",
}: SessionViewerProps) {
  /*
   * Elapsed seconds while resuming.
   *
   * A spinner proves nothing about liveness; a running counter does. Resuming
   * costs a daemon exit, a supervisor respawn and a fresh handshake, which is
   * seconds of real work -- without a number it reads as a dead button.
   */
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!switchBusy) return undefined;
    const tick = setInterval(() => {
      setElapsed((n) => n + 1);
    }, 1000);
    return () => clearInterval(tick);
  }, [switchBusy]);

  const handleResume = (): void => {
    setElapsed(0);
    onSwitch();
  };

  // ── window state ────────────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [contentWidth, setContentWidth] = useState(0);
  /**
   * Measured row heights, keyed by the STABLE `event_id`.
   *
   * Keyed rather than indexed on purpose: a page prepended at the top shifts every
   * index, so an index-keyed map would attribute one row's height to another.
   */
  const [measurement, setMeasurement] = useState<{ rows: SessionViewerProps["rows"]; values: ReadonlyMap<string, number> }>(
    () => ({ rows, values: new Map() }),
  );
  // Adjust derived ownership during render, before React commits the new rows.
  // This releases old heights without a cascading layout effect or a frame of
  // old-session measurements. The keyed parent resets on a session switch.
  if (measurement.rows !== rows) {
    setMeasurement({ rows, values: pruneRowHeights(measurement.values, new Set(rows?.map(row => row.key) ?? [])) });
  }
  const measuredHeights = measurement.values;
  const containerObserver = useRef<ResizeObserver | null>(null);
  const frameRef = useRef<number | null>(null);
  const heightFrameRef = useRef<number | null>(null);
  const pendingHeights = useRef(new Map<string, number>());
  const geometry = useRef<{ keys: readonly string[]; heights: readonly number[]; heightEntries: number }>({ keys: [], heights: [], heightEntries: 0 });
  const anchorRef = useRef<{ anchor: RowAnchor | null; rows: readonly ViewerRow[] } | null>(null);
  const heightAnchorRef = useRef<RowAnchor | null>(null);

  const measured = useMemo(() => rows ?? [], [rows]);
  const heights = useMemo(
    () =>
      measured.map(
        (row) => measuredHeights.get(row.key) ?? estimateRowHeight(row.event),
      ),
    [measured, measuredHeights],
  );

  const keys = useMemo(() => measured.map(row => row.key), [measured]);
  useLayoutEffect(() => {
    geometry.current = { keys, heights, heightEntries: measuredHeights.size };
  }, [keys, heights, measuredHeights]);

  useEffect(() => registerHistoryProbeSource("viewer", () => ({
    residentRows: geometry.current.keys.length,
    heightEntries: geometry.current.heightEntries,
    mountedRows: scrollRef.current?.querySelectorAll("[data-row-key]").length ?? 0,
  })), []);

  // Before measuring any actual row, eagerly render only the estimated
  // viewport. On cold opens a large estimated window can otherwise parse
  // offscreen Markdown in the same task that should reveal the first row.
  // Once measured, restore the usual pixel overscan for scrolling.
  const hasMeasuredRows = measuredHeights.size > 0;
  const window: VirtualWindow = useMemo(
    () =>
      computeWindow({
        heights,
        scrollTop,
        viewportHeight: Math.max(1, viewportHeight),
        overscanPx: hasMeasuredRows ? undefined : 0,
        maxRendered: DEFAULT_MAX_RENDERED,
      }),
    [heights, scrollTop, viewportHeight, hasMeasuredRows],
  );

  /**
   * Attach the scroll box, measuring it immediately.
   *
   * A CALLBACK REF, not an effect: the measurement must happen when the node is
   * attached, and doing it here avoids a state write inside an effect (which
   * cascades) while still landing the real client size on the first paint.
   */
  const attachScroll = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    containerObserver.current?.disconnect();
    containerObserver.current = null;
    if (node === null) return;
    setViewportHeight(node.clientHeight);
    setContentWidth(node.clientWidth);
    setScrollTop(node.scrollTop);
    const Observer = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (typeof Observer !== "function") return;
    const observer = new Observer(() => {
      setViewportHeight(node.clientHeight);
      setContentWidth(node.clientWidth);
    });
    observer.observe(node);
    containerObserver.current = observer;
  }, []);

  /** Observer deliveries are batched once per frame. No per-render ref detach
   * or synchronous layout read; late height changes preserve the visible row. */
  const onRowHeight = useCallback((key: string, height: number) => {
    if (!(height > 0)) return;
    pendingHeights.current.set(key, height);
    if (heightFrameRef.current !== null) return;
    heightFrameRef.current = requestAnimationFrame(() => {
      heightFrameRef.current = null;
      const { keys: resident, heights: previousHeights } = geometry.current;
      const el = scrollRef.current;
      heightAnchorRef.current = el === null ? null : captureRowAnchor(resident, previousHeights, el.scrollTop);
      const batch = pendingHeights.current;
      pendingHeights.current = new Map();
      const keep = new Set(resident);
      setMeasurement(current => {
        let next = pruneRowHeights(current.values, keep);
        for (const [id, value] of batch) {
          if (!keep.has(id) || Math.abs((next.get(id) ?? 0) - value) <= 0.5) continue;
          if (next === current.values) next = new Map(next);
          (next as Map<string, number>).set(id, value);
        }
        return next === current.values ? current : { ...current, values: next };
      });
      historyProbeCount("heightBatch");
    });
  }, []);

  useEffect(() => () => {
    containerObserver.current?.disconnect();
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    if (heightFrameRef.current !== null) cancelAnimationFrame(heightFrameRef.current);
    pendingHeights.current.clear();
  }, []);

  const handleScroll = useCallback(() => {
    if (frameRef.current !== null) return;
    const raf = (globalThis as { requestAnimationFrame?: (fn: FrameRequestCallback) => number }).requestAnimationFrame;
    if (typeof raf !== "function") {
      const el = scrollRef.current;
      if (el !== null) setScrollTop(el.scrollTop);
      return;
    }
    frameRef.current = raf(() => {
      frameRef.current = null;
      const el = scrollRef.current;
      if (el !== null) setScrollTop(el.scrollTop);
    });
  }, []);

  /* A status/height update while a request is in flight must not consume its
   * prepend anchor. Subsequent observer batches capture a fresh height anchor. */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const pending = anchorRef.current;
    const applied = pending !== null && measured !== pending.rows && !loadingOlder;
    const anchor = applied ? pending.anchor : heightAnchorRef.current;
    if (applied) anchorRef.current = null;
    heightAnchorRef.current = null;
    if (anchor === null) return;
    const top = restoreRowAnchor(anchor, keys, heights);
    if (top === null && !applied) return;
    el.scrollTop = top ?? 0;
    setScrollTop(el.scrollTop);
  }, [measured, keys, heights, loadingOlder]);

  const loadOlder = useCallback(() => {
    if (onLoadOlder === undefined) return;
    const el = scrollRef.current;
    anchorRef.current = { rows: measured, anchor: el === null ? null : captureRowAnchor(keys, heights, el.scrollTop) };
    onLoadOlder();
  }, [heights, keys, measured, onLoadOlder]);

  const loadNewer = useCallback(() => {
    anchorRef.current = { rows: measured, anchor: null };
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setScrollTop(0);
    onLoadNewer?.();
  }, [measured, onLoadNewer]);

  const visible = measured.slice(window.start, window.end);

  return (
    /* `h-full` is load-bearing: as a plain block child this grid grew to its
     * content height and spilled out of the cell that sizes it, so the inner
     * `minmax(0, 1fr)` row never became the transcript's scroll box and a long
     * history session pushed the whole page taller instead. */
    <div className={css.root} data-history-viewer="" data-page-start={pageStart} data-page-end={pageEnd} aria-busy={loading || loadingOlder || loadingNewer}>
      {/* The banner is what makes the read-only nature unmistakable, and it
          carries the ONLY state-changing control. */}
      <div className={css.head}>
        <span className={css.chip}>
          read-only
        </span>
        <span className={css.title}>
          {sessionLabel(session)}
        </span>
        {stale ? (
          <span className={css.staleChip} title="Showing cached content; the host has not confirmed it yet.">
            cached
          </span>
        ) : null}
        <span className={css.chip} data-history-position="" role="status"
          title="Pages are counted from newest. Use newer/older to revisit pages; returning to newest refreshes the session.">
          {`pages ${pageStart + 1}–${pageEnd + 1} from newest`}
        </span>
        {hasNewer && onLoadNewer !== undefined ? <>
          <button type="button" className={css.olderButton} data-history-action="newer"
            onClick={loadNewer} disabled={loadingOlder || loadingNewer}>
            {loadingNewer ? "Reading newer…" : "Read newer"}
          </button>
          {onShowHead === undefined ? null : <button type="button" className={css.olderButton}
            data-history-action="head" disabled={loadingOlder || loadingNewer} onClick={() => {
              anchorRef.current = null;
              if (scrollRef.current) scrollRef.current.scrollTop = 0;
              setScrollTop(0);
              onShowHead();
            }}>Newest</button>}
        </> : null}
        {hasOlder && onLoadOlder !== undefined ? (
          <button
            type="button"
            data-history-action="older"
            onClick={loadOlder}
            disabled={loadingOlder || loadingNewer}
            title="Load the next older page (keeps your place)."
            className={css.olderButton}
          >
            {loadingOlder ? "Loading older…" : "Load older"}
          </button>
        ) : null}
        {isLive ? (
          <span className={css.liveBadge}>
            live
          </span>
        ) : (
          /*
           * The label says what the reader gets, not what the protocol does.
           * "switch to this session" described a state change; what a person
           * actually wants to know is whether they can keep talking here.
           */
          <button
            type="button"
            onClick={handleResume}
            disabled={switchBusy || !canSwitch}
            title={
              !canSwitch
                ? "The host has no command context to switch sessions with."
                : switchBusy
                  ? "Switching — the host is restarting its Pi onto this session…"
                  : "将此设为当前会话，然后在其中继续对话（影响所有已配对客户端）"
            }
            className={`${css.switchButton}${switchBusy ? ` ${css.switchButtonBusy}` : ""}`}
          >
            {switchBusy
              ? elapsed > 0
                ? `Resuming… ${elapsed}s`
                : "Resuming…"
              : "Resume here"}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭只读会话视图"
          className={css.refresh}
        >
          <Icon name="x" size={12} />
        </button>
      </div>

      <div className={css.scroll} data-history-scroll="" ref={attachScroll} onScroll={handleScroll}>
        <div className={css.transcript}>
          {notice !== null ? (
            <p role="status" className={css.statusLine}>
              {notice}
            </p>
          ) : loading || rows === null ? (
            <p className={css.emptyLine}>Reading this session…</p>
          ) : rows.length === 0 ? (
            <p className={css.emptyLine}>
              This session has no messages yet.
            </p>
          ) : (
            <>
              {window.topSpacer > 0 ? (
                <div style={{ height: window.topSpacer }} aria-hidden="true" />
              ) : null}
              {visible.map((row) => (
                <MeasuredRow key={row.key} row={row} theme={theme} width={contentWidth}
                  onLoadBody={onLoadBody} onHeight={onRowHeight} />
              ))}
              {window.bottomSpacer > 0 ? (
                <div style={{ height: window.bottomSpacer }} aria-hidden="true" />
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
