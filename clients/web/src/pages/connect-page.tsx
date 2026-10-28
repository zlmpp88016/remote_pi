/**
 * The connect page — the Remote Pi web client itself.
 *
 * Both `/` and `/remote-pi/connect` render this: the root IS the client, and the
 * canonical path is kept so published links and bookmarks still resolve. The old
 * Next page called `notFound()` when the build flag disabled the client; there is
 * no server to 404 from now, so the disabled state is rendered in place. That is
 * the same user-visible outcome (no client, an explanation) without depending on a
 * request-time status code.
 */

import { ConnectClient } from "@/client/connect-client";
import { isRemotePiWebClientEnabled } from "@/lib/flags";

import css from "./connect-page.module.css";

export function ConnectPage() {
  if (!isRemotePiWebClientEnabled()) return <ClientDisabled />;
  return <ConnectClient />;
}

function ClientDisabled() {
  return (
    <main className={css.shell}>
      <div className={css.box}>
        <h1 className={css.title}>Web client disabled</h1>
        <p className={css.detail}>
          This deployment was built with{" "}
          <code className={css.code}>NEXT_PUBLIC_REMOTE_PI_WEB_CLIENT=0</code>, which turns
          the browser client off. Remove the variable and rebuild to enable it.
        </p>
      </div>
    </main>
  );
}
