# Remote Pi desktop shell

An Electron window around the **existing web client**. There is no UI code in
this package: `clients/web` at `/remote-pi/connect` is the entire product
surface, and this shell supplies the desktop frame (window, menu, remembered
bounds, single instance).

## Why a shell instead of a second native UI

`clients/desktop` used to carry its own Flutter implementation of the same
protocol (`lib/app/remote_pi`: a 797-line protocol model, a 535-line relay
client, an 806-line host page). Every protocol change had to be made twice, and
the two implementations drifted.

One implementation cannot drift from itself. A protocol change lands once in
`clients/web` and both the browser and the desktop app get it. The trade-off is
explicit: **anything the shell needs must be added to the web client**, not to a
parallel native surface. That is the right trade for a product whose UI is a
remote-control panel — the shell has no privileged local work to do.

## Build and run

```bash
# 1. Build the web client for the shell (writes clients/web/dist-shell)
cd clients/web
node scripts/build-shell-web.mjs

# 2. The shell
cd ../shell
npm install
npm run build
npx electron .

# optional: acceptance check against the running window
npm run start:cdp                     # electron with --remote-debugging-port=9444
npm run verify                        # routes + pairing + session rows
```

For development against the live dev server (hot reload works, because the
renderer is an ordinary browser page pointed at the Vite dev server):

```bash
cd clients/web && npm run dev           # terminal 1
cd clients/shell && npm run dev         # terminal 2
```

## How loading works

Two modes, chosen by whether `REMOTE_PI_WEB_URL` is set:

| Mode | Renderer URL | Assets from |
|---|---|---|
| dev (`REMOTE_PI_WEB_URL=http://localhost:3000/remote-pi/connect`) | that URL | the dev server |
| packaged | `app://app/remote-pi/connect` | `clients/web/dist-shell`, served by a `protocol.handle` handler |

`app://` exists because a `file://` page has an opaque origin, and the client's
WebSocket to the relay and its `localStorage` pairing both need a real one. The
scheme is registered as `standard`, `secure` and `corsEnabled` so the origin
behaves like a normal web origin.

Two details worth knowing before editing `src/main.ts`, because both fail
silently rather than loudly:

- **Asset URLs must be absolute.** Vite used to be configured with
  `base: "./"` for the shell build, on the reasoning that a custom scheme served
  from disk wants relative URLs. It does not: the browser resolves `./assets/x.js`
  against the *document* path, so it works at `app://app/` and requests
  `app://app/remote-pi/assets/x.js` on every other route — a blank page with no
  bundle. `base` is `"/"` in both modes and `REMOTE_PI_SHELL=1` only picks the
  output directory.
- **There is no file per route.** Vite emits one `index.html` plus hashed assets
  under `assets/`; the router is client-side. Unknown paths that look like a
  router path fall back to `index.html`, while a path whose last segment looks
  like a filename (`app.css`) 404s instead of silently returning HTML — a stale
  bundle reference should be an obvious error, not a blank page.
- `fileURLToPath` yields forward slashes (`D:/…`) while `path.resolve` yields
  backslashes (`D:…`) on Windows. The export root is normalised through
  `resolve` so the traversal check compares like with like; without that, every
  request looks like an escape and the window shows "Not found".

## Security posture

The renderer is web content, so: `contextIsolation: true`, `nodeIntegration:
false`, `sandbox: true`, `webSecurity: true`, and no preload — the app needs no
native calls. Navigation away from the app origin is refused and handed to the
user's browser instead. When an IPC surface is eventually needed, it goes
through a preload with an explicit channel list; never `nodeIntegration: true`.

## Relationship to `clients/desktop`

They are separate products:

- `clients/desktop` — **Cockpit**, a full desktop IDE (76k lines: PTY terminal
  via `libghostty`, filesystem, Git worktrees, databases). Its `lib/app/remote_pi`
  module is the Flutter implementation this shell replaces.
- `clients/shell` (this package) — the Remote Pi **remote-control panel**, which
  is the web client in a window.

Cockpit's native capabilities are not reproduced here and are not reachable from
this shell; if a remote-control feature needs one of them, it belongs in
`clients/desktop`.
