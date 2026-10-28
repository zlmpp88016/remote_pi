/**
 * Scroll-follow for the transcript.
 *
 * The transcript is a stream: new content arrives while the user may be reading
 * further up. The rule is therefore not "always scroll to the bottom" — that
 * yanks the view away from whatever they are reading — but "stay pinned only
 * while the user is already at the bottom".
 *
 * The decisions follow deepseek-harness (`ui-chat/src/client/chat/ChatView.tsx`
 * + `ChatView.module.css`): the state is a single boolean exposed as a `data`
 * attribute, so CSS can consume it (`overflow-anchor: none` while following,
 * which stops the browser from fighting the programmatic scroll) and the TSX can
 * use the same value to decide whether the "jump to latest" button is shown.
 *
 * WHY A THRESHOLD, NOT AN EQUALITY: sub-pixel layout, zoom and momentum scrolling
 * all leave `scrollTop` a fraction away from `scrollHeight - clientHeight`, so an
 * equality check reports "not at the bottom" while the user plainly is.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** Distance from the bottom (px) that still counts as "at the bottom". */
const AT_BOTTOM_SLACK = 24;

export interface ScrollFollow {
  /** Attach to the scrolling element. */
  readonly ref: React.MutableRefObject<HTMLDivElement | null>;
  /** True while the view is pinned to the newest content. */
  readonly following: boolean;
  /** Jump to the newest content and re-pin. */
  readonly toBottom: () => void;
  /** Install the handlers; call from the element's `onScroll`. */
  readonly onScroll: () => void;
}

export function useScrollFollow(): ScrollFollow {
  const ref = useRef<HTMLDivElement | null>(null) as React.MutableRefObject<HTMLDivElement | null>;
  const [following, setFollowing] = useState(true);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (el === null) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setFollowing(distance <= AT_BOTTOM_SLACK);
  }, []);

  const toBottom = useCallback(() => {
    const el = ref.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
    setFollowing(true);
  }, []);

  // New content (a streamed chunk, a tool card, a new turn) grows `scrollHeight`
  // without any scroll event. While the view is pinned, follow that growth;
  // while it is not, leave the reader exactly where they are.
  //
  // No "is this scroll programmatic" flag: the position is written to the same
  // value the observer would compute, so a follow-up `onScroll` derives the same
  // `following` state either way. A flag existed first and could stay stuck at
  // `true` in a background tab where `requestAnimationFrame` never fires.
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (!following) return;
    const observer = new MutationObserver(() => {
      const node = ref.current;
      if (node === null) return;
      node.scrollTop = node.scrollHeight;
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [following]);

  return { ref, following, toBottom, onScroll };
}
