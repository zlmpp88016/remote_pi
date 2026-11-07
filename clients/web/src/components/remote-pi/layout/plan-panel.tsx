"use client";

/* Plan viewer (plan/77) — drill-down: a LIST view or a DOCUMENT view, never both.
 *
 * ## Why drill-down instead of list-above-document
 *
 * The previous version stacked the document ABOVE the always-rendered document
 * list inside `.panel` (which is `overflow: auto`). With 90 real plan files and
 * the panel scrolled down to reach a lower one, the panel kept its scrollTop and
 * the newly mounted document landed at `top: -2438px` — completely above the
 * viewport. The user clicked a document and saw a blank panel.
 *
 * Resetting scrollTop would not have fixed it: with a 7000px document and a
 * 3590px list in the same scroller, the panel becomes 10000px tall and scrolling
 * to the end of the document drops the reader straight into the file list.
 *
 * So the two states get the whole panel each. That is also the only shape that
 * works in a 280-600px dock: a master-detail split would leave each side ~140px,
 * which is about 18 characters of body text per line.
 *
 * ## Single-scroller rule
 *
 * Exactly ONE element scrolls at any moment: `.planListScroll` in list view,
 * `.planDocScroll` in document view. Neither is nested inside the other, and the
 * body is no longer capped at `58vh` (that cap is what produced a second,
 * inner scrollbar and wasted 40% of the dock's height).
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Icon } from "../core/icons";
import { Markdown } from "../chat/markdown";
import css from "./plan-panel.module.css";

export interface PlanDocView {
  path: string;
  content: string;
  truncated: boolean;
  bytes: number;
}

export interface PlanPanelProps {
  /** Absolute paths of the documents the host listed under the workspace plan/. */
  planFiles: readonly string[];
  planDoc: PlanDocView | null;
  planLoading: boolean;
  /** Fixed, client-authored sentence; null when there is nothing wrong. */
  planError: string | null;
  planTruncatedNotice: string;
  onReadPlan: (path: string) => void;
  /** Returns to the list by clearing the open document in the container. */
  onClosePlan: () => void;
  /** Shown in list view before the host has returned anything. */
  introReason: string;
}

/** `76-remove-relay.zh-CN.md` -> index `76`, title `remove-relay.zh-CN`. */
interface PlanRow {
  path: string;
  index: number | null;
  title: string;
  full: string;
}

/* The absolute path is stripped to its basename on PURPOSE. All 90 rows share
 * the same 37-character directory prefix, so printing it wastes the whole row in
 * a narrow dock and ellipsizes away the only part that differs. The full path
 * stays available as the row's `title` (hover) for anyone who needs it. */
function toRow(path: string): PlanRow {
  const full = path.replace(/^.*[\\/]/, "");
  const match = /^(\d+)[-_.]?(.*)$/.exec(full);
  if (match === null) {
    return { path, index: null, title: full.replace(/\.md$/i, ""), full };
  }
  const rest = (match[2] ?? "").replace(/\.md$/i, "");
  return {
    path,
    index: Number(match[1]),
    title: rest === "" ? full : rest,
    full,
  };
}

export function PlanPanel({
  planFiles,
  planDoc,
  planLoading,
  planError,
  planTruncatedNotice,
  onReadPlan,
  onClosePlan,
  introReason,
}: PlanPanelProps) {
  const [query, setQuery] = useState("");
  const docScrollRef = useRef<HTMLDivElement | null>(null);
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);
  /** Scroll position to restore when coming back from a document. */
  const listTopRef = useRef(0);

  const rows = useMemo(() => planFiles.map(toRow), [planFiles]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return rows;
    return rows.filter(
      (row) => row.full.toLowerCase().includes(q) || String(row.index ?? "").includes(q),
    );
  }, [rows, query]);

  /*
   * Put the reader at the TOP of the document, and move focus to the back
   * control, BEFORE paint.
   *
   * `useLayoutEffect` (not `useEffect`) because a post-paint reset would show the
   * document mid-scroll for one frame; assignment also has to survive the browser
   * restoring a scroll position on its own. Focus moving to the back button is
   * what makes the view swap announce itself to a keyboard or screen-reader user.
   */
  useLayoutEffect(() => {
    if (planDoc === null) return;
    const el = docScrollRef.current;
    if (el !== null) el.scrollTop = 0;
    backRef.current?.focus({ preventScroll: true });
  }, [planDoc?.path, planDoc === null]);

  const openRow = useCallback(
    (path: string) => {
      const el = listScrollRef.current;
      listTopRef.current = el === null ? 0 : el.scrollTop;
      onReadPlan(path);
    },
    [onReadPlan],
  );

  const backToList = useCallback(() => {
    onClosePlan();
    /* Restore after the list remounts, so a reader returns to the row they left
     * instead of the top of a 90-row list. */
    requestAnimationFrame(() => {
      const el = listScrollRef.current;
      if (el !== null) el.scrollTop = listTopRef.current;
    });
  }, [onClosePlan]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Escape") return;
      if (planDoc !== null) {
        event.stopPropagation();
        backToList();
      }
    },
    [planDoc, backToList],
  );

  /* ---------------- document view ---------------- */
  if (planDoc !== null) {
    const active = toRow(planDoc.path);
    return (
      <div className={css.planRoot} onKeyDown={onKeyDown}>
        <div className={css.planDocHead}>
          <button
            ref={backRef}
            type="button"
            className={css.planBack}
            onClick={backToList}
            title="返回计划列表（Esc）"
          >
            <Icon name="chevR" size={12} className={css.planBackIcon} />
            <span>计划</span>
          </button>
          <div className={css.planDocTitle} title={planDoc.path}>
            {active.index === null ? null : (
              <span className={css.planIndex}>{active.index}</span>
            )}
            <span className={css.planDocName}>{active.title}</span>
          </div>
        </div>

        {planError !== null ? (
          <p className={css.planError} role="alert">
            {planError}
          </p>
        ) : null}
        {planLoading ? (
          <div className={css.planStatus}>
            <Spinner />
            <span>正在读取文档…</span>
          </div>
        ) : null}
        {planDoc.truncated ? (
          <p className={css.planNotice} role="alert">
            {planTruncatedNotice} ({Math.round(planDoc.bytes / 1024)} KB)
          </p>
        ) : null}

        <div ref={docScrollRef} className={css.planDocScroll} tabIndex={0}>
          <div className={css.planDocBody}>
            <Markdown text={planDoc.content} />
          </div>
        </div>
      </div>
    );
  }

  /* ---------------- list view ---------------- */
  return (
    <div className={css.planRoot} onKeyDown={onKeyDown}>
      {planFiles.length === 0 ? (
        <p className={css.planIntro}>{introReason}</p>
      ) : (
        <div className={css.planToolbar}>
          <div className={css.planSearchWrap}>
            <Icon name="search" size={12} className={css.planSearchIcon} />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query !== "") {
                  event.stopPropagation();
                  setQuery("");
                }
                /* With the filter narrowed to a single hit, Enter opens it: the
                 * common case is typing "76", so requiring a click after that
                 * would be a pointless extra step. */
                if (event.key === "Enter" && filtered.length === 1) {
                  event.preventDefault();
                  openRow(filtered[0]!.path);
                }
              }}
              placeholder={`Filter ${planFiles.length} plans…`}
              aria-label="筛选计划文档"
              className={css.planSearch}
              spellCheck={false}
              autoComplete="off"
            />
            {query === "" ? null : (
              <button
                type="button"
                className={css.planSearchClear}
                onClick={() => setQuery("")}
                aria-label="清除筛选"
              >
                <Icon name="x" size={10} />
              </button>
            )}
          </div>
          <span className={css.planCount}>
            {query === ""
              ? `${planFiles.length} plans`
              : `${filtered.length} of ${planFiles.length}`}
          </span>
        </div>
      )}

      {planError !== null ? (
        <p className={css.planError} role="alert">
          {planError}
        </p>
      ) : null}
      {planLoading ? (
        <div className={css.planStatus}>
          <Spinner />
          <span>正在读取文档…</span>
        </div>
      ) : null}

      {planFiles.length === 0 ? null : filtered.length === 0 ? (
        <div className={css.planEmpty}>
          <p className={css.planIntro}>
            No plan document matches “{query}”.
          </p>
          <button type="button" className={css.planEmptyClear} onClick={() => setQuery("")}>
            清除筛选
          </button>
        </div>
      ) : (
        <div ref={listScrollRef} className={css.planListScroll}>
          <ul className={css.planList}>
            {filtered.map((row) => (
              <li key={row.path}>
                <button
                  type="button"
                  data-plan-row="true"
                  className={css.planRow}
                  onClick={() => openRow(row.path)}
                  title={row.path}
                >
                  {row.index === null ? (
                    <Icon name="book" size={12} className={css.planRowIcon} />
                  ) : (
                    <span className={css.planIndex}>{row.index}</span>
                  )}
                  <span className={css.planRowTitle}>{row.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return <span className={css.planSpinner} aria-hidden="true" />;
}
