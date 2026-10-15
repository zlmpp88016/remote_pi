/**
 * Link policy for rendered agent replies.
 *
 * Separate from `markdown.tsx` (which has JSX) so Node can verify the rule
 * directly — the same split as `slash.ts`. This is a SECURITY rule, so it is
 * worth being executable rather than only declared in a component.
 */

/** Protocols an anchor is allowed to carry. Everything else stays text. */
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * True when `href` may become a real link.
 *
 * Relative/anchor-only hrefs are REJECTED rather than resolved: a reply must
 * not be able to navigate the client to an arbitrary in-app route, and the
 * transcript has no routing context to resolve one against anyway.
 *
 * `javascript:` and `data:` are rejected by the same rule — `new URL` parses
 * them, and their protocol is simply not in the allowlist.
 */
export function isSafeHref(href: string | undefined): href is string {
  if (typeof href !== "string" || href.trim() === "") return false;
  try {
    return SAFE_PROTOCOLS.has(new URL(href).protocol);
  } catch {
    // Not an absolute URL: no navigation target we will activate.
    return false;
  }
}
