/**
 * The not-found view.
 *
 * Rendered in place rather than as a server 404, because there is no server: the
 * desktop shell serves static files and the site build is a static tree. The
 * important property is that an unknown path still explains itself and offers a
 * way back, instead of showing a blank page.
 */

import { Link } from "@/components/link";

import css from "./not-found-page.module.css";

export function NotFoundPage({ path }: { readonly path: string }) {
  return (
    <section className={`${css.section} wrap`}>
      {/*
        No `text-faint` here any more. The class was in the markup but Tailwind
        never emitted it — there is no `--color-faint` mapping — so it had no
        effect and the label rendered white. Dropping it keeps the rendering
        exactly as it was; giving the label its intended colour would be a visual
        change, which is not this migration's job.
      */}
      <p className={css.eyebrow}>404</p>
      <h1 className={css.title}>This page does not exist</h1>
      <p className={css.lede}>
        Nothing is served at <code className={css.path}>{path}</code>. The address may be
        from an older version of the site.
      </p>
      <p className={css.links}>
        <Link href="/" className={css.link}>
          Open the web client
        </Link>
        <Link href="/remote-pi/docs" className={css.link}>
          Read the docs
        </Link>
      </p>
    </section>
  );
}
