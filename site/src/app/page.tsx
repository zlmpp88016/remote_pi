import type { Metadata } from "next";

import { isRemotePiWebClientEnabled } from "@/lib/flags";
import { ConnectClient } from "./remote-pi/connect/connect-client";

/* The root route IS the web client: opening the site lands you directly on the
   pairing screen, with no marketing page in between. The canonical address is
   still /remote-pi/connect (kept so existing links and bookmarks work); this
   file renders the same client container.

   Behavior matches the /remote-pi/connect route byte for byte: server-rendered
   regardless of the flag (a client-side gate would hydrate differently between
   the gate-on and gate-off builds), and `NEXT_PUBLIC_REMOTE_PI_WEB_CLIENT=0`
   remains the explicit kill switch. */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  /* `absolute` opts out of the parent title template ("%s · Remote Pi"), which
     would otherwise append the suffix twice. */
  title: { absolute: "Web client · Remote Pi" },
  description:
    "Connect this browser to a Remote Pi host: pair with a relay address and pairing code, browse the host filesystem, start a Pi workspace and talk to it.",
  robots: { index: false, follow: false },
};

export default function Home() {
  if (!isRemotePiWebClientEnabled()) {
    return (
      <main className="grid min-h-[calc(100vh-70px)] place-items-center px-6">
        <div className="max-w-[520px] text-center">
          <h1 className="text-[22px] font-semibold text-white">
            Web client disabled
          </h1>
          <p className="mt-3 text-[14.5px] leading-relaxed text-[#a3a3a3]">
            This deployment was built with{" "}
            <code className="font-mono text-[13px] text-[#d4d4d4]">
              NEXT_PUBLIC_REMOTE_PI_WEB_CLIENT=0
            </code>
            , which turns the browser client off. Remove the variable and
            rebuild to enable it.
          </p>
        </div>
      </main>
    );
  }
  return <ConnectClient />;
}
