/**
 * Slot registry for the app shell.
 *
 * WHAT THIS IS FOR: the shell composes a fixed set of regions (sidebar, center,
 * dock). A region sometimes needs to render something the shell does not own —
 * a banner, an extra dock tab, a footer beside the composer. Expressing that as
 * props would mean threading a new prop through every layer above it, so callers
 * instead *register* a contribution against a named key and the region renders
 * whatever is registered for it.
 *
 * WHY NOT `declare module` TYPE MERGING (which is what deepseek-harness does):
 * that pattern lets each package widen a shared interface so packages never
 * import each other. We are one app in one repo — there is no package boundary
 * to preserve, and module augmentation makes the set of valid keys invisible at
 * the call site (a typo becomes a silent extra key, not a type error) while
 * forcing every contributor to import the declaration file for its side effect.
 * A plain object plus a literal union keeps the check in one place and reads the
 * same in an editor.
 *
 * WHY THE REGISTRY IS EXPLICIT RATHER THAN A GLOBAL SINGLETON: registration
 * happens at module scope, so a global store would make render output depend on
 * import order and survive across tests. `registerSlot` writes into a module
 * local map, and `readSlot` is a pure read used during render — the only mutable
 * surface is registration, which runs during app bootstrap.
 */

import { Fragment, type ReactNode } from "react";

/**
 * The regions the shell renders. Adding a region is a deliberate edit here:
 * the union is what makes an unknown key a type error rather than a no-op.
 */
export type SlotKey =
  /** Above the transcript, below the header — notices that concern the whole room. */
  | "chat.banner"
  /** Rendered after the transcript, inside the same scroller. */
  | "chat.afterTranscript"
  /** Extra rows at the top of the right dock's tab strip. */
  | "dock.tabs"
  /** Rendered at the top of the sidebar, above the workspace list. */
  | "sidebar.header";

/** A contribution is a render function, so it can read its own state and props. */
export type SlotRenderer = () => ReactNode;

const registry = new Map<SlotKey, SlotRenderer[]>();

/**
 * Contribute a renderer to a region.
 *
 * Returns a disposer so a caller can withdraw its contribution — needed when the
 * registration is tied to a component's lifetime rather than to app startup.
 * Registering the same renderer twice is a caller bug: it would silently render
 * twice, so it throws instead of duplicating.
 */
export function registerSlot(key: SlotKey, render: SlotRenderer): () => void {
  const existing = registry.get(key);
  if (existing !== undefined) {
    if (existing.includes(render)) {
      throw new Error(`registerSlot("${key}") called twice with the same renderer`);
    }
    existing.push(render);
  } else {
    registry.set(key, [render]);
  }
  return () => {
    const list = registry.get(key);
    if (list === undefined) return;
    const index = list.indexOf(render);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) registry.delete(key);
  };
}

/**
 * Read the contributions for a region, in registration order.
 *
 * Returns an empty array rather than throwing for an unregistered key: a region
 * with no contributors is the normal case, and the shell renders nothing for it.
 */
export function readSlot(key: SlotKey): SlotRenderer[] {
  return registry.get(key) ?? [];
}

/** Render a region. `null` when nothing is registered, so JSX renders nothing. */
export function Slot({ name }: { readonly name: SlotKey }) {
  const renderers = readSlot(name);
  if (renderers.length === 0) return null;
  return (
    <>
      {renderers.map((render, index) => (
        <Fragment key={index}>{render()}</Fragment>
      ))}
    </>
  );
}
