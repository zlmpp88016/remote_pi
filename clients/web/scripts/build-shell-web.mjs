/**
 * Build the web client for the desktop shell.
 *
 * The output goes to `clients/web/dist-shell`, kept apart from the site build in
 * `dist/` so the two never overwrite each other.
 *
 * HISTORY: this script used to rewrite `export const dynamic = "force-dynamic"`
 * in two page files for the duration of the build, because Next refused a dynamic
 * route under `output: "export"` and the flag could not be made conditional on an
 * env var (it must be a literal). That problem disappeared with Vite — there is
 * no server, so nothing declares itself dynamic — and the build is now a single
 * `vite build` with `REMOTE_PI_SHELL=1` set.
 *
 * That env var only selects the output directory. It deliberately does NOT change
 * `base`: see the note in `vite.config.ts` for why relative asset URLs break every
 * route below the origin root.
 *
 * Usage: `node scripts/build-shell-web.mjs` (from `clients/web`).
 */

import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const build = spawnSync("npx", ["vite", "build"], {
  cwd: siteRoot,
  stdio: "inherit",
  shell: true,
  env: { ...process.env, REMOTE_PI_SHELL: "1" },
});

const status = build.status ?? 1;
if (status !== 0) {
  console.error("shell build failed");
  process.exit(status);
}

console.log("shell build written to clients/web/dist-shell");
