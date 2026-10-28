/**
 * The router.
 *
 * WHY HAND-WRITTEN: the app has exactly three routes and no nested layouts, no
 * loaders, and no code-splitting requirement. A routing library would add a
 * dependency, a provider, and an abstraction to hide a `switch` on
 * `location.pathname`. This file is that switch, plus the two behaviours a
 * router actually has to get right: intercept in-app link clicks, and respond to
 * back/forward.
 *
 * HISTORY MODE, NOT HASH: the URLs are already published (`/remote-pi/docs`,
 * `/remote-pi/connect`), and the relay pairing flow stores state in
 * `localStorage` scoped by origin — neither survives a hash-based rewrite.
 *
 * THE 404 PATH MATTERS FOR THE SHELL: a packaged desktop app serves from
 * `app://app/...` with no server to rewrite unknown paths, so an unknown route
 * renders the not-found view in place rather than requesting anything.
 */

import { useCallback, useEffect, useState, type MouseEvent } from "react";

/** Every route the app renders. Order is irrelevant; matching is exact. */
export type Route =
  | { readonly kind: "connect" }
  | { readonly kind: "docs" }
  | { readonly kind: "notFound"; readonly path: string };

/**
 * Old URLs that must keep working.
 *
 * These were Next `redirects()` entries — served by the server with a 308. No
 * server exists now, so the same table is applied client-side: the entry
 * replaces the address bar before the first render, so a bookmarked link lands
 * on the right page with the right URL.
 */
const REDIRECTS: Readonly<Record<string, string>> = {
  "/cockpit": "/",
  "/cockpit/docs": "/docs",
  "/why": "/remote-pi/why",
  "/tutorials/getting-started": "/remote-pi/tutorials/getting-started",
  "/tutorials/mesh-local": "/remote-pi/tutorials/mesh-local",
  "/tutorials/mesh-remote": "/remote-pi/tutorials/mesh-remote",
  "/tutorials/daemon": "/remote-pi/tutorials/daemon",
  "/tutorials/claude-mesh": "/remote-pi/tutorials/claude-mesh",
};

/** Normalise to a trailing-slash-free path so `/docs/` and `/docs` match once. */
function normalise(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

export function routeFor(pathname: string): Route {
  const path = normalise(pathname);
  // The root IS the web client: opening the site lands on the pairing screen.
  if (path === "/" || path === "/remote-pi/connect") return { kind: "connect" };
  if (path === "/remote-pi/docs") return { kind: "docs" };
  return { kind: "notFound", path };
}

/**
 * Resolve a redirect for a path, if one exists. Returns the target path only —
 * the caller decides whether to `replaceState` (initial load) or push (a click).
 */
export function redirectFor(pathname: string): string | null {
  return REDIRECTS[normalise(pathname)] ?? null;
}

/**
 * Apply the redirect table to the initial URL, once, before anything renders.
 *
 * Called from `main.tsx` rather than from the hook: doing it during render would
 * mutate history while React is rendering, which React 18's strict mode runs
 * twice.
 */
export function applyInitialRedirect(): void {
  const target = redirectFor(window.location.pathname);
  if (target === null) return;
  window.history.replaceState(null, "", target + window.location.search + window.location.hash);
}

export interface NavigateOptions {
  /** Replace instead of pushing, so the Back button skips the current page. */
  readonly replace?: boolean;
}

/** Navigate without a full page load. The single place `pushState` is called. */
export function navigate(to: string, options: NavigateOptions = {}): void {
  const url = new URL(to, window.location.origin);
  const same = url.pathname + url.search + url.hash ===
    window.location.pathname + window.location.search + window.location.hash;
  if (same) return;
  if (options.replace === true) {
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  } else {
    window.history.pushState(null, "", url.pathname + url.search + url.hash);
  }
  // `pushState` does not fire `popstate`, so the listener below never sees this
  // navigation. Dispatching a synthetic event keeps ONE update path: the hook
  // listens for `popstate` only, and every navigation routes through it.
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/**
 * Current route, kept in sync with the address bar.
 *
 * `popstate` covers Back/Forward and the synthetic event that `navigate` fires.
 * There is deliberately no `pushState` monkey-patch: intercepting the native API
 * to observe other callers is a debugging trap, and this app has exactly one.
 */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => routeFor(window.location.pathname));

  useEffect(() => {
    const sync = (): void => {
      const target = redirectFor(window.location.pathname);
      if (target !== null) {
        window.history.replaceState(null, "", target + window.location.search);
        setRoute(routeFor(target));
        return;
      }
      setRoute(routeFor(window.location.pathname));
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  return route;
}

/**
 * A click handler for in-app links.
 *
 * Bails out — leaving the browser to handle the click normally — when the user
 * asked for a new tab/window, when a modifier key is held, for a download, or
 * for a different origin. Those are exactly the cases where hijacking the click
 * would break a behaviour the user expects.
 */
export function useLinkHandler(): (event: MouseEvent<HTMLAnchorElement>) => void {
  return useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.currentTarget;
    if (anchor.target !== undefined && anchor.target !== "" && anchor.target !== "_self") return;
    if (anchor.hasAttribute("download")) return;
    const url = new URL(anchor.href, window.location.origin);
    if (url.origin !== window.location.origin) return;
    event.preventDefault();
    navigate(url.pathname + url.search + url.hash);
  }, []);
}
