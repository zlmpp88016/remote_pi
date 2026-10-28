/**
 * `core` — the pieces every other layer may depend on.
 *
 * Nothing here imports from `layout`, `chat`, `sessions` or `primitives`: this
 * layer is the bottom of the dependency order, so it stays renderable in
 * isolation and testable without mounting the shell.
 */

export * from "./geometry";
export * from "./icons";
export * from "./slots";
export * from "./use-scroll-follow";
export * from "./view-model";
