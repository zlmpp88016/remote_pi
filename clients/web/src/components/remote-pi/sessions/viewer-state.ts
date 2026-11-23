/** Virtual-history state helpers, shared by the viewer and focused tests. */
import { rowAtOffset, rowOffsets } from "./virtual-window.ts";

export interface RowAnchor { id: string; offset: number }

export function captureRowAnchor(keys: readonly string[], heights: readonly number[], scrollTop: number): RowAnchor | null {
  const index = rowAtOffset(heights, scrollTop);
  const id = keys[index];
  return id === undefined ? null : { id, offset: scrollTop - (rowOffsets(heights)[index] ?? 0) };
}

/** offset was saved as scrollTop - rowTop, so restoration ADDS it. */
export function restoreRowAnchor(anchor: RowAnchor, keys: readonly string[], heights: readonly number[]): number | null {
  const index = keys.indexOf(anchor.id);
  return index < 0 ? null : Math.max(0, (rowOffsets(heights)[index] ?? 0) + anchor.offset);
}

/** No height survives the lifetime of its resident row. Identity is retained
 * when nothing was removed, so status-only changes cannot trigger a reflow. */
export function pruneRowHeights(current: ReadonlyMap<string, number>, keys: ReadonlySet<string>): ReadonlyMap<string, number> {
  if ([...current.keys()].every(key => keys.has(key))) return current;
  return new Map([...current].filter(([key]) => keys.has(key)));
}
