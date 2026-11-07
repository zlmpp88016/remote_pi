/**
 * Move the CommonJS preload build into place.
 *
 * `package.json` sets `"type": "module"`, so a `.js` file under `dist/` is
 * treated as ESM. Electron's sandboxed preload runtime only executes CommonJS,
 * and it fails SILENTLY when handed ESM: the window still loads, `window.remotePi`
 * is simply never defined. Renaming to `.cjs` is what makes Node/Electron treat
 * the file as CommonJS regardless of the package-level `type`.
 *
 * Only `preload.js` is produced now: the preload deliberately imports nothing,
 * so there is no sibling `ipc.js` to move (see the header of `src/preload.ts`).
 */
import { renameSync, rmSync } from "node:fs";

renameSync("dist/preload-cjs/preload.js", "dist/preload.cjs");
rmSync("dist/preload-cjs", { recursive: true, force: true });
console.log("preload.cjs ready");
