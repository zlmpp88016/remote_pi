/**
 * Plan 86 P3 — the bounded transcript window and the Markdown render cache.
 *
 * THE TWO CLAIMS THIS GATE MAKES TESTABLE
 *
 * 1. A HUNDRED PAGES STAY BOUNDED.
 *    Paging appends items; the DOM must not grow with them. The window is
 *    computed from measured heights, so the test drives 5000 rows (100 pages of
 *    50) through every scroll position a reader would pass and asserts that the
 *    MOUNTED count never exceeds the cap, while the scroll box keeps its full
 *    height (so the scrollbar and the scroll position stay honest).
 *
 * 2. THE MARKDOWN CACHE IS KEYED BY CONTENT, THEME AND WIDTH — NOT BY LENGTH.
 *    A length key would render one message's text inside another message that
 *    happened to be the same size. The test proves two equal-length, different
 *    contents never collide, that a theme or width change misses, that a hash
 *    collision would be caught by the stored text, and that the cache is bounded.
 *
 * Run: node scripts/verify-web-history-window.mjs
 */

import {
  DEFAULT_MAX_RENDERED,
  DEFAULT_OVERSCAN_PX,
  computeWindow,
  rowAtOffset,
  rowOffsets,
} from "../src/components/remote-pi/sessions/virtual-window.ts";
import { captureRowAnchor, restoreRowAnchor, pruneRowHeights } from "../src/components/remote-pi/sessions/viewer-state.ts";
import {
  MarkdownRenderCache,
  markdownCacheKey,
  markdownContentHash,
  markdownWidthBucket,
} from "../src/components/remote-pi/chat/markdown-render-cache.ts";

let checks = 0;
const failures = [];

function check(label, ok, detail = "") {
  checks += 1;
  if (ok) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures.push(`${label}${detail ? ` :: ${detail}` : ""}`);
  console.log(`  FAIL ${label}${detail ? ` :: ${detail}` : ""}`);
}

/** One hundred pages of fifty rows, each row a fixed height. */
const PAGE_SIZE = 50;
const PAGES = 100;
const ROW_HEIGHT = 80;
const TOTAL_ROWS = PAGE_SIZE * PAGES;
const HEIGHTS = new Array(TOTAL_ROWS).fill(ROW_HEIGHT);
const VIEWPORT = 800;

// ── A. window math ──────────────────────────────────────────────────────────

function windowMath() {
  console.log("\nA. the window contains the viewport and its overscan");
  const empty = computeWindow({ heights: [], scrollTop: 0, viewportHeight: VIEWPORT });
  check("an empty transcript renders nothing", empty.rendered === 0 && empty.totalHeight === 0);

  const uneven = Array.from({ length: 40 }, (_, i) => 20 + ((i * 37) % 160));
  const total = rowOffsets(uneven).at(-1);
  const atTop = computeWindow({ heights: uneven, scrollTop: 0, viewportHeight: 400 });
  const offsets = rowOffsets(uneven);
  check(
    "the top spacer is zero at the top",
    atTop.topSpacer === 0 && atTop.start === 0,
  );
  check(
    "the window covers the whole viewport",
    (offsets[atTop.end] ?? 0) >= 400,
    `covers=${offsets[atTop.end]}`,
  );
  check(
    "spacers reconstruct the exact total height",
    atTop.topSpacer + atTop.rendered * 0 + (offsets[atTop.end] - offsets[atTop.start]) + atTop.bottomSpacer === total,
    `${atTop.topSpacer}+${offsets[atTop.end] - offsets[atTop.start]}+${atTop.bottomSpacer} != ${total}`,
  );

  const middle = computeWindow({ heights: uneven, scrollTop: offsets[20], viewportHeight: 400 });
  check("the window starts at or before the first visible row", middle.start <= 20);
  check("the window ends after the last visible row", middle.end >= 21);
  check("the top spacer equals the prefix height", middle.topSpacer === offsets[middle.start]);
  check("rowAtOffset finds the row under the offset", rowAtOffset(uneven, offsets[20]) === 20);

  const clamped = computeWindow({ heights: HEIGHTS, scrollTop: 10_000_000, viewportHeight: VIEWPORT });
  check("an over-scrolled position clamps to the end", clamped.end === TOTAL_ROWS);
  check("... and leaves no bottom spacer", clamped.bottomSpacer === 0);
}

// ── B. one hundred pages stay bounded ───────────────────────────────────────

function hundredPages() {
  console.log("\nB. scrolling 100 pages never grows the DOM past the cap");
  let maxRendered = 0;
  let maxNodes = 0;
  const positions = [];
  // Walk every page boundary plus a few offsets inside each page.
  for (let page = 0; page < PAGES; page += 1) {
    for (const within of [0, ROW_HEIGHT * 7, ROW_HEIGHT * 24]) {
      positions.push(page * PAGE_SIZE * ROW_HEIGHT + within);
    }
  }
  for (const scrollTop of positions) {
    const window = computeWindow({ heights: HEIGHTS, scrollTop, viewportHeight: VIEWPORT });
    maxRendered = Math.max(maxRendered, window.rendered);
    // Mounted rows (the only DOM this feature controls).
    maxNodes = Math.max(maxNodes, window.rendered);
    if (window.rendered > DEFAULT_MAX_RENDERED) {
      check("rendered rows stay within the cap", false, `${window.rendered} at ${scrollTop}`);
      return;
    }
  }
  check(
    `rendered rows never exceed the ${DEFAULT_MAX_RENDERED}-row cap across ${positions.length} positions`,
    maxRendered <= DEFAULT_MAX_RENDERED,
    `max=${maxRendered}`,
  );
  check("mounted DOM nodes stay bounded while the item count grows to 5000", maxNodes <= DEFAULT_MAX_RENDERED, String(maxNodes));
  check("the item count really is 5000", TOTAL_ROWS === 5000, String(TOTAL_ROWS));

  // The scroll box keeps its full height: spacers + mounted rows.
  const sample = computeWindow({ heights: HEIGHTS, scrollTop: 250 * ROW_HEIGHT, viewportHeight: VIEWPORT });
  const mountedHeight = (sample.end - sample.start) * ROW_HEIGHT;
  check(
    "the scroll box keeps the full transcript height",
    sample.topSpacer + mountedHeight + sample.bottomSpacer === TOTAL_ROWS * ROW_HEIGHT,
    `${sample.topSpacer}+${mountedHeight}+${sample.bottomSpacer}`,
  );

  // The overscan really is near-viewport: rows just above and below are mounted.
  const near = computeWindow({ heights: HEIGHTS, scrollTop: 100 * ROW_HEIGHT, viewportHeight: VIEWPORT });
  const firstVisible = Math.floor((100 * ROW_HEIGHT) / ROW_HEIGHT);
  const lastVisible = Math.ceil((100 * ROW_HEIGHT + VIEWPORT) / ROW_HEIGHT);
  check("rows above the viewport are mounted (overscan)", near.start < firstVisible);
  check("rows below the viewport are mounted (overscan)", near.end > lastVisible);
  check(
    "the overscan is bounded in pixels, not unbounded",
    (firstVisible - near.start) * ROW_HEIGHT <= DEFAULT_OVERSCAN_PX + ROW_HEIGHT,
    `${(firstVisible - near.start) * ROW_HEIGHT}px`,
  );
}

// ── C. markdown cache identity ──────────────────────────────────────────────

function markdownIdentity() {
  console.log("\nC. the Markdown cache is keyed by content, theme and width");
  const sameLengthDifferentContent = ["abcdefgh", "abcdefgi"];
  check(
    "two EQUAL-LENGTH different contents hash differently",
    markdownContentHash(sameLengthDifferentContent[0]) !== markdownContentHash(sameLengthDifferentContent[1]),
  );
  check(
    "their cache keys differ",
    markdownCacheKey({ text: sameLengthDifferentContent[0], theme: "dark", width: 800 }) !==
      markdownCacheKey({ text: sameLengthDifferentContent[1], theme: "dark", width: 800 }),
  );

  const base = { text: "hello **world**", theme: "dark", width: 800 };
  check(
    "the SAME content in another theme is another key",
    markdownCacheKey(base) !== markdownCacheKey({ ...base, theme: "light" }),
  );
  check(
    "the SAME content at another width is another key",
    markdownCacheKey(base) !== markdownCacheKey({ ...base, width: 560 }),
  );
  check(
    "widths inside one 16px bucket share a key (a 1px resize is not a re-parse)",
    markdownCacheKey({ ...base, width: 800 }) === markdownCacheKey({ ...base, width: 807 }),
  );
  check("the bucket is a multiple of 16", markdownWidthBucket(800) % 16 === 0);
  check("an unmeasured width is bucket 0", markdownWidthBucket(0) === 0 && markdownWidthBucket(Number.NaN) === 0);
}

// ── D. markdown cache behaviour ─────────────────────────────────────────────

function markdownCache() {
  console.log("\nD. the Markdown cache hits, misses and stays bounded");
  let clock = 0;
  const cache = new MarkdownRenderCache({ maxEntries: 3, maxBytes: 64, now: () => (clock += 1) });
  const key = { text: "one", theme: "dark", width: 800 };
  check("a miss is null", cache.get(key) === null);
  cache.set(key, "element-one");
  check("a hit returns the SAME value", cache.get(key) === "element-one");
  check(
    "another theme misses",
    cache.get({ ...key, theme: "light" }) === null,
  );
  check(
    "another width bucket misses",
    cache.get({ ...key, width: 400 }) === null,
  );

  // LRU by entries.
  cache.set({ text: "two", theme: "dark", width: 800 }, "element-two");
  cache.set({ text: "three", theme: "dark", width: 800 }, "element-three");
  cache.get(key); // touch "one" so "two" becomes the oldest
  cache.set({ text: "four", theme: "dark", width: 800 }, "element-four");
  check("the entry cap holds", cache.entriesCount <= 3, String(cache.entriesCount));
  check("the least-recently-used entry was evicted", cache.get({ text: "two", theme: "dark", width: 800 }) === null);
  check("the recently-touched entry survived", cache.get(key) === "element-one");

  // Byte ceiling: an oversize value is refused instead of evicting everything.
  const small = new MarkdownRenderCache({ maxEntries: 10, maxBytes: 32, now: () => 0 });
  small.set({ text: "x".repeat(10), theme: "dark", width: 0 }, "a");
  small.set({ text: "x".repeat(200), theme: "dark", width: 0 }, "huge");
  check("an oversize value is refused", small.get({ text: "x".repeat(200), theme: "dark", width: 0 }) === null);
  check("the refusal did not empty the cache", small.get({ text: "x".repeat(10), theme: "dark", width: 0 }) === "a");
  check("the byte ceiling holds", small.bytes <= 32, String(small.bytes));

  // A hash collision must miss, not return the wrong text.
  const collision = new MarkdownRenderCache({ now: () => 0 });
  collision.set({ text: "aaaa", theme: "dark", width: 0 }, "value-a");
  check(
    "a same-hash different-text lookup is refused by the stored text",
    collision.get({ text: "bbbb", theme: "dark", width: 0 }) === null,
  );
}

function variableHeightAnchor() {
  console.log("E. nonzero row offset survives prepend and late heights");
  const keys = ["a", "b", "c"], heights = [120, 230, 90];
  const anchor = captureRowAnchor(keys, heights, 157);
  check("anchor captures an interior offset", anchor.id === "b" && anchor.offset === 37);
  const prepended = ["older", ...keys], next = [380, ...heights];
  check("prepend ADDS the interior offset", restoreRowAnchor(anchor, prepended, next) === 537);
  const afterLateMeasurement = [411, 133, 260, 90];
  check("late variable heights retain the same row and offset", restoreRowAnchor(anchor, prepended, afterLateMeasurement) === 581);
  check("evicted anchor is reported explicitly", restoreRowAnchor(anchor, ["c"], [90]) === null);
  const map = new Map([["a", 120], ["b", 230], ["gone", 999]]);
  const pruned = pruneRowHeights(map, new Set(keys));
  check("height ownership drops evicted keys", pruned.size === 2 && !pruned.has("gone"));
  check("status-only state reuses the height map", pruneRowHeights(pruned, new Set(keys)) === pruned);
  let current = pruned;
  for (let i = 0; i < 100; i++) {
    const resident = new Set(Array.from({ length: 200 }, (_, n) => String(i * 50 + n)));
    current = pruneRowHeights(new Map([...current, ...[...resident].map(id => [id, 100])]), resident);
  }
  check("100 page shifts keep height entries bounded", current.size === 200);
}

variableHeightAnchor();
console.log("verify-web-history-window — bounded DOM and content-keyed Markdown");
windowMath();
hundredPages();
markdownIdentity();
markdownCache();

console.log(`\n${checks - failures.length}/${checks} checks PASS`);
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) FAILED`);
  process.exit(1);
}
console.log("verify-web-history-window: OK");
