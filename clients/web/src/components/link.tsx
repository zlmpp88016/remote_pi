/**
 * An in-app link.
 *
 * WHY THIS EXISTS INSTEAD OF RAW `<a>`: the docs page has a dozen of these, and
 * every one of them is an internal route. Spelling out `onClick={useLinkHandler()}`
 * at each site would repeat the same five-line bail-out logic a dozen times and
 * invite a copy to drift. This wrapper keeps the call sites identical to what
 * `next/link` looked like, so the migration is a one-line import change per file
 * rather than a rewrite of every anchor.
 *
 * It renders a real `<a href>`: middle-click, "open in new tab", and the status
 * bar preview all keep working, which a `div`-with-onClick would lose.
 */

import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from "react";
import { useLinkHandler } from "@/router";

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  readonly href: string;
  readonly children: ReactNode;
}

export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { href, children, onClick, ...rest },
  ref,
) {
  const onInternalClick = useLinkHandler();
  return (
    <a
      {...rest}
      ref={ref}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        onInternalClick(event);
      }}
    >
      {children}
    </a>
  );
});
