/**
 * Feature flags for the Remote Pi minimal web client (plan 69 W4).
 *
 * Placement decision (documented per task W4): the client lives at the route
 * `/remote-pi/connect`, inside the existing `/remote-pi` product section of
 * this Next.js app. The route is OFF by default and only renders when
 * `NEXT_PUBLIC_REMOTE_PI_WEB_CLIENT=1` is set at build time — otherwise it
 * 404s exactly like any unknown path, so the marketing surface of the site is
 * unchanged until the W4/W5 verification gates are green.
 *
 * `NEXT_PUBLIC_*` is inlined by Next at build time, which is the intended
 * granularity here: one deploy-time switch, no runtime config endpoint.
 */

export function isRemotePiWebClientEnabled(): boolean {
  return process.env.NEXT_PUBLIC_REMOTE_PI_WEB_CLIENT === "1";
}
