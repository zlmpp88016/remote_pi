/**
 * The app shell.
 *
 * This replaces the old root `layout.tsx`: the document chrome lives in
 * `index.html`, and what remains is the element tree — a `<main>` for the route
 * and the site footer beneath it.
 *
 * The footer is NOT rendered on the connect route. The web client is a
 * full-height application surface with its own bottom bar; stacking a marketing
 * footer under it would shrink the app viewport and change the layout the user
 * already knows. The old Next build achieved the same thing by rendering the
 * client inside the root layout's `<main>` but at a height that pushed the
 * footer off-screen; being explicit here is clearer than relying on overflow.
 */

import { useRoute } from "@/router";

import css from "./app-shell.module.css";
import { SiteFooter } from "@/components/footer";
import { RevealController } from "@/components/landing/reveal-controller";
import { ConnectPage } from "@/pages/connect-page";
import { DocsPage } from "@/pages/docs-page";
import { NotFoundPage } from "@/pages/not-found-page";

export function App() {
  const route = useRoute();

  if (route.kind === "connect") {
    return (
      <div className={`app ${css.shell}`} id="top">
        <main className={css.main}>
          <ConnectPage />
        </main>
      </div>
    );
  }

  return (
    <div className={`app ${css.shell}`} id="top">
      {/* Reveal-on-scroll is an IntersectionObserver over `.reveal` elements, so
          it must be mounted wherever those exist — the docs page and the landing
          sections both use the class. */}
      <RevealController />
      <main className={css.main}>
        {route.kind === "docs" ? <DocsPage /> : <NotFoundPage path={route.path} />}
      </main>
      <SiteFooter />
    </div>
  );
}
