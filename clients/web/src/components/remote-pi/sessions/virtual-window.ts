/**
 * Plan 86 P3 — the window of history rows that gets MOUNTED.
 *
 * WHY A BOUNDED WINDOW INSTEAD OF "RENDER THE WHOLE SESSION"
 *
 * A long history is loaded in pages, so the obvious implementation — map every
 * item to a row — means the DOM grows with every page the user scrolls through.
 * After a hundred pages the page holds thousands of Markdown trees, and the
 * memory and style/layout cost is paid on every keystroke and every scroll
 * frame. The plan's requirement is explicit: scroll through a hundred pages and
 * the DOM and the page cache must stay bounded.
 *
 * So the transcript keeps its SCROLL BOX and its total height, but only a window
 * of rows is mounted: the visible range plus a near-viewport overscan. The rest
 * is two spacers whose heights preserve the scroll position and the scrollbar
 * size. Copy, links, selection and the scroll anchor are properties of the
 * MOUNTED rows, which is why the window never collapses to a spinner or to a
 * single placeholder block.
 *
 * PURE ON PURPOSE
 *
 * No DOM, no React, no timers: heights come in as an array (measured heights for
 * rows that have been mounted; an estimate for the rest) and the window comes
 * out as plain numbers. That makes the "100 pages stay bounded" claim testable
 * without a browser, which is the only way to assert it as a fact rather than a
 * hope.
 */

/** Rows to keep mounted beyond each edge of the viewport, in pixels. */
export const DEFAULT_OVERSCAN_PX = 600;

/**
 * Hard ceiling on mounted rows.
 *
 * The overscan alone is not a bound: a very tall viewport plus a very small row
 * height can make "viewport + 2 × overscan" cover hundreds of rows. This cap is
 * the number the DOM guarantee is stated against, and it wins over the overscan.
 */
export const DEFAULT_MAX_RENDERED = 60;

/** Height assumed for a row that has not been measured yet. */
export const DEFAULT_ROW_ESTIMATE_PX = 96;

export interface VirtualWindowInput {
  /** Per-row heights: measured where known, estimate otherwise. */
  heights: readonly number[];
  /** Current `scrollTop` of the transcript box. */
  scrollTop: number;
  /** Client height of that box. */
  viewportHeight: number;
  overscanPx?: number;
  maxRendered?: number;
}

export interface VirtualWindow {
  /** First mounted row index (inclusive). */
  start: number;
  /** One past the last mounted row index (exclusive). */
  end: number;
  /** Height reserved above `start`. */
  topSpacer: number;
  /** Height reserved below `end`. */
  bottomSpacer: number;
  /** `end - start`, never above `maxRendered`. */
  rendered: number;
  totalHeight: number;
}

/** Prefix offsets: `offsets[i]` is the top of row `i`; last entry is the total. */
export function rowOffsets(heights: readonly number[]): number[] {
  const offsets = new Array<number>(heights.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < heights.length; i += 1) {
    const height = heights[i];
    offsets[i + 1] = (offsets[i] as number) + (Number.isFinite(height) && height > 0 ? height : 0);
  }
  return offsets;
}

/** Index of the first row whose BOTTOM is below `offset`. */
function firstRowVisible(offsets: readonly number[], offset: number): number {
  const count = offsets.length - 1;
  let low = 0;
  let high = count;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((offsets[mid + 1] as number) <= offset) low = mid + 1;
    else high = mid;
  }
  return Math.min(low, count);
}

/**
 * Compute the mounted window.
 *
 * The VISIBLE range is found by binary search over the prefix offsets; the
 * overscan is applied in pixels; the result is clamped to `[0, count]` and, if
 * necessary, to `maxRendered` rows centred on the visible range. Spacers are
 * exact prefix sums, so the scroll box's total height never depends on which
 * rows happen to be mounted.
 */
export function computeWindow(input: VirtualWindowInput): VirtualWindow {
  const { heights, scrollTop, viewportHeight } = input;
  const overscan = input.overscanPx ?? DEFAULT_OVERSCAN_PX;
  const maxRendered = Math.max(1, input.maxRendered ?? DEFAULT_MAX_RENDERED);
  const count = heights.length;
  const offsets = rowOffsets(heights);
  const totalHeight = offsets[count] as number;
  if (count === 0) {
    return { start: 0, end: 0, topSpacer: 0, bottomSpacer: 0, rendered: 0, totalHeight: 0 };
  }
  const top = Math.max(0, Math.min(scrollTop, Math.max(0, totalHeight - viewportHeight)));
  const bottom = Math.min(totalHeight, top + Math.max(0, viewportHeight));

  const visibleStart = firstRowVisible(offsets, top);
  let visibleEnd = visibleStart;
  while (visibleEnd < count && (offsets[visibleEnd] as number) < bottom) visibleEnd += 1;

  const overscanStart = firstRowVisible(offsets, Math.max(0, top - overscan));
  let overscanEnd = Math.min(count, Math.max(visibleEnd, offsetIndexLimit(offsets, bottom + overscan, visibleEnd)));

  let start = Math.min(overscanStart, visibleStart);
  let end = Math.max(overscanEnd, visibleEnd);

  if (end - start > maxRendered) {
    // Centre on the VISIBLE range, then clamp: the near-viewport slices are the
    // ones the user is about to see, so they must be the ones kept.
    const visibleCount = Math.max(1, visibleEnd - visibleStart);
    const budget = Math.max(1, maxRendered - visibleCount);
    const before = Math.min(visibleStart - start, Math.floor(budget / 2));
    start = visibleStart - before;
    end = Math.min(count, start + maxRendered);
    start = Math.max(0, end - maxRendered);
    // If the visible range alone exceeds the cap (pathological viewport), the
    // cap still wins and the window starts at the visible top.
    if (visibleEnd - visibleStart > maxRendered) {
      start = visibleStart;
      end = Math.min(count, visibleStart + maxRendered);
    }
  }

  const topSpacer = offsets[start] as number;
  const bottomSpacer = totalHeight - (offsets[end] as number);
  return {
    start,
    end,
    topSpacer: Math.max(0, topSpacer),
    bottomSpacer: Math.max(0, bottomSpacer),
    rendered: end - start,
    totalHeight,
  };
}

/** First index whose TOP is at or after `offset`, but never below `floor`. */
function offsetIndexLimit(offsets: readonly number[], offset: number, floor: number): number {
  const count = offsets.length - 1;
  let low = floor;
  let high = count;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((offsets[mid] as number) < offset) low = mid + 1;
    else high = mid;
  }
  return Math.min(low, count);
}

/**
 * Index of the row containing `offset` (clamped), or -1 for an empty list.
 *
 * Used for the scroll ANCHOR: a page prepended at the top must not move what the
 * user is reading, so the viewer remembers the anchored row's id and restores
 * its on-screen offset after the items change.
 */
export function rowAtOffset(heights: readonly number[], offset: number): number {
  if (heights.length === 0) return -1;
  const offsets = rowOffsets(heights);
  const total = offsets[heights.length] as number;
  const clamped = Math.max(0, Math.min(offset, Math.max(0, total - 1)));
  return firstRowVisible(offsets, clamped);
}
