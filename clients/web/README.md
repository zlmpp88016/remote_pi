# Remote Pi — Site

Landing page for [Remote Pi](https://github.com/exampleorg/remote_pi) — the
project that lets you control a Pi coding agent from your phone over an
end-to-end encrypted channel.

This package ships three static routes:

- `/` — landing (hero, features, quick start, GitHub CTA)
- `/terms` — Terms of Service
- `/privacy` — Privacy Policy (LGPD)

Target domain: <https://remote-pi.example.invalid>.

## Start

The web client route `/remote-pi/connect` is a first-class client (next to the
mobile app and Cockpit) and is reachable from the site navigation and the
download section. It is **ON by default**: no environment variable is needed
to run it locally or to build for production.

`NEXT_PUBLIC_REMOTE_PI_WEB_CLIENT=0` is the explicit kill switch — set it before
the dev server or the build to hide the client (route 404s, nav entry and the
download card disappear). Any other value, including unset, keeps it enabled.

```bash
npm install     # install deps

npm run dev     # Vite dev server at http://localhost:3010
npm run build   # typecheck, then production build → dist/
npm run preview # serve the production build locally
```

With npm the script subcommand is required (`npm build` / `npm dev` are NOT
commands).

Open <http://localhost:3010/remote-pi/connect> — or click **Open web client** in
the `/remote-pi` nav — then paste the relay address + `remotepi://pair?...` code
printed by `remote-pi-server pair` on the host machine. The dev server and the relay
both default to port 3000 — run one of them on another port when they share a
machine (`npx vite --port 3167`).

## Stack

- Vite 6 + React 18 (pure client-side rendering — no SSR, no server)
- TypeScript 6 (strict)
- CSS Modules + global token stylesheets (no utility framework)
- ESLint 9
- Package manager: **npm**

Dark-only theme; visual identity lives in `../../branding/`.

## Commands

```bash
npm install     # install deps
npm run dev     # Vite dev server at http://localhost:3010
npm run build   # production build → dist/
npm run preview # serve the production build
npm run lint    # ESLint (0 errors required; see eslint.config.mjs)
```

Verification (all run from this directory):

```bash
node scripts/verify-stack-parity.mjs   # the stack itself: deps, no next/* imports
npm run lint                           # ESLint: 0 errors (94 known warnings)
npx tsc --noEmit                       # types
node scripts/run-web-checks.mjs        # 14 focused runners
node scripts/_e2e-verify-rows.mjs      # real browser + real relay, 11 session rows
node scripts/verify-visual-parity.mjs   # DSH design-platform parity (tokens + components)
```

The browser-driven scripts read the dev-server port from `vite.config.ts`
(`APP_ORIGIN` in `scripts/_cdp.mjs`) instead of hardcoding it, and `attach()`
now fails loudly when the app's tab is missing rather than falling back to an
arbitrary page. Start the dev server first, and pair the browser once using the
`remotepi://` URI from `cd ../server && node dist/index.js pair`.

## Layout

```
src/
├── main.tsx                    # entry: initial redirect, then createRoot
├── router.tsx                  # hand-written 3-route router (no framework)
├── app-shell.tsx               # header + main + footer
├── pages/                      # one file + one *.module.css per route
│   ├── connect-page.tsx        #   / and /remote-pi/connect
│   ├── docs-page.tsx           #   /remote-pi/docs
│   └── not-found-page.tsx
├── client/                     # the Remote Pi client itself
├── components/
│   ├── landing/                # marketing components
│   └── remote-pi/              # chat, sessions, layout, primitives
├── lib/remote-pi/              # protocol, session helpers
└── styles/                     # global.css, tokens, preflight, fonts
```

Every component with styles owns a sibling `*.module.css`; there is no shared
utility stylesheet. `src/styles/properties.css` holds the `--tw-*` initial values
and design-token values the modules reference by name, so it must not be deleted
alongside unused component classes.

## Conventions

- **No server.** Everything renders in the browser; there is no SSR, RSC, or API layer to reason about.
- **No backend / API routes** in the MVP. The site is purely presentational.
- **No analytics, no tracking cookies.** Aligned with the project's privacy posture.
- **English only** in the MVP. PT-BR is a separate plan if demand appears.

## Deploy

Any static host works: `npm run build` emits a self-contained `dist/` with a
single `index.html` and hashed assets under `assets/`. The host must serve
`index.html` for unknown paths (SPA fallback) so client-side routes resolve.
Domain wiring is handled outside this repo.
