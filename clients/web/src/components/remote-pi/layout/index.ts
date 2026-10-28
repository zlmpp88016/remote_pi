/**
 * `layout` — the shell and the three regions it composes.
 *
 * Depends on `core`, `chat` and `sessions`; nothing depends on `layout` except
 * the app entry point. That asymmetry is intentional: the shell is the only
 * place that knows how the regions are arranged, so region components never
 * reach back up for geometry.
 */

export * from "./connection-launcher";
export * from "./remote-pi-shell";
export * from "./right-rail";
export * from "./states";
export * from "./workspace-sidebar";
