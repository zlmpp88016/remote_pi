/**
 * Gated Remote Pi web client route — `/remote-pi/connect`.
 *
 * This file is a SERVER component on purpose:
 *   • the gate runs on the server, so with `NEXT_PUBLIC_REMOTE_PI_WEB_CLIENT`
 *     unset (or anything other than "1") the route 404s before any client code
 *     is shipped to the browser;
 *   • metadata is server-only, and the client boundary is a single file
 *     (`connect-client.tsx`) that owns every `window`-dependent concern.
 *
 * Deliberate product exception to the "presentation only" rule of this app
 * (clients/web/CLAUDE.md): the Remote Pi web client is gated product surface living
 * inside the site. It adds no backend — no API routes, no data fetching on the
 * server, no marketing changes. The landing pages are untouched.
 *
 * The page is intentionally minimal: gate → metadata → <ConnectClient/>. All
 * shell structure lives in src/components/remote-pi/*, and every product
 * surface that is not wired yet is declared (with its reason) in
 * components/remote-pi/view-model.ts rather than being quietly absent.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { isRemotePiWebClientEnabled } from "@/lib/flags";
import { ConnectClient } from "./connect-client";

/* Server-rendered regardless of the flag: a client-side gate would render
   with the flag OFF (what CI/lint builds see) and hydration would then differ
   from the gate ON build. Declaring it dynamic keeps gate and metadata the
   same on every request. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  /* `absolute` opts out of the parent /remote-pi title template
     ("%s · Remote Pi"), which would otherwise append the suffix twice. */
  title: { absolute: "Web client · Remote Pi" },
  description:
    "Connect this browser to a Remote Pi host: pair with a relay address and pairing code, browse the host filesystem, start a Pi workspace and talk to it.",
  robots: { index: false, follow: false },
};

export default function RemotePiConnectPage() {
  if (!isRemotePiWebClientEnabled()) notFound();
  return <ConnectClient />;
}
