# Remote Pi — Site

Landing page for [Remote Pi](https://github.com/jacobaraujo7/remote_pi) — the
project that lets you control a Pi coding agent from your phone over an
end-to-end encrypted channel.

This package ships three static routes:

- `/` — landing (hero, features, quick start, GitHub CTA)
- `/terms` — Terms of Service
- `/privacy` — Privacy Policy (LGPD)

Target domain: <https://remote-pi.jacobmoura.work>.

## Start

The web client route `/remote-pi/connect` is a first-class client (next to the
mobile app and Cockpit) and is reachable from the site navigation and the
download section. It is **ON by default**: no environment variable is needed
to run it locally or to build for production.

`NEXT_PUBLIC_REMOTE_PI_WEB_CLIENT=0` is the explicit kill switch — set it before
the dev server or the build to hide the client (route 404s, nav entry and the
download card disappear). Any other value, including unset, keeps it enabled.

```bash
npm install     # or: pnpm install

npm run dev     # dev server at http://localhost:3000
npm run build   # production build
npm start       # serve the production build
```

With npm the script subcommand is required (`npm build` / `npm dev` are NOT
commands). pnpm drops `run`: `pnpm dev`, `pnpm build`, `pnpm start`, `pnpm lint`.

Open <http://localhost:3000/remote-pi/connect> — or click **Open web client** in
the `/remote-pi` nav — then paste the relay address + `remotepi://pair?...` code
printed by `remote-pi pair` on the host machine. The dev server and the relay
both default to port 3000 — run one of them on another port when they share a
machine (`npx next dev -p 3167`).

## Stack

- Next.js 16 (App Router) + React 19
- TypeScript 5 (strict)
- Tailwind 4 (via `@tailwindcss/postcss`)
- ESLint 9
- Package manager: **pnpm**

Dark-only theme; visual identity lives in `../branding/`.

## Commands

```bash
npm install     # install deps (or: pnpm install)
npm run dev     # dev server at http://localhost:3000
npm run build   # production build (SSG)
npm start       # serve the production build
npm run lint    # ESLint
```

pnpm equivalents drop `run`: `pnpm dev`, `pnpm build`, `pnpm start`, `pnpm lint`.

## Layout

```
src/
├── app/
│   ├── layout.tsx              # Root layout: header + main + footer, global metadata
│   ├── page.tsx                # Landing
│   ├── icon.svg                # Favicon (served as /icon.svg)
│   ├── opengraph-image.tsx     # Generated OG image (next/og)
│   ├── globals.css             # Tailwind + design tokens
│   ├── terms/page.tsx
│   └── privacy/page.tsx
└── components/
    ├── header.tsx              # Logo + nav
    ├── footer.tsx              # Terms/Privacy/GitHub + copyright
    ├── hero.tsx                # Landing hero
    ├── feature-card.tsx        # Reusable card
    ├── code-block.tsx          # Snippet block
    └── legal-shell.tsx         # Shared shell for legal pages
```

## Conventions

- **Server components by default** — only opt into `"use client"` when state, events, or hooks are needed.
- **No backend / API routes** in the MVP. The site is purely presentational.
- **No analytics, no tracking cookies.** Aligned with the project's privacy posture.
- **English only** in the MVP. PT-BR is a separate plan if demand appears.

## Deploy

Vercel is the expected target (zero-config for Next.js). Domain wiring is
handled outside this repo.
