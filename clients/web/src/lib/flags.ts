/**
 * Feature flags for the Remote Pi web client (plan 69 W4).
 *
 * The client lives at the route `/remote-pi/connect`, inside the existing
 * `/remote-pi` product section of this Next.js app. It is a FIRST-CLASS client
 * alongside the mobile app and the Cockpit desktop app, so the route is ON by
 * default and reachable from the site navigation.
 *
 * `NEXT_PUBLIC_REMOTE_PI_WEB_CLIENT=0` is the explicit kill switch: set it at
 * build time to hide the client (the route 404s and the nav entry disappears),
 * e.g. for a deployment that must not expose a browser client. Any other value
 * — including unset — keeps it enabled.
 *
 * `NEXT_PUBLIC_*` is inlined by Next at build time, which is the intended
 * granularity here: one deploy-time switch, no runtime config endpoint.
 */

/** True unless the deployment explicitly opted out with `=0`. */
export function isRemotePiWebClientEnabled(): boolean {
  return process.env.NEXT_PUBLIC_REMOTE_PI_WEB_CLIENT !== "0";
}
