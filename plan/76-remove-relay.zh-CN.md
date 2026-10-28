# 76 — Removing the relay entirely: feasibility, cost, roadmap

## 1. Context

The user asked: **"explore a plan to remove the relay completely — all of it — and go direct to the server, even if that means rewriting most of the server."**

This document answers three things:

1. What the relay still does that the server cannot do itself;
2. What it costs to remove it (which capabilities disappear for good);
3. What plan/73 already shipped, and what is still missing before "direct" can be the default.

**Conclusion up front**: `--direct` is already implemented and passes every DoD in plan/73, and it works when measured. What is actually missing is not "rewrite the server" — it is three pieces of engineering finish-work: a stable port, same-origin static serving, and an origin allowlist. Finish those three and the relay can leave the default path. **But "delete the `relay/` repository" is a different decision, and §4 prices it.**

---

## 2. Measured: direct already runs today

This is not a design sketch — it is a run.

```
$ node dist/bin/supervisord.js --direct
[pi-supervisord] direct mode — local relay at http://127.0.0.1:56542

$ node dist/index.js pair
remotepi://pair?t=…&epk=…&n=lei&rm=host&r=http%3A%2F%2F127.0.0.1%3A56542
                                                  ^^^^^^^^^^^^^^^^^^^^^^^
                                                  local, not relay.880160.xyz
```

Browser side (real Chrome, real clicks): **Relay address left EMPTY**, only the pairing code pasted:

```json
{ "hostConnected": true, "hasComposer": true, "storedRelay": "ws://127.0.0.1:56542" }
```

Server-side evidence — every request handled by the in-process relay, zero public traffic:

```
[relay] embedded relay: peer=Wp1HcwM= room=pEzLl5UwVVKF disconnected
[relay] host room ← workspace_list from aOIqGHaS…
[relay] proxy ← child room=pEzLl5UwVVKF asked=hit (host_message to 1 peer(s))
```

**The client is unchanged** — it is an ordinary WS relay client that does not know where the relay is.

### What the relay actually does

| Responsibility | Rust relay | Embedded relay | Required on one machine |
|---|---|---|---|
| hello→challenge→auth handshake (Ed25519) | yes | **yes** | required |
| `(peer, room)` connection routing | yes | **yes** | required |
| **Rewrite sender identity** on forward | yes | **yes** | required (security foundation) |
| 25s keepalive ping | yes | **yes** | required (feeds the liveness watchdog) |
| Origin allowlist | yes (`relay/src/origin.rs`, permissive by default) | **no** | **required, see §3** |
| `pi_envelope` Pi-to-Pi across machines | yes | no (explicitly ignored) | no |
| `subscribe_presence` / `presence_check` | yes | no | no (web client never sends them) |
| `rooms` / `room_meta_updated` | yes | no | no |
| `mesh/` membership store | yes | no | no |

The embedded version covers every "required on one machine" row in ~302 lines. **The only genuinely surplus parts of the Rust relay for the single-machine case are mesh / presence / room-catalog.**

---

## 3. Three gaps plan/73 did not cover (new findings this round)

### 3.1 The port is random — every restart invalidates the pairing

`direct.ts:49`:

```ts
export async function ensureDirectRelay(port = 0): Promise<string>
```

`port = 0` lets the OS choose (measured: `56542`). **Restart the supervisor → the port changes → the stored `ws://127.0.0.1:56542` is dead → the user must re-run `pair` and paste again.**

That keeps `--direct` at "demoable" rather than "usable daily". plan/73's DoD was "a real browser pairs successfully", which **cannot catch a post-restart failure** — being green then was correct, it simply does not reach this case.

Minimum fix:
- a fixed default port (e.g. `4124`), precedence `--port` > `REMOTE_PI_PORT` > config > `4124`;
- **fail loudly when the port is taken**, never silently increment (a silent +1 makes bookmarks, tabs and stored sessions fail in ways that are far harder to diagnose than an error);
- write `~/.pi/remote/direct.json` with the actual port, delete on clean exit;
- in same-origin mode the client should dial `ws://${location.host}`, so a changed port follows the address bar by itself.

### 3.2 The embedded relay has no origin allowlist (security gap)

```
$ grep -c origin server/src/transport/embedded_relay.ts
0
```

The Rust version has `relay/src/origin.rs` (configurable allowlist, permissive when unset); the embedded one has **nothing**.

The chain: any web page can `new WebSocket("ws://127.0.0.1:56542")` → generate its own Ed25519 keypair and pass auth (auth only proves "this is a valid key", not "this caller is authorised") → the only remaining gate is the `pair_request` token.

**So the token is the single line of defence, and the origin check is the missing second one.** The moment §3.3's zero-click auto-pairing lands (no token to paste), that line disappears too — **the origin allowlist has to exist first.**

### 3.3 The server serves no static assets — therefore same-origin is impossible

`grep -rn "dist-shell\|static" server/src/` returns nothing. The web client is served by vite on `localhost:3010`; the embedded relay listens on `127.0.0.1:56542`.

Consequences:
- **Cross-origin.** It works today only because the embedded relay checks no origin. **Add the allowlist from §3.2 and the current dev setup breaks immediately** (`Origin: http://localhost:3010` is not in the list). These two changes have to ship together.
- `http://localhost` *is* a secure context (measured: `isSecureContext: true`, `crypto.subtle` present), so WebCrypto is fine — but **`http://192.168.x.x` is not**, `crypto.subtle` is `undefined`, and Ed25519 fails outright. That is a second reason to want one same-origin port.

Minimal same-origin implementation (~50 lines): an `http.createServer` inside `supervisord` — GET serves static files with an `index.html` SPA fallback, `upgrade` is handed to `EmbeddedRelay.wss.handleUpgrade`.

---

## 4. What actually deleting `relay/` costs

This section is not a deterrent; it is the accounting.

### 4.1 Permanently lost

| Capability | Why the server cannot replace it |
|---|---|
| **Cross-machine access** (phone / laptop outside the LAN → home machine) | Needs a publicly reachable address. The server is on a private network and the browser is not; with no relay there is no rendezvous point. The substitutes are Tailscale / Cloudflare Tunnel / port-forwarding + DDNS — **another piece of infrastructure**, not "removing the relay" |
| **Pi-to-Pi mesh across machines** (`pi_envelope`) | The embedded relay explicitly does not implement it (needs membership verification and storage) |
| **presence / multi-device discovery** | The web client does not send these frames today, but desktop/mobile might |
| **Decoupling from third-party availability** | The flip side: today a `relay.880160.xyz` wobble affects everyone (there are past 502/530 incidents). Removing it is a **net win** for single-machine users |

### 4.2 Desktop and mobile clients

`clients/desktop` and `clients/mobile` both speak the relay handshake (Gemini pointed at `relay_host_client_factory.dart` / `dependencies.dart`).

- Keeping `{peer, room, ct}` + the embedded relay (= today's `--direct`): **both clients need zero changes**, only a different address.
- Rewriting to bare WS with no envelope: **both clients change**, which is exactly plan/73's rejected option C (30+ actions all re-aligned).

### 4.3 The Electron shell already solved same-origin

`clients/shell` serves `clients/web/dist-shell` through an `app://app` scheme with a `protocol.handle` handler, registered as `standard/secure/corsEnabled` (`clients/shell/README.md`). In production it **can** simply `loadURL("http://127.0.0.1:4124")` and hand the same-origin problem to the server. So "the server serves static assets" is not a new concept in this repo.

---

## 5. Three routes and a recommendation

### Route A: keep the protocol + embedded relay, retire the Rust relay's default status (**recommended**)

Finish §3.1–3.3, make `--direct` the default, and `relay/` leaves the default path.

- Effort: **small** (three changes, ~100–150 lines + gates)
- Clients: web / desktop / mobile **all unchanged**
- Lost: cross-machine access, mesh (neither is used on one machine anyway)
- Risk: low (protocol unchanged, plan/73's tests and gates stay valid)

### Route B: delete the `relay/` directory as well

A, plus deleting the Rust relay code and its deployment. **No extra technical difficulty, but it permanently gives up cross-machine capability** — adding it back later means rewriting it.

- Effort: A + code/docs/CI deletion
- Recommendation: **do A first and keep `relay/` as optional infrastructure.** Deleting a repository is irreversible, and A already makes single-machine users independent of it.

### Route C: rewrite as bare WS, drop the `{peer, room, ct}` envelope

- Effort: **very large** (HostBridge, child IPC, all three clients)
- Benefit: a simpler wire
- My judgement: **not worth it.** The envelope's complexity is already absorbed on the client side, and a rewrite throws away everything plan/73 verified.

---

## 6. Suggested order of work

| # | Step | Acceptance |
|---|---|---|
| 1 | Fixed port + `direct.json` + a clear error when taken | Three restarts keep the same port; a taken port produces a readable error |
| 2 | Server serves static assets (same origin) | `http://127.0.0.1:4124` just works; WebSocket on the same port |
| 3 | Origin allowlist (**must ship with 2**) | Foreign origins get 403; `http://127.0.0.1:4124` passes |
| 4 | Local zero-click pairing (`/api/bootstrap` + `Sec-Fetch-Site` check) | First visit connects with no clicks; a foreign page gets 403 |
| 5 | `--direct` becomes the default, `--community-relay` an explicit opt-in | Default has zero public traffic; the explicit flag still reaches the public relay |

Step 3 cannot come after step 2: once same-origin exists, without an origin check **any** page served from `http://127.0.0.1:4124` (including injected third-party script) can connect.

---

## 7. Known limitations (recorded honestly)

1. **LAN IP access will break**: `http://192.168.x.x:4124` is not a secure context, `crypto.subtle` is unavailable and Ed25519 fails. Supporting LAN access needs HTTPS (and a self-signed cert cannot get a "proceed anyway" prompt on a WebSocket). This is a browser-spec constraint, not an implementation defect.
2. **Windows allows only one supervisor per user** (the named pipe name depends only on the username, `session/ipc.ts:45-48`). Multiple instances need `--home` isolation.
3. **This round's test environment was not fully restored**: after running supervisord with `--direct` and killing it, Windows held the named-pipe handle, so the default mode could not start for a while. Unrelated to this plan, but re-running gates requires waiting for the pipe to release or using `--home`.
4. **`grep -c origin` = 0 is the sole basis for §3.2**, and I did **not** build a cross-site attack in a real browser to prove exploitability. Under the rule that a claimed risk must be reproducible, this is marked as an **unreproduced security judgement**; a real PoC should precede implementation.

---

## 8. DoD

(This file is exploration and design and produces no implementation DoD. Implementation continues in plan/73, or in a new plan/77.)

- [x] Measured `--direct` end-to-end (real browser + real pairing code + zero public traffic)
- [x] Separated the relay's single-machine responsibilities from its cross-machine ones
- [x] Identified the three gaps plan/73 did not cover (random port / no origin check / not same-origin)
- [x] Priced the complete cost of deleting the relay, with three routes
- [ ] User decision: A, B, or C

---

## 9. Implementation record: eight real bugs (2026-10-27)

Every step of route A was blocked by a defect that only surfaced once the thing actually ran. Each one below was observed first, explained second.

### 9.1 A named SSE event never reaches `onmessage` (the dangerous one)

The server sends the connection id as `event: endpoint`. **A browser does not hand that to `onmessage`** — `onmessage` only receives unnamed events.

The chain: id stays `null` → POST without `?id=` → server 400 → client `catch {}` swallows it → **the UI says "connected" while every outbound frame vanishes**.

Real-browser counter-evidence: `sawOnmessageBeforeEndpoint: false`.

Fix: read the id with `addEventListener("endpoint", …)` and buffer pre-id frames in `preIdOutbox`.

> Self-test blind spot: a hand-written script that reads the stream with `fetch` sees every event, so **this bug cannot be caught from Node**.

### 9.2 Two tabs leak frames to each other

With a shared host keypair both tabs land in one `(peer, room)` routing bucket. The relay skips only the **sending socket**, so tabB received tabA's replies.

Measured `tabA:1 / tabB:2`. Fix: a distinct Ed25519 keypair per stream plus `authoriseLocalPeer`.

### 9.3 The "shared key + derived room" idea is swallowed by `_isOwnKeyInbound`

`host_bridge.ts:436` treats "`peer === ownPubkey` and `room !== host`" as a **child-daemon reply**. Any scheme that separates tabs by deriving a room therefore gets browser commands rerouted to the child as if they were IPC replies.

That is why 9.2 cannot be solved with "one identity, many rooms", and why phase two (§9.6) must replay the peer rewrite.

### 9.4 The envelope's `peer` is the destination, not the identity

The relay looks routes up by `(destPeer, destRoom)`. An empty `peer` yields `dest peer= room=host not found, dropping` — the frame is gone with no error at either end.

### 9.5 A fixed port stops concurrent tests from running

After pinning 4124, `direct.test.ts` fought the live `--direct` server for the port (5 failed).
Fix: `resolveDirectPort` accepts `port: 0` (`>= 0`, not `> 0`), and the tests all use `{ port: 0 }`.

### 9.6 Phase two's peer-rewrite trap

Injecting a browser frame straight into `_onLine` without performing the relay's rewrite — stamping `peer` with the sender's identity — makes every browser command hit §9.3's inference and be misread as a child reply.

Fix: set `peer = session.peerKey` before injecting.
Evidence: `grep -c "injected directly"` = 3 and `grep -c "relay rx.*workspace_list"` = **0**.

### 9.7 `fetch` does not throw on 4xx/5xx, so 409 was swallowed

`pump()` in `sse-transport.ts` only caught network failures. After a laptop slept past `SESSION_TTL_MS` (10 min) the server answered **409** (connection gone), `fetch` resolved normally, the frame was dropped, and the user's input vanished while the UI looked healthy.

Fix: inspect `res.status`; 409/404 → `emit("error",{type:"transport_gone"})` and close the stream so the client reconnects and re-syncs (**never blind-retry**, which would duplicate chat messages); `>= 500` → report only.

### 9.8 A bootstrap nonce must not be single-use

The first version stored nonces in a `Map` and deleted them on success. Two ordinary scenarios broke it immediately:

1. The browser keeps the last cookie it received; after a reload it presents a stale nonce → 403 until site data is cleared.
2. The process restarts → the map is empty → 403 again.

Fix: a **stateless HMAC-signed time bucket**, `"<bucket>.<hmac(key,bucket)>"`, accepting `current` through `current-2` (cookie `Max-Age=180` matches). A restart rotates the key and invalidates old nonces, which is the correct behaviour.

---

## 10. The security boundary of local zero-click pairing (recorded honestly)

`/api/bootstrap` demands **evidence of a same-origin page load** through three independent checks: a `SameSite=Strict` signed cookie, `Sec-Fetch-Site: same-origin`, and an `Origin` matching Host. Seven measured cases: no cookie / forged signature / stale bucket / cross-site / evil Origin all 403; only "cookie + same-origin" returns 200.

**It does not stop another OS account on the same machine**: they can equally load `http://127.0.0.1:4124/` and obtain the same-origin cookie. A browser scopes cookies by `(scheme, host, port)`, never by logged-in user, so it cannot present OS-level identity.

That is not a defect of this implementation but **a property of every loopback listener**. Distinguishing OS users genuinely would require a file ACL or an OS channel such as `SO_PEERCRED`, neither of which a browser exposes.

Practical mitigation: `--direct` explicitly does not support remote access, and every endpoint except `/healthz` sits behind the host/origin gate.

---

## 11. The two new gates and their injection proofs

| gate | Covers | Checks |
|---|---|---|
| `verify-web-local-auth.mjs` | Host / Origin / Sec-Fetch-Site each refusing independently, plus eight bootstrap cases | 9 |
| `verify-web-sse-transport.mjs` | Named-event handshake, real reply frame, multi-tab isolation, 409 reconnect signal | 10 |

Neither gate merely looks at a status code: the auth gate asserts the refusal REASON, and the transport gate asserts each tab receives **exactly** one reply (three when the identity is shared, which quantifies the leak).

**Injection proofs (one each, genuinely red)**

1. Deleting the `Sec-Fetch-Site` guard → `cross-site Fetch Metadata is refused by its own check: status 200`, 8/9; the Origin case stayed green, proving the two are independent.
2. Sharing the host keypair across streams → `tab A received exactly its own reply: 3 reply(ies)`, 8/10.

The `Sec-Fetch-Site` probe deliberately sends **no `Origin`**: otherwise the Origin check returns 403 first and hides "the fetch-site guard was deleted" behind a false green.
