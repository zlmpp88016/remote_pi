"use client";

import { useEffect } from "react";

/**
 * Adds `.in` to every `.reveal` element as it scrolls into view, driving the
 * fade-up animation defined in the stylesheet.
 *
 * WHY THIS OBSERVES THE DOCUMENT AND RE-QUERIES: the controller is a sibling of
 * the page, not its parent, so at the moment its effect runs the page's sections
 * may not have committed yet — a one-shot query returns nothing and no element is
 * ever revealed. A `MutationObserver` keeps watching until they appear, which is
 * order-independent and needs no frame timing.
 *
 * WHY `prefers-reduced-motion` IS CHECKED PER CALL AND LISTENED TO: when the user
 * asks for reduced motion every element must be revealed immediately, with no
 * observer at all — otherwise the content stays at `opacity: 0` for a user who
 * disabled animations precisely to avoid motion. The listener covers the case
 * where the preference changes while the page is open (a system setting, or a
 * test harness emulating it).
 */

/** Reveal everything currently un-revealed, honouring the motion preference. */
function revealAll(): void {
  const els = document.querySelectorAll(".reveal:not(.in)");
  els.forEach((el) => el.classList.add("in"));
}

export function RevealController() {
  useEffect(() => {
    // A marker the verification scripts can assert on: "the controller mounted and
    // its effect ran" is a different fact from "the sections are visible", and
    // when they disagree the bug is in the wiring, not in the observer.
    document.documentElement.dataset["revealController"] = "mounted";
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

    if (motionQuery.matches) {
      // No animation requested: show the content immediately, and skip the
      // observer entirely so a later DOM change cannot hide it again.
      revealAll();
      const onChange = (): void => {
        if (motionQuery.matches) revealAll();
      };
      motionQuery.addEventListener("change", onChange);
      return () => motionQuery.removeEventListener("change", onChange);
    }

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        });
      },
      { threshold: 0.12 },
    );

    /** Attach the observer to any element that has appeared since the last pass. */
    const attach = (): void => {
      document.querySelectorAll(".reveal:not(.in)").forEach((el) => io.observe(el));
    };

    attach();
    // Sections that mount after this effect (the page committing later than its
    // sibling controller) are picked up here.
    const mo = new MutationObserver(attach);
    mo.observe(document.body, { childList: true, subtree: true });

    const onChange = (): void => {
      if (motionQuery.matches) revealAll();
    };
    motionQuery.addEventListener("change", onChange);

    return () => {
      io.disconnect();
      mo.disconnect();
      motionQuery.removeEventListener("change", onChange);
    };
  }, []);

  return null;
}
