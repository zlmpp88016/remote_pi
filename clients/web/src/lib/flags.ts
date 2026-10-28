/**
 * Feature flags for the Remote Pi web client (plan 69 W4).
 *
 * The client lives at the route `/remote-pi/connect`, inside the `/remote-pi`
 * product section. It is a FIRST-CLASS client alongside the mobile app and the
 * Cockpit desktop app, so it is ON by default and reachable from the site
 * navigation.
 *
 * `REMOTE_PI_WEB_CLIENT=0` is the explicit kill switch: set it at build time to
 * hide the client (the connect route renders a "disabled" notice and the nav
 * entry disappears), e.g. for a deployment that must not expose a browser client.
 * Any other value — including unset — keeps it enabled.
 *
 * WHY `import.meta.env` AND NOT `process.env`: this is a browser bundle now. The
 * Next build used to inline `process.env.NEXT_PUBLIC_*` at build time; Vite has
 * no `process` global at all, so reading it threw `ReferenceError: process is not
 * defined` and blanked the page. `import.meta.env` is Vite's equivalent and is
 * likewise replaced at build time — same deploy-time granularity, one switch.
 *
 * THE LEGACY NAME IS STILL HONOURED: `NEXT_PUBLIC_REMOTE_PI_WEB_CLIENT` is
 * spelled in deployment configs, release notes and the disabled-state message.
 * Renaming it outright would silently flip a deployment that had opted out back
 * to enabled — the opposite of a safe migration. Both are accepted; the new name
 * wins when both are set.
 */

/** Read one build-time variable, preferring the current name over the legacy one. */
function flag(current: string | undefined, legacy: string | undefined): string | undefined {
  return current ?? legacy;
}

/** True unless the deployment explicitly opted out with `=0`. */
export function isRemotePiWebClientEnabled(): boolean {
  const value = flag(
    import.meta.env.VITE_REMOTE_PI_WEB_CLIENT,
    import.meta.env.VITE_NEXT_PUBLIC_REMOTE_PI_WEB_CLIENT,
  );
  return value !== "0";
}
