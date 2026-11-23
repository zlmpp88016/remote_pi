/** Root may run this alongside history-hook.browser.ts in the isolated artifact.
 * Uses real React + DOM + ResizeObserver. Never launches a browser/host. */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Markdown } from "../src/components/remote-pi/chat/markdown";
import { SessionViewer, toViewerRows, type ViewerRow } from "../src/components/remote-pi/sessions/session-viewer";
import type { HistoryItem } from "../src/lib/remote-pi/history";

declare global {
  interface Window { runHistoryViewerRegression: () => Promise<{
    checks: number;
    anchors: { phase: string; before: number; after: number; delta: number }[];
  }> }
}

window.runHistoryViewerRegression = async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let checks = 0;
  const anchors: { phase: string; before: number; after: number; delta: number }[] = [];
  const check = (ok: boolean, label: string) => { checks++; if (!ok) throw Error(label); };
  const probe = () => (globalThis as { __p87History?: { snapshot(): {
    counters: Record<string, number>; stats: Record<string, Record<string, number>>;
  } } }).__p87History?.snapshot();
  const makeRows = (page: number): readonly ViewerRow[] => toViewerRows(Array.from({ length: 50 }, (_, i): HistoryItem => ({
    event_id: `p87-page${page}-row${i}`, entry_id: `p87-page${page}-row${i}`,
    event: i % 2 ? { ts: i, type: "agent_message", in_reply_to: `u${i}`,
      text: `P87_ROW_${page}_${i}\n\n**Different height** ${"line\n\n".repeat(i % 5 + 1)}` }
      : { ts: i, type: "user_input", id: `u${i}`, text: `P87_ROW_${page}_${i}\n${"fixture\n".repeat(i % 3 + 1)}` },
  })));
  const container = document.getElementById("root")!;
  container.style.cssText = "height:720px;width:940px;--spacing:4px;--ff-display:system-ui;--ff-mono:monospace;--leading-relaxed:1.6";
  const root = createRoot(container);
  let rows = makeRows(0), loadingOlder = false, id = "fixture-session", pending = false;
  const load = () => { loadingOlder = true; pending = true; renderSync(); };
  const renderSync = () => root.render(createElement(SessionViewer, {
    key: id, session: { id, mtime: 1, live: false }, rows, loading: false, notice: null,
    isLive: false, onClose() {}, onSwitch() {}, onLoadOlder: load, hasOlder: true,
    loadingOlder, hasNewer: false,
  }));
  const frames = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); };
  // Commit before waiting for browser layout/ResizeObserver. One long async
  // act batches the measurement updates until AFTER all its frames, leaving
  // assertions ahead of the resulting React commits and observer deliveries.
  const settle = async () => {
    for (let i = 0; i < 10; i++) await act(async () => { await frames(1); });
  };
  const render = async () => { await act(async () => { renderSync(); }); await settle(); };
  const scroll = () => container.querySelector<HTMLDivElement>("[data-history-scroll]")!;
  const mounted = () => [...container.querySelectorAll<HTMLDivElement>("[data-row-key]")];
  const firstVisible = () => {
    const box = scroll().getBoundingClientRect();
    return mounted().find(row => row.getBoundingClientRect().bottom > box.top + 1)!;
  };
  const y = (key: string) => container.querySelector(`[data-row-key="${key}"]`)!.getBoundingClientRect().top - scroll().getBoundingClientRect().top;
  const checkAnchor = (key: string, before: number, phase: string, label: string) => {
    const after = y(key);
    anchors.push({ phase, before, after, delta: after - before });
    check(Math.abs(after - before) < 2, label);
  };
  try {
    await render();
    check(mounted().length > 0 && mounted().length <= 60, "real viewer mounts a bounded nonempty window");
    const initial = probe()?.counters ?? {};
    await render();
    const unchanged = probe()?.counters ?? {};
    check(unchanged.rowAttach === initial.rowAttach, "unrelated React render never reattaches stable row refs");
    check(unchanged.markdownParse === initial.markdownParse, "unchanged mounted rows do not reparse on an unrelated render");
    await act(async () => { scroll().scrollTop = 157; scroll().dispatchEvent(new Event("scroll")); });
    await settle();
    const anchor = firstVisible().dataset.rowKey!;
    const before = y(anchor);
    check(before < -2, "prepend fixture starts inside a visible row, not at a zero offset");
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-history-action="older"]')!.click(); });
    await settle();
    check(pending && loadingOlder, "real older button enters loading state before content");
    check(Math.abs(y(anchor) - before) < 1.5, "loading status does not consume or move the anchor");
    rows = [...makeRows(1), ...rows]; loadingOlder = false;
    await render();
    checkAnchor(anchor, before, "prepend", "nonzero interior offset survives variable-height prepend and measurement");
    // Change a mounted row ABOVE the anchor after the prepend has settled.
    const above = mounted().filter(row => row.dataset.rowKey !== anchor && row.getBoundingClientRect().top < firstVisible().getBoundingClientRect().top).at(-1);
    check(above !== undefined, "late-height fixture has a mounted row above the anchor");
    if (above) {
      const position = y(anchor);
      await act(async () => { above.style.paddingTop = "31px"; });
      await settle();
      checkAnchor(anchor, position, "late-height", "late ResizeObserver height above viewport preserves the anchor");
    }
    // Exercise fresh anchors after scrolling, rather than only reusing the
    // original request's saved position. Retain the same two-pixel tolerance.
    for (const [page, offset] of [[2, 383], [3, 827]]) {
      await act(async () => { scroll().scrollTop = offset; scroll().dispatchEvent(new Event("scroll")); });
      await settle();
      const key = firstVisible().dataset.rowKey!;
      const position = y(key);
      check(position < -2, "repeated prepend starts at a nonzero interior offset");
      await act(async () => { container.querySelector<HTMLButtonElement>('[data-history-action="older"]')!.click(); });
      await settle();
      rows = [...makeRows(page), ...rows]; loadingOlder = false;
      await render();
      checkAnchor(key, position, `prepend-${page}`, "fresh nonzero anchor survives repeated variable-height prepend");
    }
    for (let page = 2; page < 12; page++) { rows = makeRows(page); await render(); }
    const stats = probe()?.stats.viewer;
    check(stats !== undefined && stats.heightEntries <= 50 && mounted().length <= 60, "page replacement prunes old measured heights and mounted rows");
    id = "second-session"; rows = makeRows(12); await render();
    check(scroll().scrollTop === 0, "switching keyed session resets old scroll/height ownership");

    // A real mounted renderer receiving width/theme cache-key changes (as the
    // viewer sees after ResizeObserver). Contrast with a same-length edit.
    const first = "| Key | Value |\n| --- | --- |\n| test | FIRST |\n\n[unsafe relative](/relative)\n\n<small>literal raw HTML</small>";
    const second = first.replace("FIRST", "FINAL");
    const renderMarkdown = async (text: string, theme: string, width: number) => {
      await act(async () => { root.render(createElement(Markdown, {text, cacheIdentity: {theme, width}})); });
    };
    await renderMarkdown(first, "dark", 640);
    const withText = probe()!.counters;
    check(container.querySelector("table")?.textContent?.includes("FIRST") === true, "real history Markdown keeps GFM tables");
    check(container.querySelector("a") === null && container.querySelector("small") === null && container.textContent!.includes("<small>literal raw HTML</small>"),
      "real viewer Markdown still treats relative links and raw HTML as inert");
    await renderMarkdown(first, "light", 848);
    const resized = probe()!.counters;
    check(resized.markdownMount > withText.markdownMount && resized.markdownParse === withText.markdownParse,
      "theme/width cache-key change does not reparse unchanged mounted Markdown");
    await renderMarkdown(second, "light", 848);
    check(probe()!.counters.markdownParse === resized.markdownParse + 1 && container.querySelector("table")?.textContent?.includes("FINAL") === true,
      "a same-length text edit actually reparses and renders its new content");

    // Hold real observer deliveries: long link targets make source-based
    // estimates much taller than the short label actually rendered.
    const NativeObserver = globalThis.ResizeObserver;
    const held = new Map<ResizeObserver, () => void>();
    let holding = true;
    class DelayedObserver implements ResizeObserver {
      private readonly observer: ResizeObserver;
      constructor(callback: ResizeObserverCallback) {
        this.observer = new NativeObserver((entries, observer) => {
          if (holding) held.set(observer, () => callback(entries, observer));
          else callback(entries, observer);
        });
      }
      observe(target: Element, options?: ResizeObserverOptions) { this.observer.observe(target, options); }
      unobserve(target: Element) { this.observer.unobserve(target); }
      disconnect() { held.delete(this.observer); this.observer.disconnect(); }
    }
    globalThis.ResizeObserver = DelayedObserver;
    try {
      id = "initial-high-estimate";
      rows = toViewerRows(Array.from({length: 50}, (_, i): HistoryItem => ({
        event_id: `initial-${i}`, entry_id: `initial-${i}`,
        event: {type: "agent_message", in_reply_to: `initial-user-${i}`, ts: i,
          text: `[brief](https://example.invalid/${"x".repeat(3200)})`},
      })));
      loadingOlder = false;
      await act(async () => { renderSync(); });
      await frames(2);
      const initialBox = scroll().getBoundingClientRect();
      const initialRows = mounted();
      const initialKey = initialRows[0]?.dataset.rowKey;
      check(initialKey === "initial-0" && initialRows[0].textContent!.includes("brief") && initialRows[0].getBoundingClientRect().top < initialBox.bottom,
        "a real cold-open row mounts before the first observer height delivery");
      check(initialRows.length > 0 && initialRows.length < 10 && held.size > 0,
        "pre-measurement cold-open mounts its estimated viewport without eager offscreen overscan");
      const position = y(initialKey!);
      await act(async () => { holding = false; const callbacks = [...held.values()]; held.clear(); callbacks.forEach(callback => callback()); });
      await settle();
      const after = mounted(), box = scroll().getBoundingClientRect();
      check(after.length > initialRows.length && after.at(-1)!.getBoundingClientRect().bottom >= box.bottom,
        "overestimated Markdown rows fill the viewport after actual first-height delivery");
      check(Math.abs(y(initialKey!) - position) < 2 && scroll().scrollTop === 0 && after.length <= 60,
        "first-height release preserves the visible cold-open anchor and row ceiling");
    } finally {
      holding = false;
      await act(async () => { root.render(null); });
      globalThis.ResizeObserver = NativeObserver;
    }
  } finally { await act(async () => { root.unmount(); await frames(); }); }
  return { checks, anchors };
};

