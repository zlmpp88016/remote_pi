# Plan 75 — Session IA, switch latency, and the honest restart counter

Status: implemented
Supersedes parts of: none (extends `plan/72`, `plan/74`)

## 1. What the user reported

Four symptoms, reported together because they compound:

1. **Right-dock icons turn white on hover** — the Sessions/Files/Plan/Changes tabs
   became invisible exactly when pointed at.
2. **`Remote Pi · lei`** — an unexplained `lei` next to the product name.
3. **Switch gives no feedback**, then takes a very long time, looking like it was
   never implemented.
4. **`The host's supervisor restarted this workspace 38 times.`** — alarming, and
   produced by ordinary use.
5. **Every session row had the same title**, and the model picker's model names
   were invisible.

## 2. Root causes (measured, not inferred)

### 2.1 Session titles were the workspace folder name

```
$ node -e "... SessionManager.list('D:/模型测试/4.1f')"
count: 11
{"id":"01a14a9e","name":"4.1f","first":"创建一个HTML，内容是SVG的方式画一个鹈鹕骑车的"}
{"id":"01a0fb75","name":"4.1f","first":"在一个黑色的袋子里放有三种口味的糖果…"}
… all 11 rows: "name":"4.1f"
```

The host sends `name` straight from the SDK's `SessionManager.list()`. That field
is the **user-defined display name**, and in practice it holds the workspace
folder name — so all 11 rows rendered `4.1f`. The distinguishing text was already
in the payload as `firstMessage`.

### 2.2 The restart counter counted intentional recycles

`restartCount` is incremented by `noteRestart()` at three call sites:

| Site | Meaning |
|---|---|
| `EXIT_DAEMON_FRESH_SESSION` (`/new`) | deliberate |
| `EXIT_DAEMON_SWITCH_SESSION` (switch) | deliberate |
| crash backoff | failure |

Two of three were normal user actions, and the UI prints the number as a health
warning. Switching sessions a few dozen times produced "restarted 38 times".

### 2.3 Switching is genuinely expensive, and had zero feedback

In daemon mode there is no in-process `switchSession`. The handler:

```
stagePendingSwitchTarget(path) → ack → process.exit(EXIT_DAEMON_SWITCH_SESSION)
  → supervisor respawns pi with --session <path> → client re-handshakes
```

That is a process restart per switch. Compounding it, `.switchButton:hover` set
the **same background colour as the resting state**, so the button appeared dead
even before the wait started.

### 2.4 White-on-light hover colours, invisible to the static audit

`.railTabButton:hover { color: var(--color-white) }` against a light wash
(`--dsw-alias-interactive-bg-hover`). The resting-state audit cannot see hover
styles, so 12 such declarations survived the `plan/74` sweep. Same class of bug
hid the model picker's `.rowName`.

### 2.5 `lei` was `host.hostname`

`remote-pi-shell.tsx` rendered `Remote Pi · {host.hostname}`. The host machine is
called `lei`.

## 3. Two external reviews, and what they changed

Consulted **step-5-preview** and **gpt-6.1-sol** in parallel (grok-4.6 was
requested but is not reachable — `503 model_not_found`). Both were given the same
measured facts and neither had repo access, so their conclusions are design
judgement checked by me against the code.

**They converged independently on the same verdict:** the failure is a
*wrong-primitive* problem, not a speed problem.

> "Today, 'let me look at that conversation' effectively means 'terminate and
> recreate the agent runtime.'" — gpt-6.1-sol

> "A 5-second operation with a legible progress narrative is acceptable; a
> 5-second operation behind a dead button is a bug report." — step-5-preview

step-5-preview added the sharper point: the UI implied 11 live sessions while the
architecture has **one**; the rest are files on disk. Much of the "not
implemented" feeling came from that mismatch.

**What I verified before acting:** `handleSessionRead` reads the file via
`readPage(target.path)` and never touches the child process. So the cheap
read-only path the models recommended **already existed** — the list row was
already wired to `onRead`. The actual defect was that a second, expensive
`switch` button sat on every row inviting a stray click.

## 4. Changes

### 4.1 Titles derive from the session, not the folder

`clients/web/src/lib/remote-pi/sessions.ts` — `sessionLabel()` now:

1. uses `name` **only when it is a real display name** (not equal to the cwd's
   last path segment, POSIX or Windows),
2. otherwise uses the whitespace-collapsed `firstMessage`, truncated to 64 chars,
3. otherwise the short id prefix.

Rows also show `shortSessionId · relativeTime`, so sessions that genuinely share
an opening prompt (several do here) are still distinguishable. The row's second
line is suppressed when it would just repeat the title.

The session viewer's banner now calls the same `sessionLabel`, so the list and
the viewer cannot disagree.

### 4.2 The reset button

The per-row `switch` control is **removed**. Resuming execution now happens in one
place: the session viewer's button, relabelled **Resume here**, with a live
elapsed counter (`Resuming… 4s`) because a spinner proves nothing about liveness.

`onSwitch` / `canSwitch` were deleted from `SessionList` and `RightRail` all the
way up to `connect-client.tsx` rather than left as dead props.

### 4.3 The restart counter separates crashes from recycles

`rpc_child.ts` gained `noteRecycle()` beside `noteRestart()`; the two deliberate
exit codes call `noteRecycle()` and no longer touch `restartCount`. The
supervisor still pushes `restarts: child.restartCount`, which now means what the
banner says.

`supervisor_69.test.ts` asserted the *old* behaviour (`restarts` climbing to 2
after a `/new`). That assertion was encoding the bug, so it was updated to expect
the counter to hold at 1 — with a comment naming the regression.

### 4.4 Hover colours, and a gate that can see them

All 16 `color: var(--color-white)` declarations on light surfaces across 13 files
became `--dsw-alias-label-primary`. Two new gates:

- `verify-web-contrast-rail-hover.mjs` — asserts no white text declaration on the
  light theme **and** grades the sanctioned hover colours against the real wash
  (`label-primary` 16.99:1, `label-secondary` 5.21:1).
- `verify-session-labels.mjs` — 12 checks over the real measured row shapes.

Both joined `run-web-checks` (18 → 20 runners), with the drift guard extended to
admit the non-`verify-web-*` name.

### 4.5 `lei` removed

The `.machine` span and its `·` separator are gone from the titlebar; only
`Remote Pi` remains. `host.hostname` is still used where it carries real meaning
(the unpair confirmation), so no unused variable was left behind.

## 5. Verification

```
audit-contrast: OK (0 <= allowed 0) at AA 4.5:1
web-contrast-states: OK (4 states at AA 4.5:1)
web-contrast-selection: OK
error-state: OK (4 elements at AA 4.5:1)
web-contrast-tokens: OK
web-contrast-rail-hover: OK (13 files, 2 hover colours)
web-contrast-hover: OK
verify-session-labels: OK (12 checks)
23/23 runners OK
11/11 rows verified
tsc: web 0 / server 0
eslint: 110 problems (0 errors, 110 warnings)
server: 19 files, 377 passed, 1 skipped (session + actions)
```

Two gates are deliberately **not** in the default suite: `verify-web-resume-chat`
and `verify-web-new-session` resume a real session, which swaps the host's live
session and respawns it. They pass individually and in `--live` mode, but they
fight over one piece of shared host state when interleaved with each other, so
running them in the fast suite produced interference failures rather than signal.

```
node scripts/run-web-checks.mjs          # 23/23 fast
node scripts/run-respawn-gates.mjs       # 6/6, the gates that restart the host
```

Why they are a separate runner, measured rather than assumed: `session_switch`
and `session_new` make the host exit and come back, and on this machine that is
45s to a usable composer and **~4 minutes** to a full session list. Run
back-to-back, each gate started while the previous respawn was still finishing
and failed on its own precondition (`no session rows`, `turns=0`) instead of on a
defect — and the failing set moved between runs, which reads as regressions in
gates nothing had changed. `run-respawn-gates.mjs` waits for a mature host before
and after each one; the fast suite stays fast by not knowing about them.

Rows, before and after (real host data):

```
before: 4.1f / 4.1f / 4.1f / 4.1f / 4.1f / 4.1f / 4.1f / 4.1f
after:  创建一个HTML，内容是SVG的方式画一个鹈鹕骑车的动画   01a14a9e · 29m ago
        在一个黑色的袋子里放有三种口味的糖果…             01a0fb75 · 1d ago
        resume                                          01a149b7 · 6d ago
```

Model picker rows: `color: rgb(15,17,21)` (18.9:1); previously white.

Injection checks: restoring the folder-name branch made
`verify-session-labels` fail with `folder name is not used as the title (got
"4.1f")`; restoring one white hover colour made the hover gate report 4
declarations. Both reverted to green.

## 6. Why you still saw 42

After the fix was merged the number did not disappear, for two stacking reasons:

1. **The counter is process memory.** Fixing the code stops it growing; the
   number already accumulated only returns to zero after a child respawn.
2. **The running supervisord was an old image.** Node loads JS into memory at
   startup, so editing `dist` changes nothing for a live process. Measured:

```
fixed build        dist/daemon/supervisor.js   2026-10-24 15:40
dist is new code:  683 noteRecycle / 695 noteRecycle / 712 noteRestart
running process    pid 41196                    created 2026-10-23 15:17  <- predates the fix
```

So the "42" was one day of accumulation in an old process, including a lot of
ordinary switching.

**Verification, before and after restarting the host:**

```
old process:                     a44ccb97  pid=81036   restarts=42
child restarted (old parent):              pid=11780   restarts=0
1 real switch  (old parent):               pid=99160   restarts=1   <- still climbing
```

Killed the old parent (pid 41196) and started the new build (pid 124416,
created 10-24 16:30):

```
after restart:                             pid=95384   restarts=0
1 real switch (into `resume`):             pid=95384   restarts=0   <- no respawn, no count
3 more switches:                           pid=123152  restarts=0   <- pid changed, still not counted
```

That last line is the point: the process really did respawn, and the counter
still did not move. Only crashes increment it now.

## 7. The workspace-owner claim error, measured

`supervisord.log` carries this error:

```
[ERROR] [pi-maestro-teammate] workspace peer runtime failed:
  Workspace owner claim is already held by a live generation
  at pi-maestro-teammate/src/sessions/workspace-peer-core.ts:2081
```

**This section previously claimed it "does make that Pi child exit, which
legitimately increments the crash counter". That was wrong**, and it was wrong
because it was inferred from an old log rather than measured. What was actually
measured:

```
18:48:50.995Z  claim error (1 occurrence, at supervisord startup)
              ↓
restart #1 → restarts=0
restart #2 → restarts=0
restart #3 → restarts=0
              pid changes each time (so the restarts really happened)
```

The Pi child does **not** exit. `claimWorkspaceOwnerIdentity` rejects the
`workspacePeerLifecycle` promise, which disables the teammate's workspace-peer
surface (cross-session messaging, workspace coordination) for that process and
leaves the Pi main loop untouched. remote-pi's `restartCount` is not affected in
any way.

Why it fires at all (mechanism, from `workspace-peer-core.ts`):

- The claim is a **file plus a heartbeat file**. A claim is considered dead only
  when `|observedAt - heartbeatAt| > staleMs` (`DEFAULT_PEER_STALE_MS = 20_000`).
- The machine has **282** heartbeat files under `pi-maestro-teammate/workspaces`,
  of which exactly **1** is still being refreshed. That one belongs to another
  live Pi on the same workspace.
- A newly started Pi therefore hits the claim inside its 20 s liveness window and
  is refused. It is a startup race between two live generations, not a zombie
  claim.

Disposition: this is the plugin's design (one owner per workspace), not a
remote-pi defect, and it costs nothing here — the affected surface is the
plugin's own, and the crash counter is untouched. Recorded with measurements so
it is no longer re-investigated on the strength of a log line.

## 7b. "Clicking Sessions does nothing" — the real cause

Reported after the first round of fixes. The read was *not* failing:
`handleSessionRead` ran, the frame went out, the host answered. The defect was
**ordering**: the viewer mounted only from `applyRead`, which runs when
`session_read_ok` arrives.

```
click → handleSessionRead → setSessionReadLoading(true)   <- nothing renders this
                    … wait for reply …
                        → applyRead → viewer mounts          <- first visible change
```

So for the whole wait the click changed nothing on screen: no spinner, no
banner, no selection. And when the room had dropped, the wait never ended, so
the button was permanently dead. `setSessionReadLoading(true)` was a flag with
no consumer, because the component that reads it did not exist yet.

Fix: `beginRead(sessionId)` in the store mounts the viewer at click time with
empty events and `loading: true`. The reply then fills it in. Measured: viewer
mounts at **+12ms** and shows `Reading this session…`.

Gate: `verify-web-session-click-feedback.mjs` asserts the mount happens within
150ms — a budget no network round-trip can meet, so passing proves the mount is
local rather than waiting on the host. Injection (removing `beginRead`) fails
with `the viewer must mount after clicking a session row`.

**Separately, the host room can go silent.** Twice during this session the host
process was alive and `restarts=0`, yet every request (including `session_list`)
got no reply until the daemon was restarted and the page reloaded. That is a
transport-level stall, not a UI defect: the 11 rows already on screen were cached
state, which is why the list looked fine while nothing responded. Restarting the
daemon (`remote-pi-server daemon restart a44ccb97`) and reloading restores it.
This is not fixed here — it needs investigation on the relay/room side.

## 7c. "Resume here" — three defects, and the one that mattered

Reported twice, the second time with the exact sequence: *no reaction at all,
long silence, then the counter finally starts, then it waits forever.* Each part
was a separate bug.

### 1. No reaction: the flag lived in a ref

```tsx
switchBusy: sessionSwitchReqRef.current !== null,   // never re-renders
```

Mutating a ref does not re-render React. The button therefore changed nothing on
click and only picked up the busy state when some unrelated state change happened
to repaint — which is precisely "no reaction, then seconds later it starts
counting". Fixed with a render-safe `switchLoading` state in the session store.
Measured: pending state now visible at **+2ms**.

### 2. Endless wait: nothing timed out a switch

The read path has had a request timeout from the start; `session_switch` had
none. A lost reply (the host exits for its respawn before answering, or the room
drops in that gap) left the button on "Resuming…" forever. Now guarded with the
same ref-identity pattern as chat and read, so a late timeout is a no-op when the
reply did arrive.

### 3. Empty after resuming: the history was deleted and never restored

`session_switch_ok` called `clearViewer()`, wiping the transcript that had just
been read **from that exact session file**, and nothing put it back — the chat
reducer has no "hydrate from file" action at all. So resuming a session with 11
events of history produced a blank new conversation.

The first attempt was `rereadResumed()`: keep the viewer, then re-read from disk
with retries across the respawn window. That was the wrong primitive, and it had
to be withdrawn — see §7d, which supersedes this section.

### 4. The composer was not in the DOM at all

Keeping the viewer alive after a resume is not a cosmetic choice: `TranscriptPanel`
renders **either** the viewer **or** the transcript + composer. The two are
mutually exclusive. So "keep the viewer so the user can still read the history"
necessarily meant "the user cannot reply" — measured directly:

```
hasTextarea: false, sendFound: false
```

That is why the re-read approach was dropped. After a resume the viewer must be
closed and the history handed to the live transcript; the transcript is what owns
the composer.

Gate: `verify-web-resume-chat.mjs` requires `hasComposer && !hasViewer` within
120s of the click.

### 5. A late `session_read_ok` could resurrect the viewer over the composer

Found by that gate, on a run where the user clicked a row and pressed Resume here
before the read reply landed. The late reply matched `sessionReadReqRef` and called
`openViewer` — re-opening the read-only pane *after* the resume had closed it, and
so burying the composer again. The session is live by then, so the pending read is
stale by definition; `handleSessionSwitch` now clears `sessionReadReqRef` before
sending, which makes the late reply fail the correlation check and get ignored.

## 7d. The live transcript was never hydratable — the transport threw it away

This is the root cause behind both reported symptoms, and it survived two rounds
of fixes because every layer looked correct in isolation.

The chain is: the client asks for the transcript with `session_sync`, and the host
answers with a `session_history` frame. Neither half existed. Added both — a
`SessionHistoryFrame` type, `hydrateTurns()`, a `hydrate` reducer action,
`sendSessionSync`, `adapter.syncSession`, and `resyncLive()` to retry across the
respawn window.

It still showed zero turns. Instrumenting the reducer proved the frames really
were arriving with content:

```
hydrate calls: [{ n: 33, turns: 3, room: "pEzLl5UwVVKF" }]
```

33 events in, 3 turns out, room correctly identified — and yet the transcript was
blank. The reducer was never reached, because the frame was dropped **before**
it. Two places, same mistake:

```ts
// client.ts — host-room path
if (msg.type === "session_history") { this.roomOfRememberedSync(msg); this.emitMessage(msg, HOST_ROOM); return; }

// client.ts — proxied child-room path (the live one, in practice)
this.emitMessage(inner, room);
```

The frame carries the `in_reply_to` of the `session_sync` that asked for it, so
the transport classified it as an RPC **reply** and looked up a pending entry.
But `_forwardToRoom` registers no pending entry — those calls are fire-and-forget
room writes — so the lookup failed and the frame was diagnosed `unknown_reply`
and discarded. Every retry was answered and thrown away identically, which is why
retrying harder never helped.

Two things were needed:

1. `session_history` must be treated as a **fan-out**, not a reply, and emitted
   regardless of `in_reply_to`. Done in `onHostFrame`.
2. The proxied path files frames by room, so it needed to know which room the
   sync was addressed to. `syncRooms` (id → room, bounded to 64, cleared on
   close) records it in `sendSessionSync` and `roomOfRememberedSync` consumes it.

Measured, real browser:

```
before: turns 0, "no turns yet"
after +6s: turns 3, empty false
```

The first sync is now also sent when the room opens, so a fresh page load
hydrates the live transcript without the user doing anything.

### Why the first injection attempts "passed"

Worth recording, because it nearly produced a fake gate. Injecting a drop into
the host-room path alone still passed: the live traffic goes over the **proxied
child-room** path. Injecting into `proxyRoomFor`'s `sent !== null` branch also
still passed: the room was already known, so it reached the ordinary
`emitMessage(inner, room)` line instead. Only injecting at that third site
reproduced the blank transcript. A gate is not verified until the injection
actually fails it.

## 7e. "New session changes nothing" — clearing an already-empty pane

`session_new` was never broken. Traced end to end, the host answers `action_ok`,
exits for its respawn, comes back `running`, and fans out a fresh
`session_history`:

```
ws_state: crashed → ws_state: running
inner: action_ok session_new
inner: session_history
```

What made it look inert was §7d: the live transcript was **always** empty, because
its history had been thrown away. Clearing an empty pane produces no visible
change — the click is indistinguishable from a dead button.

Once the transcript hydrates, New session behaves as it should:

```
transcript has content before the click (3 turns)
button showed it was starting after 4ms ("New session — starting…")
transcript became a fresh session after 3047ms
```

Gate: `verify-web-new-session.mjs`. It asserts the transcript is non-empty
**first**, so a permanently blank pane cannot make the "cleared" assertion
vacuous — which is exactly the shape of the bug that shipped. Injection (dropping
`setSessionsBusy(true)`) fails with `clicking New session produced no busy state
within 1000ms`.

### DSH's semantics, for reference

Read layer by layer rather than inferred from button behaviour. The call chain is
`startSession()` → `openWorkspaceSession()` → `connectBlank()` → `sessions.create()`
→ `replaceMain(sessionId, …, 'reveal')`.

**Behaviour list:**

| Question | DSH's behaviour | Source |
|---|---|---|
| When is the session created? | **Immediately on click.** `sessions.create({workspaceId})` returns a `SessionId` synchronously, without waiting for any model or host turn | `navigation.ts:209`, `service.ts:434` |
| Does the screen clear? | Yes, and **locally and immediately** — `replaceMain(sessionId, …, 'reveal')` runs as soon as `create` resolves | `navigation.ts:304` |
| With no usable workspace? | `clearMain()` — it still leaves the current session rather than staying put | `navigation.ts:340` |
| How is the target chosen? | `explicit workspaceId → current session's workspace → most recent workspace`; only when none resolve does it `clearMain()` | `navigation.ts:331-341` |
| Composer? | The new session owns its own composer at once; a draft can optionally be initialised (`options.prompt` / `clearPreviousDraft`) | `navigation.ts:321-326` |
| Title? | Not produced here — the session has no title yet and is named after its first message. Only `fork` inherits via `increaseTitle` | `service.ts:465-466` |
| Shortcut? | **Ctrl+N**, advertised through `aria-keyshortcuts`, with a `<kbd>` in the tooltip | `ui-sidebar` test `sidebar-root.client.spec.tsx:105` |
| How many entry points? | Two (brand capsule + wordmark), both calling the same `startSession` | same file `:126-134` |

**Equivalent semantics we should hold:**

1. A click must be **visible immediately**, not after a host round trip. We already
   meet this: the button flips to `New session — starting…` in **4ms** and the
   transcript is empty within **3047ms**. The difference is that DSH's swap is a
   local state change (instant) while ours is a consequence of the host respawn.
   For us the respawn is an architectural fact — a genuinely fresh session needs a
   new Pi process — so ~3s is an acceptable floor, but the **button feedback must
   be instant**, or the click reads as lost.
2. We keep the "no workspace, no button" branch (`sidebarNewSession === undefined`).
   That differs from DSH's `clearMain()`, but our host action needs a cwd, so it is
   a justified divergence rather than an oversight.
3. Our titles derive from `firstMessage` (§4), which matches DSH's "not named at
   creation time".

**Real gaps (tracked in §9):**

- No **Ctrl+N** and no `aria-keyshortcuts`. Purely additive; it changes no
  existing semantics.
- No **second entry point**. DSH opens a new session from both the capsule and the
  wordmark; we only have the sidebar row.
- No draft initialisation (`options.prompt`). Not needed, because we have no
  "start a new session with a pre-filled prompt" surface.

## 7f. Two host-side defects the gates forced out

Both were found while making `verify-web-resume-chat` reliable, and neither was
visible from the UI's own behaviour — the client was asking correctly and the
host was answering with nothing.

### 1. `session_list` / `session_read` needed a ctx that a fresh daemon never has

```ts
const cwd = ctx?.cwd;
if (!cwd) { send action_error("cwd unavailable (no session ctx)"); return; }
```

`ctx` is captured from a command or a live event. A daemon child that has just
respawned has run neither, so **the entire session panel was dead until the user
happened to run a turn** — list and read both. That is precisely the moment a
user reaches for Resume, so it read as "the feature is broken after every restart".

A daemon child is spawned with the workspace as its working directory
(`rpc_child.ts`: `spawn(..., { cwd: this.opts.cwd })`), so `process.cwd()` is that
workspace. `resolveActionCwd()` now falls back to it — daemon-only, so an
interactive session still uses its own ctx.

### 2. Reading an older session applied the LIVE session's branch filter

```ts
const leafId = _leafIdFromCtx();            // live session's leaf
const entryIds = leafId ? activeBranchEntryIds(sessionFile, leafId) : undefined;
```

Branch filtering keeps abandoned-branch messages out of a transcript, which is
right when the file IS the live session's file. Applied to any other session the
live leaf does not exist in that file, so the branch resolved to nothing and
`entries.length === 0` became `null` — an empty transcript with no error shown.

```ts
const liveFile = _sessionFileFromCtx();
const leafId = liveFile !== null && liveFile === sessionFile ? _leafIdFromCtx() : null;
```

### 3. A failed switch left the read-only viewer mounted forever

The composer lives inside the live transcript, and the viewer replaces it. So a
`session_switch` that never answered (timeout) left the viewer up and the
composer out of the DOM — the user could neither type nor get back without a
reload. `clearViewer()` now also runs on the timeout path.

### What made these hard to see

A gate that measures the WRONG thing hides exactly this class of defect.
`verify-web-resume-feedback` asserted `document.body.innerText.length > 5000` to
mean "the viewer has content". The viewer renders into its own container, so a
fully loaded 33-event transcript measured ~2.3k while an empty one measured
~2.1k: the threshold could never be met, and the gate failed on every row while
the viewer was rendering perfectly. Measuring the viewer's own section, and
requiring a rendered element rather than a character count, fixed it.

## 7g. Why "Resume here" takes ~2.5s to a composer and ~18s to the LIVE badge

Reported as "30s before the composer appears, then another 10s+ before the row turns
live, on a purely local interaction". Measured with a real browser + real host,
stamping each phase:

```
Resume here → composer present:  2.4s / 3.4s / 2.4s / 2.4s
Resume here → LIVE badge moved: 17.9s / 21.9s / 18.0s / 15.6s
```

So the report was two different latencies, and only one of them was a defect.

### The composer's ~2.5s is the cost of the switch, not a wait

`session_switch` in daemon mode answers IMMEDIATELY and then exits ~150ms later:

```ts
stagePendingSwitchTarget(target.path);
sender.send({ type: "session_switch_ok", ... });
setTimeout(() => process.exit(EXIT_DAEMON_SWITCH_SESSION), 150);
```

`connect-client` closes the viewer on that ACK, which puts the composer back in the
DOM. So the composer does NOT wait for the respawn — it appears as soon as one
round trip completes. That round trip is relay + `SessionManager.list` (measured
**150ms** locally for 11 sessions), so ~2.5s is the honest cost of a full relay
round trip plus render, not a stall.

### The ~18s LIVE badge WAS a defect — a wasted timeout window

`relistAfterSwitch` re-lists until the list actually changes. Its first request
went out on `session_switch_ok` — the exact moment the child begins exiting to
respawn. That request was therefore **guaranteed to be lost**, and it then held
`sessionsReqRef` for the whole list timeout. Every retry in between returned at the
in-flight guard:

```ts
if (sessionsReqRef.current !== null) return false;   // silent no-op
```

With the old `SESSIONS_LIST_TIMEOUT_MS = 10_000`, that was ONE wasted 10s window
before a retry could even be sent. Measured 16.4s originally.

Two changes, both small:

1. `SWITCH_RESPAWN_GRACE_MS = 600` — delay the first re-list past the known exit
   window, so it has a chance of being answered instead of knowingly wasted.
2. `SESSIONS_LIST_TIMEOUT_MS` 10s → **2.5s**. A list reads session files
   (150ms measured) and crosses the relay (~0.5s); 10s was 20x the real cost and
   every wasted window was paid in user-visible delay.

Retry cadence verified from the relay log afterwards: requests arrive ~800ms apart
(16 log lines), i.e. the loop is actually retrying rather than spinning on the
guard.

### What still remains, and why it is not fixable on the client

After the two changes the badge still takes 15–18s in the worst case, because the
host genuinely is not answering that long. The relay log of ONE switch shows the
shape:

```
type=session_switch_ok          ← ACK
type=session_list               ← request 1 (host exiting)
type=session_list               ← request 2
type=session_list               ← request 3
type=session_list               ← request 4
type=session_list               ← request 5
[4.1f] relay rx session_list    ← the child finally receives one
type=session_list_ok
```

Five requests were consumed by the respawn window. `supervisor.ts:747-756` calls
`slot.child.spawn()` immediately with no backoff, so the whole cost is process
startup: **the SDK import alone measured 2.4s cold**, before session replay, relay
reconnect and auth. The client cannot shorten that; it can only stop paying
EXTRA time on top of it (which the two changes do).

Flattening the remaining 15s would mean not restarting a process to open a file —
a real architectural change (in-process `switchSession` instead of
spawn-with-`--session`), recorded in §9 rather than attempted here.

### The false lead worth recording

`SessionManager.list(cwd)` looked like the obvious culprit (a full scan on every
switch). Measured directly: **150ms, 11 rows**, three times in a row. Costing the
suspicious thing before "fixing" it saved a pointless optimisation — and pointed
the investigation at the retry loop instead.

## 7h. "Could not load this workspace's sessions. Press refresh to retry."

This is the sentence the user reported, and it was a real defect — not a message
problem. The panel renders it when the list is EMPTY and a notice is set:

```tsx
{sessions.length === 0 ? (
  <p>{notice !== null
    ? "Could not load this workspace's sessions. Press refresh to retry."
    : busy ? "Asking the host…" : "No sessions in this workspace yet."}</p>
)}
```

So the question is why a notice was set while the host was healthy enough to
answer a moment later.

### The cause: one timeout, then permanent surrender

`requestSessions` set the notice on the FIRST `session_list` timeout and then
stopped. Nothing retried. A workspace Pi takes ~15s to respawn (SDK import alone
is 2.4s cold, §7g), and during that window `session_list` is simply unanswered —
so the very first timeout was guaranteed and the message became permanent.

Measured A/B on the identical scenario (fresh page against a starting host, no
refresh clicks at all):

```
SESSIONS_RETRY_BUDGET = 0   → err=true for 70+s straight, rows stayed 0
SESSIONS_RETRY_BUDGET = 8   → recovered at +9s / +17s, err NEVER shown
```

That is the user's report reproduced and then fixed.

### The fix

A timed-out list request now retries itself from a bounded budget, and the notice
stays clear while retries remain — so the panel keeps saying "Asking…" (which is
true) instead of claiming the history is gone (which is not). Only an exhausted
budget surfaces the failure.

```ts
if (sessionsRetryLeftRef.current > 0) {
  sessionsRetryLeftRef.current -= 1;
  setTimeout(() => requestSessionsRef.current(undefined, true), SESSIONS_RELIST_MS);
  return;                       // notice stays clear
}
setSessionsNotice(SESSIONS_FAILED);   // only after the budget is spent
```

### The bug inside the fix, caught by measuring it

First version refilled the budget on every call, including retries — so the
counter could never reach zero and the failure sentence never appeared at all.
The panel sat on "Asking…" forever with `asking=false` and nothing on screen.
Found by injecting `SESSIONS_RETRY_BUDGET = 3` and watching for the failure that
should have arrived: it never did. `isRetry` now distinguishes the timeout path
from a user-initiated request, and only the latter refills.

Both directions are injection-verified in `verify-web-sessions-warmup`:
`BUDGET = 0` must produce the reported sentence, `BUDGET = 8` must not.

## 7i. "Resume here" → the history takes ~15s, and the wait LIED about it

The user's report was specific: open session `01a1499d`, press **Resume here**, and
wait over a minute for the history. Earlier work in this plan measured the composer
mounting and the LIVE badge moving — neither is what the user waits for. Measuring
the TRANSCRIPT is what exposed both problems below.

### Where the time actually goes (measured, same timeline)

```
Resume here pressed
  +1s   HOST RESTARTED (pid 36612 → 136844)
  +15s  history visible (8 rows)

time AFTER the restart until history: 14s
```

Repeated across trials: **15s, 16s, 17s, 16s, 15s**. So the delay is not a stuck
request and not the retry cadence — it is the respawn itself. A `session_switch` in
daemon mode stages the target file and exits, and `supervisor.ts:747-756` respawns
with `--session <path>` and no backoff:

```ts
if (evt.code === EXIT_DAEMON_SWITCH_SESSION) {
  slot.child.spawn();          // new PID, new process, no reuse
```

Cost of a cold start, measured directly: **SDK import alone is 2.3s** (2.295 / 2.237 /
2.270), before replaying a 464KB session file, reconnecting the relay and
completing the handshake.

### The defect that WAS fixable: the wait displayed a lie

For those 14 seconds the transcript rendered the generic empty state:

> **What should the agent work on?**
> This workspace has no turns yet. Pick a workspace on the left…

Right after the user asked to see that session's history, the app told them the
workspace had no turns. That is worse than being slow — it reads as "your history
is gone".

The cause was a flag mismatch: the panel keyed the reopening state off
`switchLoading`, which is cleared the moment `session_switch_ok` arrives — and that
ACK is sent BEFORE the child exits (`setTimeout(() => process.exit(…), 150)`). So
the flag covered almost none of the actual window.

Fixed with a dedicated `resumingSession` state owned by `resyncLive`, which stays
set from the ACK until the transcript is genuinely hydrated:

```tsx
) : resuming ? (
  <EmptyState
    icon="cpu"
    title="Reopening this session…"
    detail="The workspace's Pi is restarting to open this session. Its history
            appears here as soon as it is back — nothing was lost."
  />
) : (
```

Measured before and after, on the same session:

```
before:  +3s FALSE EMPTY STATE, persisting until +16s
         ("What should the agent work on?")
after:   +3s "Reopening this session…", history at +16s, false empty state never
```

Injection-verified: forcing `resuming: false` makes the gate fail with the false
empty state at +3s for 13 straight seconds.

### What is NOT fixed, and why

The 14s of process startup is still there. Removing it means opening a session file
WITHOUT restarting the Pi, which the daemon cannot do today: `switchSession` lives
on `ExtensionCommandContext` (SDK `types.d.ts`), and an RPC-mode child never
captures one — that constraint is the documented reason this path respawns. The
SDK does expose `AgentSessionRuntime.switchSession(sessionPath)`, so an in-process
swap may be reachable, but it is an architecture change (session state machine +
extension lifecycle), not a tuning knob, and it is recorded in §9 rather than
attempted here.

## 7j. A gate was writing test messages into the user's real sessions

`verify-web-draft-per-session` checks two things: a draft survives a session
change, and it clears on a successful send. To check the second it clicked submit
for real, which sent `draft-survives-switch-<timestamp>` into whatever session was
live at the time.

Those strings ended up in the user's transcript and in the Pi's context, and the
gate had been added to the respawn suite — so every future run would have added
more.

### The fix: block the frame, keep the code path

The gate now installs an interceptor before the page loads and swallows only the
chat frame:

```js
if (inner2.indexOf('"user_message"') >= 0) { window.__blockedSends.push(...); return; }
```

`handleSend` still runs in full — including `setDraft("")` — so the assertion keeps
its meaning, while nothing leaves the browser. The gate also asserts that a frame
WAS intercepted, because a draft that merely cleared itself would otherwise pass
for the wrong reason:

```
OK: the draft clears after a successful send (1 send_chat frame(s) blocked at the socket)
```

Verified by counting markers in the session files before and after two runs: three
before, three after, no new writes. Injection (removing `setDraft("")`) still fails
the gate.

### Two things this cost, recorded honestly

- The wire type for a chat message is `user_message`, not `send_chat` (that is the
  adapter method name). Matching the wrong string silently defeated the first
  version of the interceptor.
- Probing the frame shape for that fix sent one more real message
  (`probe-frame-shape`) before the interceptor existed. Test instrumentation must
  not use the live channel to discover the protocol.

## 7k. Usage, speed and cache statistics in the transcript

The user asked for DeepSeek Harness' statistics UI, backed by REAL numbers rather
than an empty shell. The numbers already existed — they were simply dropped before
they reached the client.

### The data was there, one layer down

The SDK reports full accounting on every assistant message:

```json
{"input":32634,"output":210,"cacheRead":4608,"cacheWrite":0,
 "reasoning":125,"totalTokens":37452,"cost":{…}}
```

Verified by reading a real session file directly. But `server/src/session/history.ts`
kept only two fields:

```ts
// before
return { input_tokens: usage.input, output_tokens: usage.output };
```

The cache share was destroyed in the mapper. No amount of client work could have
recovered it — which is why the first attempt (patching the OTHER usage site in
`index.ts`) produced pills that rendered but always read `缓存命中 0%`.

Fixed at the source: `Usage` now carries `cache_read_tokens`,
`cache_write_tokens`, `reasoning_tokens` and `total_tokens`, and both the history
mapper and the live `agent_done` cache carry them through.

### Why the live path also needed work

`agent_done` is emitted from `agent_end`, where the message that owns the usage is
already out of scope. A `_lastTurnUsage` cache filled on `message_end` lets the
live turn carry real accounting too — without it, only a re-read from disk ever
showed numbers, so a streaming turn looked broken at exactly the moment the user
was watching it.

### Decode speed is not wall-clock throughput

First implementation divided output tokens by the turn's total elapsed time and
reported **17 tok/s** for a session whose model decoded at hundreds. The elapsed
time includes tool execution, queueing and thinking.

DSH makes the same distinction (`decodeMs`/`decodeTokens`). Using the span between
the turn's first and last assistant message gives **121 tok/s** on the same data —
and a turn whose reply arrived as a single message has no span, so the speed is
omitted instead of reported as infinite.

### What was built

| Piece | Source file | Reading |
|---|---|---|
| Composer dock | `stats-pills.tsx` | `9 轮 9 步 · 121 tok/s` · `462K tok · 缓存命中 97%` |
| Turn divider | `turn-divider.tsx` | `已完成，用时 3秒` with a 0.5px rule |
| Message footer | `message-footer.tsx` | `51.4K tok` · `02:34` · copy |

Styles are copied from DSH: the divider uses `border-bottom: 0.5px solid
var(--dsw-alias-border-l2)`, 33px height, tertiary label, rotating chevron, and
`color 100ms ease` on hover — the same tokens this product already ships.

**Nothing renders a zero.** A reading the host did not send is absent, not `0`:
that distinction is what separates a real dashboard from a placeholder, and it is
also what makes the injection test meaningful.

### Gate

`verify-web-usage-stats.mjs` asserts non-zero counts, a non-zero speed, a non-zero
token total, a non-zero cache share, at least one duration-carrying divider, and a
`HH:mm` clock in the footer.

```
OK: activity pill reports turns/steps: 9 轮 9 步 · 121 tok/s
OK: decode speed is a real number: 121 tok/s
OK: usage pill reports a token total: 462K tok
OK: cache-hit share is a real percentage: 97%
OK: 9 message footers show a token total (51.4K tok)
OK: 9 message footers show a clock (21:25)
RESULT: PASS
```

Injection: zeroing `cacheReadTokens` makes it fail with
`the cache-hit share is not a real reading (0%)`, and the total simultaneously
collapses 462K → 28.1K — proof that the cache really is most of the number.

### The dock must follow the INPUT's width, not the column's

The pills initially stretched to `composerPad` while the composer centres itself
at `min(860px, 100%)`. At 1600px that put the readings at the column's left edge
while the input sat 482px in — the readings visibly floated away as the window
widened.

Fixed by wrapping them in `.composerDock`, which repeats the composer's own
`margin-inline: auto; max-width: min(860px, 100%)`.

The first attempt also added `padding-inline: 16px` to line the first pill up
with the input's TEXT. That made the dock 32px narrower than the input and simply
moved the misalignment from the left edge to both edges. The rule is stated in the
CSS now: **the outer boxes must match**; the pills carry their own 2px inset.

`verify-web-dock-alignment.mjs` measures this geometrically at six widths
(1600/1280/1024/900/760/620 — the two breakpoints plus the 860px cap on both
sides), comparing left, right and width deltas against the composer box:

```
OK: aligned at 1600px — form[482..1342] dock[482..1342] Δleft=0 Δright=0 Δwidth=0
OK: aligned at  900px — form[332..820]  dock[332..820]  Δleft=0 Δright=0 Δwidth=0
OK: aligned at  620px — form[318..548]  dock[318..548]  Δleft=0 Δright=0 Δwidth=0
```

Injection (dropping the max-width) turns the 1600px case red while the narrow
cases stay green — which is exactly why one width is not enough to test this.

### Two gate mistakes worth recording

- The first version clicked a session row before measuring. Selecting a non-live
  row opens a READ-ONLY viewer, which has no composer and therefore no dock; the
  gate reported "no dock" against a page that was working correctly.
- Adding a turn divider needed the previous chat item, which tempted an `index`
  into `chat.map`. `verify-web-chat-rows` rejects that pattern by design (an
  index in a key breaks reordering), so the divider moved inside `AgentRow`. The
  existing gate was right and the new code was wrong.

## 8. Deliberately not done
- **Direct-connect as default.** Both models ranked it *below* fixing the
  primitive, and gpt-6.1-sol added a safety requirement I did not want to rush:
  a browser's `localhost` must never be assumed to be the remote host. The
  loopback path already exists (`plan/73`); making it automatic needs host
  authentication, not just a flag.
- **Optimistic transcript swap / warm process pool.** step-5-preview's stage 1
  (optimistic swap + prefetch) is the right next step, but it changes the
  client's state machine and should not ride along with a bug-fix batch.
- **Auto-titling or rename.** step-5-preview correctly notes 11 sessions in one
  folder means sessions are being used as tasks. That is a product decision.

## 9. Next

All four open items from the previous revision of this section are DONE; the
measurements are recorded below so they are not re-litigated.

### Done

1. **Ctrl+N for New session** — `aria-keyshortcuts="Control+N"`, a `<kbd>` hint,
   and a real binding that routes through the same `onNewSession` the button uses.
   Gate: `verify-web-ctrl-n` (5 assertions, injection-verified). While adding the
   focus guard it turned out Ctrl+B / Ctrl+J had **none**, so Ctrl+J in the
   composer toggled the dock mid-sentence; all three bindings share the guard now.
2. **Prefetch `session_read` on hover/focus** — 120ms debounce, single in-flight
   request, 8-entry bounded cache, replies diverted so a hover never mounts the
   viewer. Measured: cold click-to-content ~5000ms, warm **55ms**. Gate:
   `verify-web-read-prefetch` (injection-verified).
3. **Host-room stall** (§7b) — investigated with a 45-minute, 270-tick probe that
   caught **3 real stalls and 3 recoveries**: the relay watchdog already heals
   them within 20s, so "recovery is a daemon restart" was stale. The surviving
   defect was that the UI could not TELL: the pill said "host connected" because
   the socket was open, even while every request went unanswered. Fixed by
   tracking inbound-frame age (`lastInboundAgeMs`) and showing "host not
   responding" past 75s. Gate: `verify-web-host-liveness` (95s, injection-verified
   with CDP offline emulation).
4. **Per-session drafts** — keyed by live session id; `resetChatState` no longer
   clears them, so switching or resuming cannot destroy typed text. Cleared only
   on a successful send. Gate: `verify-web-draft-per-session` (injection-verified
   on both the switch and new-session paths).

### Still open

5. Decide direct-connect's default only with host authentication in place —
   unchanged from the previous revision, and still a product decision rather than
   an implementation gap.
6. **Open a session without restarting the process.** §7g measures the real shape
   of a resume: the client now pays only the honest cost, but the host still
   spends ~15s because `session_switch` respawns the Pi with `--session <path>`
   (`supervisor.ts:747-756`), and the SDK import alone is 2.4s cold. The daemon
   path already exists precisely because `switchSession` needs an
   `ExtensionCommandContext` that an RPC child never gets — so removing the
   restart means giving the child an in-process way to reopen a session file, which
   is an architecture change, not a tuning knob.
