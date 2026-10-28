/**
 * Vite configuration for the Remote Pi web client.
 *
 * WHY VITE INSTEAD OF NEXT: the app is a pure client — it renders a pairing form,
 * opens a WebSocket to a relay, and paints transcripts. There is no request-time
 * data it needs from a server, so Next's SSR/RSC machinery was paying for
 * capability the product never used. Vite matches that shape: an `index.html`, a
 * module entry, and a static bundle.
 *
 * BASE IS `/` IN BOTH MODES, and that was a correction rather than a default.
 * The shell build originally used `base: "./"` on the reasoning that the Electron
 * shell serves files from disk under a custom `app://` scheme, so relative asset
 * URLs would be the safe choice. They are not: `./assets/x.js` is resolved by the
 * BROWSER against the current document path, so it works at `app://app/` and
 * fails at `app://app/remote-pi/connect` — the request goes to
 * `app://app/remote-pi/assets/x.js`, which does not exist. The deep routes then
 * render a blank page with no bundle at all.
 *
 * `app://app` is a real origin with a real root, and the shell's protocol handler
 * already maps `/assets/...` onto the export directory, so absolute URLs are both
 * correct and simpler. `REMOTE_PI_SHELL=1` now only selects the output directory.
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const shell = process.env["REMOTE_PI_SHELL"] === "1";

/**
 * The kill switch, carried over from the Next build.
 *
 * Next inlined `process.env.NEXT_PUBLIC_REMOTE_PI_WEB_CLIENT` at build time.
 * Vite only exposes `VITE_*` prefixed variables and provides no `process` global,
 * so the old spelling is mapped into the `VITE_` namespace here. Doing it
 * explicitly — rather than relying on an `envPrefix` guess — means a deployment
 * that had opted out keeps its opt-out instead of silently turning the client
 * back on.
 */
const legacyFlag = process.env["NEXT_PUBLIC_REMOTE_PI_WEB_CLIENT"];
const env =
  legacyFlag === undefined
    ? {}
    : { "import.meta.env.VITE_NEXT_PUBLIC_REMOTE_PI_WEB_CLIENT": JSON.stringify(legacyFlag) };

export default defineConfig({
  // Absolute in both modes — see the header. Relative URLs break every route
  // below the origin root, which is all of them except `/`.
  base: "/",
  plugins: [react()],
  define: env,
  resolve: {
    alias: {
      // Same `@/*` → `src/*` mapping the old tsconfig exposed through Next.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    // The shell serves this tree from disk; a directory named after the target
    // keeps the site build (`dist/`) and the shell build apart.
    outDir: shell ? "dist-shell" : "dist",
    // Source maps are worth the bytes: a production-only defect in the desktop
    // shell has no dev server to reproduce it against.
    sourcemap: true,
    emptyOutDir: true,
  },
  server: {
    port: 3010,
    // The relay handshake is a WebSocket to an external origin; no proxy needed,
    // but a strict port keeps every verification script's URL valid.
    strictPort: true,
  },
});
