/// <reference types="vite/client" />

/**
 * Vite's ambient types.
 *
 * Two things this buys that the Next build got for free:
 *   • `import.meta.env` — the build-time flag namespace (`lib/flags.ts` reads it).
 *   • CSS module/side-effect imports — `import "./styles/global.css"` and the
 *     `?url` font imports resolve as modules, which TypeScript does not know
 *     about on its own.
 */
