# Web client — unimplemented-control inventory & implementation plan

Evidence: real Chrome (CDP :9444) against the **real daemon** in direct mode
(`http://127.0.0.1:4124`, SSE transport, live workspace `4.1f`, live transcript).
`npm run dev` is *not* used for acceptance: the daemon serves its own built
bundle from `clients/web/dist` on its own origin and auto-pairs via
`/api/bootstrap`.

> Review status: adversarially reviewed by `gemini-3.8-flash`. Every correction
> it raised was re-verified against source and folded in below (§6).

## 0. Measured baseline (live, 1700px viewport)

32 visible controls. **11 dead.** Every dead control was clicked/probed in the
browser; the quoted reason strings are what the DOM actually reported.

## 1. Dead controls that SHOULD work — the server already has the verb

| # | Control | Location | Server verb | Verdict |
|---|---|---|---|---|
| A1 | **No Stop/Cancel at all** | absent from `transcript-panel.tsx` | `cancel {id, target_id}` → `cancelled` (`server/src/index.ts:4649`) | **Implement.** A streaming turn is uncancellable from the web client: the composer locks (`canSubmit`) and the status line reads *"A turn is still in flight — wait for it to finish"*. Only escape is a page reload. |
| A2 | **Enter does not send** | `transcript-panel.tsx:864` | n/a (pure client) | **Implement.** Measured: typed text + Enter → 0 new rows, draft unchanged. The UI admits it: *"Enter/Shift+Enter editing is not wired to the composer yet."* |
| A3 | **Plugins** (inert row) | `workspace-sidebar.tsx:243` | `pi_surface` already returns `packages` (`pi_surface/handlers.ts:90`); plus `skill_set_enabled`, `package_remove`, `package_update` | **Implement.** The row claims *"the host exposes no plugin surface"* — false. See §2. |
| A4 | **Lifecycle incomplete** | rows `:454`,`:464` | `workspace_stop {cwd}` (`daemon/host_bridge.ts:478`), `workspace_remove {path}` (`:488`) | **Implement.** No Stop and no Remove anywhere. Restart is gated to `crashed\|stopped`, so a *running* stuck workspace can be neither stopped nor restarted. |

### 1b. Correctness bug found while probing A4

`composerReason` (`transcript-panel.tsx:364-369`) checks only `chatBusy` and
`workspacePath === null` — **never `activeWorkspace.live`**. The model picker
*does* check it (`connect-client.tsx:1754`). So on a stopped workspace the
composer stays enabled: sending writes into a dead room, no echo ever arrives,
the turn wedges in `awaiting_echo`, and `canSubmit` locks the composer forever.
**Fix belongs with A4.**

## 2. The packages leak (root cause of A3)

`pi_surface_ok` on the wire is `{in_reply_to, runtime, skills, packages}`
(`pi_surface/handlers.ts:88-95`). The web client's type drops two of four:

```ts
// clients/web/src/lib/remote-pi/protocol.ts:911
export interface PiSurfaceOk extends ServerMessage {
  type: "pi_surface_ok";
  skills: WireSkill[];          // <-- only this
}
```

Its own comment (`:905`) admits it: *"Only `skills` is consumed today;
`runtime`/`packages` are carried so the shape matches the host contract"*.
`isPiSurfaceOk` (`:933`) validates only `skills` too. `dispatcher.ts:168`
calls `applySkills(room, msg.skills)` and drops the rest. That is precisely why
the Plugins row was declared dead.

## 3. Dead controls that are honestly impossible today — leave declared

| Control | Location | Why it must stay dead |
|---|---|---|
| Automations | `workspace-sidebar.tsx:255` | No schedule/cron verb in `ClientMessage`. |
| More | `workspace-sidebar.tsx:499` | Placeholder row; nothing to put in it. |
| Settings | `workspace-sidebar.tsx:572` | No settings verb in `ClientMessage`. |
| Trajectory tab | `transcript-panel.tsx:506` | Needs per-event records. `tree_get` returns a *branch snapshot*, not timings — wiring it is a new surface, not a fix. |
| Tool cards btn | `transcript-panel.tsx:763` | `tool_request`/`tool_result` are already rendered as text; the button had no defined job. |

| Changes tab | `right-rail.tsx:548` | No diff/working-tree API. |
| Attachments | `transcript-panel.tsx:728` | **Correctly gated**, not dead by design: enabled iff the active model reports `vision:true`. The live catalog has zero vision models, so it is dead *for this host*. No change. |

**Deferred (no dead button, so out of scope — recorded so it is not re-discovered):**
`queued_message_set`/`queued_message_clear` (steer-while-busy) and
`session_compact` are both reachable over `host_forward` but have no control in
the shipped UI. Adding them is a new surface, not a fix. Note for the record:
unlike plan/diff, **compaction is fully supported by the protocol**.

## 4. Implementation plan

### Phase 1 — A2: Enter sends (lowest risk, do first)
`transcript-panel.tsx:432` `onComposerKeyDown`:
- `Enter` (no shift, no slash-open) → `onSend`; `Shift+Enter` → newline.
- Slash-menu interception keeps first claim (its existing `if (!slashOpen) return`).
- Delete the "not wired" fallback at `:864`; the status line becomes real state.

### Phase 2 — A1: Stop / Cancel
- `protocol.ts`: add `CancelRequest`, `CancelledMsg`, guards.
- `client.ts`: `cancelTurn(hostEpk, roomId, targetId)` via `_forwardToRoom`
  (**child room**, not host room) → `{type:"cancel", target_id}`.
- `adapter.ts`: expose it.
- `dispatcher.ts`: **new** `cancelled` branch. Correlate on **`target_id`**, NOT
  `in_reply_to` — the server sends `in_reply_to: msg.id` (the cancel request id)
  and `target_id: <turn id>` (`server/src/index.ts:4661`), and `matches()`
  compares against the turn id.
- `chat.ts`: add `'cancelled'` to `ChatPhase`, to **`TERMINAL_PHASES`** (or
  `canSubmit` stays false forever), to `ChatEvent`, and a
  `settleActive(..., isOpenPhase ? 'cancelled' : null)` case so a late cancel
  cannot overwrite a settled turn.
- `notices.ts:223` `chatItemStatus`: map `cancelled` → `"failed"`; its
  `default: return "streaming"` would otherwise leave the cursor pulsing.
- `transcript-panel.tsx`: `ChatItemStatus` + `CHAT_STATUS_LABEL` gain
  `"cancelled"` / `"stopped by you"`.
- Send button becomes **Stop** while a turn is in flight (same slot,
  `aria-label="Stop this turn"`, no confirm — re-sendable).

### Phase 3 — A4: workspace lifecycle + the live gate
- `client.ts`: `stopWorkspace` / `removeWorkspace` via `this.request(...)` on
  **`room: HOST_ROOM`** — these are supervisor verbs; wrapping them in
  `host_forward` would be wrong.
- `connect-client.tsx` + `workspace-sidebar.tsx`: Stop for a running workspace,
  Remove-from-catalog behind a confirm.
- Allow Restart while `running` (server is idempotent by documented design:
  *"an already-running workspace answers `workspace_restart_ok` without
  respawning"* — `protocol/types.ts:259`).
- **Fix the live gate**: `composerReason` gains a fixed
  "This workspace is not running — start it before sending." branch.
- On `workspace_state{state:"stopped"}` for the active room, settle any open
  turn as `disconnected` (the child process is killed; no `agent_done` will come).

### Phase 4 — A3: Plugins dock tab
- `protocol.ts`: widen `PiSurfaceOk` to `{skills, packages, runtime}`; add wire
  types + guards for `skill_set_enabled`, `package_remove`, `package_update`,
  `package_op_ok`.
  **Keep `packages`/`runtime` validation tolerant** (absent ⇒ empty) so the
  existing fixture `scripts/verify-web-skills.mjs:76` (which sends only
  `skills`) keeps passing rather than being silently broken.
- `dispatcher.ts`: widen `DispatcherPorts`, handle the new acks.
- `use-skill-store.ts`: hold packages + per-room mutation busy flags.
- `connect-client.tsx`: project packages; wire toggle/remove/update callbacks.
- `adapter.ts` / `client.ts`: send the three verbs over `host_forward`.
- `right-rail.tsx`: new `plugins` dock tab; sidebar Plugins row opens it
  (kills the dead row).
- **Not** wiring `package_install`: needs `confirm_third_party` and executes
  third-party code. Out of scope — better absent than half-safe.

## 5. Acceptance — real browser only, no unit-test substitutes

Implemented as `clients/web/scripts/verify-buttons.mjs` (`npm run verify:buttons`).
It drives **real Chrome over CDP** against the **live direct-mode daemon** and
asserts all four phases, the Plan tab, and regression. Current result: **46/46 PASS**, twice in
a row (the harness is idempotent: it starts a workspace first, so a previous run
that ended by stopping one cannot poison the next).

Prerequisites (all must hold, or the run is meaningless):
1. `npm run build` — the daemon serves `clients/web/dist`, not `src`.
2. The direct daemon on `http://127.0.0.1:4124` (auto-pairs via `/api/bootstrap`).
3. Chrome with `--remote-debugging-port=9444`.

What it proves, and how:

| Phase | Assertion |
|---|---|
| A2 | Shift+Enter does NOT send and inserts a newline; Enter submits and clears the draft; the "not wired" text is gone. |
| A1 | A Stop control replaces Send mid-turn; clicking it settles the turn (no lingering `streaming`) and unlocks the composer. |
| A4 | The workspace row's Stop flips the row off `running`, the composer then STATES "not running" and is locked; no turn is left open. |
| A3 | The dock has a Plugins tab that opens and renders Packages + Skills from the host payload, and the sidebar Plugins row is `enabled` rather than dead. |
| Plan | The Plan tab lists the workspace's real `plan/*.md` (90 documents on this repo), a selected one renders as MARKDOWN (headings present, no raw `#` leaking), and no path input exists that could name an arbitrary file. |
| Regression | Unpair / New session / Refresh / Right dock still render; zero console exceptions. |

Two measurement notes worth keeping, both of which caught real mistakes here:

- **Scope the Stop selector.** "Stop" names BOTH the composer control and a
  workspace row. The first version pressed the row's and killed the whole
  workspace instead of the turn — the test was wrong, not the code.
- **Pass `text: "\r"` for Shift+Enter too.** A synthetic keyDown does not run the
  browser's default insertion, so omitting the character makes the newline
  assertion vacuous: the field is unchanged whether or not `preventDefault` ran.
  Supplying it makes the check discriminating (a swallowed key keeps the field).

### The Plan tab and `fs_read` (plan/77)

The Plan tab was the last honestly-dead surface: `fs_list` returns directory
*metadata*, so the dock could name a file but never read one. It now renders a
real document through the SAME `Markdown` component the transcript uses.

`fs_read` is a **positive allowlist**, and two bugs here are worth remembering:

1. **The allowlist was measured against the wrong root.** `handleFsRead` first
   defaulted to `process.cwd()`, which is wherever the daemon was started — not
   the workspace whose `plan/` the user is reading. Every legitimate read came
   back `not_allowed`, so the feature looked broken while the fence was in fact
   working perfectly on the wrong directory. The request now carries a
   **required** `root`; required, not defaulted, so it cannot silently fall back
   again. Two tests pin it (readable under its own root, refused under another).
2. **A restart appeared to work and did not.** A `supervisord --direct` start
   exited with `EADDRINUSE` while an old process still held 4124, so a whole
   round of testing exercised the OLD binary. After restarting the daemon, check
   the log for `fatal` and that the port was actually re-bound — never assume.

#### The panel itself was rebuilt after real use (plan/77 v2)

The first version stacked the document ABOVE an always-rendered 90-row document
list inside `.panel` (which is `overflow: auto`). Measured in Chrome at
1700x1100: scroll the list down to reach a lower plan, click it, and the body
lands at **`top: -2438px`** — entirely above the viewport. The click worked and
the document was there; the user saw a blank panel and concluded nothing
happened.

Resetting `scrollTop` would not have fixed it: a 7000px document plus a 3590px
list in one scroller makes the panel ~10000px tall, so scrolling to the end of
the document drops the reader into the file list. The panel is now a
**drill-down** — list view or document view, never both — in `plan-panel.tsx`,
with Plan moved out of `.panel` into `.panelHidden` (as Sessions already does)
so the `overflow:auto` context that produced the offset no longer exists.

Before / after, same viewport and same 90 real documents:

| | before | after |
|---|---|---|
| document position after clicking a lower row | `top: -2438px` (off-screen) | `top: 129px` (visible) |
| document `scrollTop` | inherited from the list | `0` |
| active scroll containers | 2 (panel + 58vh body) | **1** |
| document usable height | 638px of 1064px | 959px |
| row label | full absolute path (37 shared chars/row) | index pill + basename |
| finding a document among 90 | scroll only | filter (`76` → 2 of 90) |

`verify-buttons.mjs` now asserts the failure itself: it scrolls the list to its
end, clicks the LAST row, and requires the document scroller's `top >= 0` at
`scrollTop === 0`. The old layout cannot pass that check.

Server-side coverage lives in `server/src/daemon/fs_read_77.test.ts` (21 cases:
sibling-prefix trap, dotfiles inside an allowlisted dir, traversal, symlink
escape, bad extensions, Windows separators, truncation, cross-root refusal).
`npm run verify:web` still covers the 11 pure-Node suites (all green). The 7
browser-dependent suites in it require a **paired** `:3010` dev-server page; they
fail identically before and after this change and are an environment
prerequisite, not a regression (verified by stashing the source and re-running).

## 6. Review corrections applied (all re-verified against source)

1. `cancelled` correlation must be `target_id`, not `in_reply_to` — corrected (Phase 2).
2. `dispatcher.ts` had no `cancelled` branch and `notices.ts:223` defaults to
   `"streaming"` — both added (Phase 2).
3. `workspace_stop`/`workspace_remove` are **host-room** supervisor verbs, not
   `host_forward` — corrected (Phase 3).
4. The composer never gates on `live` — added as part of Phase 3.
5. A3 is **not** contained to `protocol.ts`: 8 files incl. `verify-web-skills.mjs`
   — scope corrected (Phase 4).
6. Implementation order reordered by risk: A2 → A1 → A4 → A3 (was A1→A2→A3→A4).

## 7. Copy-vs-behaviour defects found by the full-surface browser survey

Both were confirmed in a real browser before touching code, and both were lies a
user could read on screen while the control beside them worked.

### 7.1 The Automations dock tab described Changes (fixed)

`right-rail.tsx` `tabReason()` ended in a bare `return` holding the Changes
sentence, so every tab without its own branch inherited it. `automations` was
the only one falling through, which made its tooltip read:

> Automations — The host protocol exposes no diff/working-tree API, so there is
> nothing to report. Declared here so the surface is not silently missing.

while that same tab created, disabled, fired and deleted scheduled tasks.

Fixed by converting the chain to an explicit `switch` with a per-tab branch and a
`default` that returns `Unknown dock tab: <id>` — a fallthrough here is exactly
the defect, so it must not be able to silently borrow another tab's description
again. Changes keeps its honest empty-state sentence, asserted positively so the
fix cannot be "solved" by deleting the only explanation that surface has.

### 7.2 Narrow-width inert rows blamed the host (fixed)

The sidebar's Plugins/Automations rows said
`"the host exposes no automation surface to this client"` whenever their callback
was undefined. The only cause of that undefined is `!geo.dockAvailable`
(`remote-pi-shell.tsx`), i.e. viewport width — the host ships `schedule` in
`HOST_CAPABILITIES` and the tab works at 1700px. Both rows now reuse the file's
existing authoritative wording, `"The dock is not available at this width (below
760px)"`, and state that the surface opens in that dock. Plugins had no `sr-only`
explanation at all; one was added alongside.

**Honest limitation, measured:** this disabled state is not reachable through the
UI. The rows only render in the *expanded* sidebar, which auto-collapses to a
56px rail below `SIDEBAR_COLLAPSE_WIDTH` (1024px), while the dock disappears later
at `DOCK_HIDE_WIDTH` (760px). The two windows do not overlap, so the row is gone
before the dock is. `verify-automations.mjs` therefore asserts the *true*
observable behaviour — at 1000px no dead row is offered, at 700px the dock is
absent entirely — rather than inventing a state a user can never see. The copy fix
stands on correctness, not on reachability.

---

## §8 — The Changes tab is now a real surface (plan/78)

### What it was

A permanent, honest empty state: `No changes reported`, with a `tabReason`
sentence saying the host protocol exposes no diff/working-tree API. That was
true — there was no git capability anywhere in `server/src`.

### What it is

A git **working-tree status snapshot**: branch (or `detached HEAD`), HEAD sha +
subject, ahead/behind, four counts (staged / unstaged / untracked / conflicted),
and one row per changed path with a status badge. A reload button re-reads it.
Opening the tab forces a fresh read, because a stale clean/dirty answer is worse
than a spinner.

### The line that was drawn, and why

**Status only. No diff content, no file bodies.** This is not a scoping
shortcut — it is the same fence that `fs_read` (plan/77) already stands on. That
verb is allowlisted to `plan/`, `.workflow/`, `docs/` precisely so a pairing
token cannot exfiltrate `~/.ssh/id_rsa` or `.env`. A diff verb is *by definition*
the content of arbitrary files in the worktree, so adding one would silently
widen the same token's grant to "every file you ever edited". The panel answers
"is this worktree safe to hand to an agent right now, and which files are dirty"
and stops there.

Consequently:
- paths are **repo-relative**, never absolute — same policy as the Plan panel,
  which strips to basename for the same reason (a narrow dock needs the part that
  differs between rows, not the host's directory layout). The client-side guard
  rejects a drive-letter or `/`-prefixed `rel` outright, so a host bug cannot turn
  into a path disclosure.
- git's stderr is never forwarded. A failure is a closed enum
  (`not_a_repo` / `git_missing` / `timeout` / `unsupported`) and the sentence is
  authored in `notices.ts`.
- every git call goes through `execFile` with an argv array, so a filename like
  `$(touch pwned).txt` is data, not code. `GIT_DIR` / `GIT_WORK_TREE` /
  `GIT_INDEX_FILE` are deleted from the env so a stray export cannot point the
  query at a different tree.

### The bug that cost the most time

The web guard `isChangesSnapshotOk` read `v.is_repo`, i.e. **the envelope**,
while the payload lives at `reply.snapshot.is_repo`. Every real frame was
therefore rejected, and the panel showed "Could not read this workspace's working
tree." while the host was answering perfectly on every field. It was found only
by instrumenting each guard clause and printing which one returned `false` — the
returned data *looked* correct in isolation, which is exactly why reasoning about
it kept concluding "this should pass".

### Why a non-repo is a first-class answer

`4.1f` — the workspace every acceptance run in this repo uses — is **not** a git
repository (measured: `fatal: not a git repository`). So "clean worktree" and
"cannot tell" must never look the same. Collapsing them into an empty list would
make the panel lie in exactly the situation a user most needs the truth. Section 2
of `verify-changes.mjs` pins that: the sentence says the workspace is not a
repository, there are zero rows, and — the load-bearing one — the panel does
**not** claim "No changes".

### Acceptance

`scripts/verify-changes.mjs` — **26 checks**, real Chrome over CDP against the
live direct-mode daemon on `:4124`, 3× green. It visits two workspaces on
purpose: the non-repo (`4.1f`) and the real repo (`remote_pi`), and it **restores
the workspace selection it borrowed** on the way out — selecting a workspace is
global app state, and leaving `remote_pi` selected made `verify-buttons` fail on
rows that belong to `4.1f`.

Server-side: `src/daemon/changes.test.ts` — **13 tests**, including the `-z`
rename case (a rename emits the new path plus the original as a *second* NUL
field, which must be consumed or the row doubles), a filename containing a
newline, and an injection-shaped filename proving no shell was involved.

Two assertions in `verify-automations.mjs` §9 were **strengthened, not deleted**:
the Changes tooltip must now describe working-tree status *and* must no longer
claim the host exposes no such API. A revert of the panel without the copy — or
the copy without the panel — fails there.

---

## §9 — The "Asking the host…" hang, again (plan/78 follow-up)

### What the user saw

`Asking the host for this workspace's sessions…` sitting on the panel with no
escape. The Refresh control is `disabled={busy}`, so the surface looked frozen
and only a page reload recovered it.

### The defect

`requestSessions` has a branch for "the transport is not connected yet" — it
re-asks after 800 ms. Those retries were deliberately **not** charged to
`SESSIONS_RETRY_BUDGET`, on the correct reasoning that the host was never asked,
so no host budget was spent.

That reasoning was right and the conclusion drawn from it was wrong: *"does not
spend the host budget"* is not *"needs no budget"*. Nothing else bounded them
either. While the transport stayed down, every retry re-entered the branch, set
`busy`, and armed another 800 ms timer — **forever**.

The store's 150 s watchdog cannot rescue this: it is keyed on `busy`, and
although a *repeated* `setBusy(true)` does not re-arm it (the value never
changes), the honest 24 s answer is far better than 150 s of a dead panel.

### The fix

`client/sessions-retry.ts` — a pure `decideNotReadyRetry(used, budget)` that
answers `retry` or `give_up`, called from a single line at the branch. When the
budget is spent the panel clears `busy` and shows the honest failure. The budget
refills only when the transport actually comes up, so a later disconnect gets
the same allowance instead of inheriting a spent one.

`SESSIONS_NOT_READY_BUDGET = 30` (30 × 800 ms = 24 s) covers a relay reconnect,
which is the normal reason the transport is briefly down.

### Why there are TWO tests, and what each is worth

This is the part worth recording, because the first attempt was wrong.

`verify-sessions-hang.mjs` drives the real failure: it blocks `*/api/frame*`, forces
a re-list, and samples for 72 s. It passed **even with the budget set to 100000**,
which proved it was exercising the HOST-retry path, not the not-ready path — the
probe can only drive the page once the adapter is connected, and by then the defect
cannot fire. It is kept as end-to-end coverage of "the panel reaches a terminal
state and stops asking" (`AAA.AAAFFFFFFFFFFF` is the expected sample pattern: ~24 s
of legitimate retrying, then terminal).

`verify-sessions-retry.mjs` pins the invariant on the pure function, where the
failure is reproducible: it fails 4/7 assertions when the `used >= budget` guard is
removed — verified by injecting exactly that regression and watching it go red.

The honest summary: the browser test protects the *symptom*, the unit test protects
the *cause*. Neither alone was sufficient.

## §10 — Settings edits the host's own `models.json` (plan/79)

The `Settings` row in the sidebar was listed in §7 as a permanently dead control:
`disabled` with the tooltip *"no settings surface is exposed to the web client
yet"*. It is now a real dock tab that reads **and writes** the host's
`~/.pi/agent/models.json` — the first capability in this codebase that mutates host
state, and the file it mutates holds **plaintext API keys**.

### What it is

`models_describe` returns the parsed config with every secret field **removed**, plus
a separate existence map. `models_mutate` applies path-addressed edits and returns
the new revision. The panel renders provider fields and the model list, and saving
emits a diff of only the paths the user actually changed.

### Design rulings

**A key never leaves the host in any form.** Not the value, not a mask, not a
length. The panel receives `has_key: boolean` and nothing else.
- A mask like `sk-…abcd` was rejected: it leaks four credential characters for no
  decision this panel makes, and a masked value pre-filled into a form is the
  classic path to writing the mask back as the key.
- A length was rejected too: a fixed-length key reveals which scheme issued it.

**The key box has three states, kept lexically distinct.** Untouched emits **no op
at all**; typing emits a `set`; clearing goes through a separate destructive
"Remove key" control that emits an `unset` behind its own confirmation. The classic
accident — a form that pre-fills nothing, renders an empty password box, and submits
the whole object on save — is structurally impossible because the panel never
submits a document. The host independently refuses a blank secret `set`, so even a
client bug cannot destroy a working key.

**`mutate` only, never `update`/`replace`.** DSH's settings service offers all three
and says `mutate` exists to preserve "secrets absent from a client response". Here
only `mutate` is safe: `replace` is a secret-deletion machine, because the client
never receives the key, so "the client did not send a key" and "the client says
there is no key" become the same message. `update` is ambiguous on arrays (merge by
index? by id? wholesale?), and that ambiguity is exactly where the key-loss bug
would hide. Path-addressed ops make every change an explicit statement about one
location, and **a key no op names cannot be touched**.

**The protocol carries no path.** `fs_read` accepts a client path and fences it
against an allowlist; `models_describe` accepts **no parameters at all** and
`models_mutate` accepts ops whose `path` segments address the JSON structure, never
a filesystem path. The target is resolved host-side from `homedir()`. That is a
stronger fence than an allowlist because there is nothing to validate.

**`revision` is the sha256 of the file bytes**, compared once immediately before a
single atomic write. It is checked after the read and before anything is written, so
no interleaving writer can slip between the check and the rename. A stale revision
is **refused**, not retried: the user's newer manual edit wins over an old form.

**Writes are atomic and verified.** Same-directory temp file → write → `fsync` →
`chmod` to the original mode → `rename`, with the previous bytes kept in
`models.json.bak` (mode 0600). Then the result is validated by **pi's own
`ModelRegistry`** — `ModelRegistry.create(AuthStorage.inMemory({}), path)` +
`refresh()` + `getError()`. "The code that will read it agrees it is readable" is
the only check worth trusting; rollback from `.bak` on failure.

### Two real defects found by measurement, not reasoning

**(a) The web guard rejected every honest frame.** `isModelsDescribeOk` serialised
the **whole frame** and refused anything matching `/api[_-]?key/`. But the `secrets`
map's keys are path strings — `providers.my-newapi.apiKey` — so the honest payload
matched the pattern, every real frame was rejected, and the panel stayed permanently
empty while the host answered correctly. The fence must guard the payload that could
carry a **value**, not the index that names where one lives. It now serialises
`config` only. This is the same class of error as the Changes bug in §8: a guard
that reads the wrong thing and fails closed on good data.

**(b) The panel never saw the provider.** `hasKey` and the ops diff used the raw
`providerId` state (initially `null`) instead of the derived `effectiveProviderId`,
so the badge always said "not set", the diff was always empty, and Save was always
disabled. Three call sites corrected.

Both were found by instrumenting the failing clause, not by re-reading the code.

### Acceptance

`scripts/verify-models-config.mjs` — **43/43**, stable across three runs, driven over
CDP against the live daemon and the **real** `models.json`:

- Settings tab reachable; sidebar row no longer disabled; tooltip no longer claims no
  surface exists.
- Panel matches disk (provider, baseUrl, model count and ids).
- **Negative:** no 8-character window of the real key appears in any SSE frame or in
  the DOM; no `apiKey` field assignment appears in the DOM; the key input's `value`
  is strictly `""` and its `type` is `password`.
- Editing `baseUrl` alone leaves the on-disk `apiKey` **byte-identical** and every
  model subtree deep-equal.
- A whitespace-only key box produces **no pending change** and leaves the disk key
  untouched.
- Adding a model lands exactly on disk while every pre-existing model stays
  deep-equal.
- An out-of-band edit followed by a stale save leaves the newer content on disk and
  reports a conflict.
- No absolute path, drive letter, stack frame or errno in the panel text.
- The real config is restored **byte-for-byte** (sha256 verified) and all test
  residue removed.

`scripts/verify-models-config.mjs` is safe to re-run: it backs the file up before it
starts and restores on every exit path including failure.

### Honest limitation

The panel is gated on the host advertising `models_config`. Because
`HOST_CAPABILITIES` is read when the daemon starts, a daemon that predates this
change keeps the row disabled with the reason *"this host reports no
model-configuration surface to this client"* — which is a true statement about that
daemon, not a bug. No per-device opt-in was added: the file is already editable via
SSH on any host the user can reach, and `fs_read`'s allowlist reasoning (which
refuses to let a pairing token reach arbitrary files) is unaffected because this
surface writes exactly one host-side-resolved path.

## §11 — "Settings" was the wrong name for a models editor (plan/80)

### The mistake

§10 shipped a dock tab called **Settings** whose entire content was a `models.json`
editor. The user's reaction was the correct review verdict: *"your settings only has
models? where is the theme colour at minimum?"* Two distinct errors:

1. **Copy-vs-behaviour, committed one section after writing §7 about it.** A label
   that promises "preferences" and delivers one file is exactly the defect §7 exists
   to catch. The panel was not wrong; the name was a lie.
2. **The most basic preference was missing.** `~/.pi/agent/settings.json` on this
   machine literally contains `theme`, `hideThinkingBlock` and a `retry` block. The
   earlier design review had asked "models only, or other config too?" and the answer
   chosen was "models only, because other files each need their own blast-radius
   analysis" — which was lazy reasoning: a theme picker has no blast radius.

### The corrected IA

Eight dock tabs, each with its own explicit `tabReason` branch:

| Tab | Contents |
|---|---|
| Sessions / Plan / Files / Changes / Plugins / Automations | unchanged |
| **Models** | providers, models, apiKey (write-only) — the plan/79 panel, renamed |
| **Settings** | appearance + behaviour, described below |

The sidebar gained a separate **Models** row. Both rows are disabled only when there
is genuinely nothing to open, and each names its real cause — dock width, or a host
without that capability.

### What Settings actually holds now

Two sections, kept visibly separate so two different "theme" concepts cannot be
confused:

**This browser** — a visual preset. Purely local: `localStorage`, never sent to the
host, because it describes the client's own appearance.
- 5 presets: Default (`default`), Ocean, Forest, Amber, Violet.
- `default` is a **true no-op**: it removes `--dsw-preset-accent`, which makes every
  preset rule invalid at computed-value time, so the measured tokens win.
- Non-default presets do **not** replace the palette. `design-platform.css` colours
  were measured against DSH's reference (contrast ratios, the `--dsw-alias-bg-base`
  chain); swapping them wholesale would silently break those measurements. A preset
  therefore supplies one ACCENT used for the focus ring, primary-button fill,
  `::selection`, the sidebar's active-item inset, and the active-tab underline.
- Applied in `main.tsx` **before the first render**, for the same reason the redirect
  is: applying it inside a component paints the default palette for one frame.

**This host** — `hideThinkingBlock` and the retry policy (`enabled`, `maxRetries`,
`baseDelayMs`, `provider.maxRetryDelayMs`), read from and written to the host's own
`settings.json`.

**Read-only, deliberately:** pi's `theme` value. It selects a **terminal** theme and
this panel does not offer to change it — a web colour picker silently rewriting a TUI
setting would be a surprise across machines. It is displayed precisely so the two
theme concepts are distinguishable.

### Why `settings.json` needs a different fence from `models.json`

`models.json` is a credential store: the fence is "return nothing secret".
`settings.json` has no secrets, but it is a **mixed** file. The real one contains
`packages` with six entries, three of which are **absolute host paths**
(`C:\Users\…`, `D:\workspace\…`). Projecting the document would leak the user's
directory layout through a preferences panel — the exact thing `fs_read`'s allowlist
prevents.

So the host projects a **positive whitelist** (6 entries) and drops everything else.
Positive, not a denylist, for the reason `fs_nav` gives: a denylist must anticipate
every key pi adds and rots silently. A missing toggle is a bug report; a leaked
internal key is not. Prefixes are refused too — `retry` alone is not whitelisted,
because replacing that subtree would silently drop `retry.provider`.

Writes are path-addressed (`set`/`unset`) against the same whitelist, atomic
(`tmp → fsync → rename`, `.bak`), with a post-write re-read and parse since
`settings.json` has no external schema loader analogous to pi's `ModelRegistry`.

### Acceptance

`scripts/verify-settings.mjs` — **47/47**, twice, real Chrome over CDP against the
live daemon and the **real** `settings.json`:

- Models and Settings are two distinct tabs with distinct tooltips (Models names
  `models.json`; Settings names appearance/behaviour and does **not** mention
  `models.json`).
- All six host values match disk.
- **Negative:** no SSE frame and no DOM text contains `packages`,
  `lastChangelogVersion`, any package specifier from the file, or an absolute path.
- A preset really repaints: `body[data-theme-preset]` changes, `--dsw-preset-accent`
  computes to the accent, `localStorage` persists it, it survives a reload with the
  accent already applied, and switching back to Default **clears** the accent.
- Saving `retry.maxRetries` leaves `packages`, `extensions`, `lastChangelogVersion`,
  `theme`, `hideThinkingBlock` and the other three retry fields byte-identical.
- A stale revision is refused and the newer content survives.
- No absolute path, stack frame or errno in the panel text.
- The real file is restored byte-for-byte.

### Regression found while doing this

`remote-pi-shell.tsx` re-read the panel's data on tab open via a hook keyed to the
tab id. When models moved from `settings` to `models`, the hook was not updated, so
the Models tab rendered empty forever. Same class as the §10 defect "the panel never
saw the provider": a rename that misses a call site. `verify-models-config.mjs` caught
it only after being repointed at the Models tab — worth noting that the harness
itself needed updating for the rename, and that updating it is what surfaced the bug.

## §12 — Dark mode was dead code, and eight tabs overflowed (plan/81)

### The dark palette already existed and nothing used it

`design-platform.css` has carried a complete dark palette behind
`:root[data-theme="dark"]` — 39 token overrides — for as long as this file has been
light-first. **No code ever set that attribute.** Every user got light, and the dark
set was unreachable dead CSS. So "add a dark theme" was not a palette job; it was
wiring, plus finishing the parts the dark block never covered.

**Wiring.** `src/lib/theme-mode.ts` owns the axis: `light | dark | system`.
- The stored value is the **intent**, not the resolved palette. Storing the resolved
  value would freeze a "follow system" user at the moment they picked it, so flipping
  the OS afterwards would do nothing until they revisited Settings.
- `system` is re-resolved on every OS `prefers-color-scheme` change, and the
  subscription is a no-op when the intent is explicit — a user who chose "always
  dark" must not be flipped underneath.
- Applied in `main.tsx` **before the first render**, then `applyPreset` on top. A
  dark user otherwise gets a white flash on every load.
- `data-theme` is always set, including `"light"`, so the current palette is readable
  from the DOM instead of inferred from an attribute's absence.

**Completing the dark set.** 26 alias tokens were light-only. Four of them were real
defects on a dark canvas, not cosmetics:
- `--dsw-alias-scrollbar-bg-l1/l2` pointed at `neutral-200` (rgb 229) — an almost
  invisible thumb on `neutral-bluish-950`. Now re-pointed at the ramp's dark steps
  (`neutral-800/700`), which already existed in the file.
- `--dsw-alias-button-tool-bar-fill` was `rgba(84,85,87,0.5)`, a light grey wash.
- `--dsw-alias-state-success/warn-primary` had no dark value at all.
- `--dsw-elevation-*` shadows read as nothing on dark; the dark set leans on a
  stroke plus a deeper, tighter shadow.

The rest (`radius-*`, `transition-*`, `ease-*`) are theme-independent and correctly
have no dark override.

**Accent vs mode are separate axes.** Mode selects the palette; the plan/80 preset
supplies an accent on top. Light + Ocean and Dark + Ocean are both valid, and the
panel states them as two labelled groups rather than one confusing "Theme".

### Eight tabs no longer fit

Splitting Settings and Models out made eight dock tabs. At a 1500px viewport the row
overflowed and the **last** tab was clipped behind the collapse button — so the
newest surface became the hardest one to reach. `.tabList` now scrolls horizontally
(`scrollbar-width: none`, since a visible bar would consume more height than the
28px row itself) with end padding so the final tab does not butt against the button,
and `.tabLabel` no longer shrinks to an ellipsis before overflow kicks in. Every tab
stays a real button, so keyboard traversal still works.

### Acceptance

`verify-settings.mjs` grew from 47 to **63 checks, twice green**:
- Light sets `data-theme=light` with a bright computed canvas.
- Clicking Dark in the panel makes `data-theme=dark`, the **computed** canvas darker
  (not merely an attribute change), the ink colour invert, and `color-scheme` report
  `dark` so native widgets follow.
- The scrollbar no longer resolves to the light thumb colour, and the success state
  resolves to a real colour in dark — both read through `getComputedStyle` of a probe
  element rather than the raw custom property, because a `var()` chain can leave the
  raw property empty while the computed colour is valid.
- Dark survives a reload; the **stored value is the intent** (`"dark"`), not a
  resolved boolean; `System` stores `"system"` and resolves to the OS preference.
- All eight tabs are present and **none is clipped** outside the tab row (1g/1h).

`verify-models-config.mjs` reached **44/44** with the same scoping fix.

### Two assertion-scope corrections (honest note)

Two leak assertions scanned `document.documentElement` for absolute paths. They
started failing — not because the panels leak, but because **the transcript**
legitimately contains agent output, and this workspace's agent printed
`No .workflow directory found at D:\…`. A whole-document scan therefore failed on
honest chat content that has nothing to do with the surface under test. Both scans are
now scoped to the panel root (and assert they were scoped, so a broken selector
cannot silently pass). Assertion strength went up, not down: the check is now about
what the *panel* exposes, which is the actual claim.

### A credential copy the harness was leaving behind

While cleaning up after this round, `~/.pi/agent/models.json.verify-backup` was still
sitting on disk *after* `verify-models-config.mjs` reported 44/44. The script backed
the real file up before starting and restored it on every exit path — but the success
path restored the **file** and never removed the **backup**. The result is worse than
a stray temp file: it is a second copy of the real `models.json`, i.e. of the real
API key, created by a *test* and left in the user's config directory indefinitely.
`restore()` now deletes the backup on every exit path, verified by checking that the
path is gone after a green run.

Worth stating plainly because it is the same class as everything else in this
document: the test was green, the artefact it produced was wrong.

## §13 — Dark mode: the measured failures, and the review that followed (plan/82)

### What the user reported

"live 的样式在暗黑模式下看不清". Verified exactly, by measurement rather than by
looking: the `running` / `live` status badge computed to **1.44:1**
(`rgb(35,60,44)` on `rgb(27,27,28)`). WCAG AA for small text is 4.5:1. The word that
tells you whether a workspace is alive was the least legible text on the screen.

### Root cause: seven references to tokens that were never defined

`--ok-text` legitimately exists twice: `green-900` (dark green, 11.97:1 on white) for
the light theme. The dark theme re-declared `--ok-text: var(--dsw-static-green-300)` —
**but `green-300` has never existed in this file.** CSS discards a declaration whose
`var()` is unresolvable, so the dark override vanished and the light value won. Same
for `--dsw-static-amber-300` and `--dsw-static-amber-200`.

Nothing in the toolchain catches this. TypeScript does not read CSS, ESLint does not
resolve custom properties, and the declaration is syntactically perfect. The only
detector is resolution.

Seven occurrences fixed, and `scripts/audit-tokens.mjs` now fails the build when any
`var(--x)` has no definition anywhere in `src` (222 → 224 defined tokens, 167
referenced, zero undefined). The moment it existed it found two more real defects I
had introduced in §12: `--dsw-static-neutral-700` used for the dark scrollbar hover
(also non-existent — the hover state silently did nothing) and a typo
`--dsw-alias-bg-l2` instead of `--dsw-alias-bg-layer-2` in the message footer.

### The full set of measured failures, then and now

| Element | Before | After | Cause |
|---|---|---|---|
| `running` / `live` badge | **1.44:1** | 8.81:1 | undefined `green-300` → light green-900 won |
| `Start <dir>` button | **1.44:1** | passes | same `--ok-text` |
| `configured` badge | 2.28:1 | passes | fill colour (`green-500`) used as text; now `--ok-text` |
| Primary button "List" | 2.33:1 | 7.75:1 | white ink on `rgb(122,170,255)` accent |
| `Connect` submit | 2.33:1 | passes | same |
| 3 more `--accent` fills | 2.33:1 | passes | same |
| `Remove key` destructive | 4.24:1 | passes | new `red-300` light step for dark text |
| Dark scrollbar thumb | 1.32:1 | visible | inherited `neutral-800`; now alpha-white |

**The accent-ink defect was not dark-specific.** `--green-ink` follows the theme
(white in light, near-black in dark), while the accent fill is a LIGHT blue in both.
So white-on-light-blue measured 2.33:1 in the **light** theme too — it was simply
never noticed. Fixed with a single `--on-accent` token: dark in both themes, because
the fill is light in both. Four call sites corrected.

### Three real bugs found by re-measuring, not by reading

1. **The measurement was wrong before the code was.** The first contrast sweep reported
   "List" at 1.29:1 on `rgb(44,44,46)`. It is actually 7.75:1 — the probe skipped the
   element's OWN background and scored the label against the page behind a filled
   button. Fixed the probe (own background first), and "Send the message" fell out as
   `sr-only` text with a 1px box, which must not be scored for visual contrast.
2. **A preset accent lied about the theme.** `theme-presets.css` set primary-button ink
   to `--dsw-alias-bg-base`, reasoning the canvas would contrast with the accent. True
   in dark, inverted in light: white on the light accent = 2.33:1.
3. **The darkest reason to automate.** None of the three would have been caught by
   review; all three were caught by measuring computed values in a real browser.

### Design review (gemini-3.8-flash) and what was adopted

Reviewed against the measured-clean baseline, asked what still looks unpolished even
though nothing fails a checker. Adopted the changes with a defensible rationale;
declined the ones that would have broken the measured reference palette.

**Adopted**
- **Preset accents are calibrated per canvas.** A 500-level hue calibrated for white
  recedes on near-black (violet/blue) or reads as a system alert (amber). Each preset
  now carries a `darkAccent` at the 400 level: Ocean `#60a5fa`, Forest `#34d399`,
  Amber `#fbbf24`, Violet `#a78bfa`. `applyPreset` picks the step from
  `data-theme`, and both the mode switch and the OS appearance subscription
  re-resolve it — otherwise a dark accent would persist onto the light canvas.
- **Scrollbar uses alpha-white** (`rgba(255,255,255,.16)` / `.28` hover), not an opaque
  grey step. A grey thumb is tuned for exactly one surface: `neutral-800` measured
  1.32:1 on the canvas and 1.14:1 on layer-2. Alpha resolves against whatever it
  overlaps.
- **Dark `label-primary` lowered from `neutral-bluish-50`** (rgb 249,250,251, ~17.5:1)
  to `neutral-bluish-100` (~14:1). The surplus contrast produced halation — text that
  appears to glow and blur — with no legibility gain.

**Declined, with reasons**
- Replacing the neutral ramp with a blue-tinted 4-tier system (`#0e1013`/`#16191e`/
  `#20242b`/`#2a2f38`): these values were measured against DSH's reference, and
  swapping the ramp would silently invalidate every contrast measurement in the file.
- Converting status text to dot+neutral-label: a real improvement in principle, but it
  changes component structure across the app and is not a dark-mode regression.
  Recorded here as a deliberate follow-up, not silently dropped.
- White `#ffffff` → `#f4f4f5` for headings: already addressed at the token level.

### Acceptance

`verify-settings.mjs` 63 → **68 checks, green**: four assertions that each preset
resolves to its dark-calibrated step, and **one that scans every visible text node in
dark mode and fails on anything below WCAG AA 4.5:1** — the assertion that would have
caught 1.44:1.

Pre-existing contrast gates, now also green (they were failing):
- `audit-contrast.mjs` — **0 failing element groups at AA**. This gate caught the
  `Connect` button, the fourth instance of the accent-ink defect.
- `verify-web-contrast-tokens/states/hover/selection` — OK.

`verify-models-config` 44/44. Web `tsc` 0, eslint exit 0 (135 warnings, at cap),
build ✓.

## §12 — Dark mode was dead code (plan/81)

### The defect

The user asked for a dark theme. The dark theme **already existed**:
`design-platform.css` carries a `:root[data-theme="dark"]` block with 39 token
overrides, and the file's own header says *"DSH keeps its dark palette behind an
attribute rather than making it the default"*. But **nothing in the codebase ever set
that attribute**. `grep -rn 'data-theme="' src/` returned every `data-theme-preset`
(plan/80's accent work) and not one writer of `data-theme`.

So the repo shipped a complete dark palette that no user could reach. That is a
different failure from a missing feature: the work was done and then not connected,
which is exactly the class of bug §10 and §11 both hit (a rename/refactor missing a
call site). Worth noting the pattern: this session has now found three defects of the
shape "the mechanism is right, the wiring is absent".

### The fix, and why mode ≠ preset

Two **independent axes**, now stated separately in the panel so they cannot be
confused:

| Axis | Controls | Storage |
|---|---|---|
| **Mode** (`light` / `dark` / `system`) | WHICH palette | `remote-pi.theme-mode` |
| **Preset** (Default / Ocean / Forest / Amber / Violet) | an ACCENT on top | `remote-pi.theme-preset` |

`theme-mode.ts` stores the **intent**, not the resolved palette. Storing `"dark"`
because the OS was dark when the user chose "follow system" would freeze the choice:
flipping the OS afterwards would do nothing until they revisited Settings. The intent
is persisted and re-resolved on every change, and a `matchMedia` subscription
re-applies it — but only while the intent is `system`, so a user who explicitly chose
"always dark" is never flipped by the OS underneath them.

`applyMode` always sets the attribute, even for light: `data-theme="light"` makes the
current state readable from the DOM (and assertable) instead of being inferred from
the absence of an attribute.

Applied in `main.tsx` **before the first render**, alongside the redirect and the
preset. A dark-mode user would otherwise get a white flash on every load.

### The dark set was incomplete

26 alias tokens were light-only in the dark block. Most are theme-neutral (radii,
durations, easings), but four were real defects on a dark canvas:

- `--dsw-alias-scrollbar-bg-l1/l2` resolved to `neutral-200` (rgb 229) — a nearly
  white scrollbar thumb on a `neutral-bluish-950` surface, i.e. effectively invisible.
  Re-pointed at the ramp's dark steps (`neutral-800` / `neutral-700`), which already
  existed in the file.
- `--dsw-alias-button-tool-bar-fill` was `rgba(84,85,87,0.5)`, a light-grey wash.
- `--dsw-alias-state-success-primary` / `-warn-primary` were the 500 steps, tuned for
  a white background.
- `--dsw-elevation-*` shadows are physically invisible on dark. The dark set now leans
  on a stroke plus a deeper, tighter shadow.

### A layout regression the screenshot caught

The dark screenshot showed the tab row overflowing: **"Settings" was clipped behind
the collapse button**. Eight tabs (Settings + Models split out in plan/80) no longer
fit a narrow dock, and `.tabList` was `display: flex` with no `overflow`, so the last
tab simply fell outside the box. Fixed with `overflow-x: auto` on the row,
`scrollbar-width: none` (a visible bar inside a 28px row would cost more height than
the tabs), `flex: none` on labels (otherwise flexbox squeezes every label to ellipses
before overflow engages), and end padding so the last tab does not butt against the
collapse button.

This is worth recording because **no test would have caught it**: every tab existed,
was clickable, and had the right label. Only looking at the rendered pixels revealed
that one was outside its container. `verify-settings` §1 now asserts that all eight
tabs lie inside the row's bounding box, so the mechanism is protected even though the
discovery was visual.

### Acceptance

`scripts/verify-settings.mjs` — **63/63** (up from 47), twice. New §4:

- light sets `data-theme=light` and computes a bright canvas;
- clicking **Dark in the UI** sets `data-theme=dark`, and the canvas becomes
  **measurably darker** and the ink colour **inverts** — asserted on computed colours,
  not on the attribute, because an attribute-only test would have passed in the broken
  state too;
- `color-scheme` reports `dark` so native widgets follow;
- the scrollbar no longer resolves to the light `rgb(229,229,229)`;
- dark survives a reload, and the stored value is the **intent** (`"dark"`), not a
  frozen palette;
- **System** stores `"system"` and resolves to whatever the OS currently prefers;
- §1 also asserts all eight tabs sit inside the tab row.

### Corrected assertion scope

Two leak assertions scanned `document.body.textContent`, which includes the
**transcript** — where this workspace's agent has legitimately printed
`No .workflow directory found at D:\模型测试\4.1f`. Those assertions were failing on
honest chat output that has nothing to do with the panel under test. Both now scope to
the panel's own subtree, with a `scoped: true` assertion proving the scan found a
non-empty region rather than silently passing on an empty selector.

## §14 — The web client is Simplified Chinese (plan/83)

The whole user-visible surface was localized in place: **no i18n framework**, because
the request was a Chinese UI, not a language switcher. A framework would add a runtime
layer and a key registry with no requirement behind either, and every one of these
strings is client-authored and fixed.

### What carries user copy

`notices.ts` (47 sentences), `right-rail.tsx`, `workspace-sidebar.tsx`,
`remote-pi-shell.tsx`, `settings-panel.tsx`, `model-providers-panel.tsx`,
`plan-panel.tsx`, `changes-panel.tsx`, `automations-panel.tsx`, `plugins-panel.tsx`,
`states.tsx`, `session-list.tsx`, `session-viewer.tsx`, `transcript-panel.tsx`,
`model-picker.tsx`, `slash-menu.tsx`, `markdown.tsx`, `stats-pills.tsx`,
`modal.tsx`, `connection-launcher.tsx`, `connect-client.tsx`, `view-model.ts`,
`theme-mode.ts`, `theme-presets.ts`, `pages/docs-page.tsx`.

### Terminology, arbitrated between two independent translators

host=主机 · workspace=工作区 · session=会话 · turn=**这轮对话** · relay=中继 ·
pairing code=配对码 · daemon=守护进程 · palette=配色 · skill=技能 ·
thinking level=思考级别 · working tree=工作树 · automation=自动化 · plugin=插件 ·
model=模型 · provider=提供方 · accent preset=强调色预设 · appearance=外观 ·
behaviour=行为 · dock tabs 会话/计划/文件/更改/插件/自动化/模型/设置.

Two rules survived review and are worth keeping:

- **`turn` is 这轮对话, not 该轮次.** 轮次 is meeting-minutes Chinese and reads stiff in
  a chat surface. Both reviewers converged on this independently.
- **`The host did not X` keeps 主机 as the subject.** Dropping it (「工作区启动失败」)
  destroys the only diagnostic fact a remote tool conveys: *where* the failure
  happened. One reviewer had proposed the shorter form and self-scored it as a loss.

### What is never translated

Wire literals (`delivered`, `woke_and_delivered`), action names, `data-*` attributes,
CSS-module class names, variable and function names, element ids, and **comments**
(developer-facing). A translated comparison operand would silently break logic; a
translated `data-*` would break every acceptance script at once.

### Three real defects the localization exposed

Translating the UI meant every acceptance script that selects a control **by its
visible label** broke. Repairing them one by one was not busywork: three of the
failures were not translation fallout at all.

1. **Dock lazy-loading triggers were never wired.** `onPlanTabOpen`,
   `onPluginsRefresh` and `onChangesRefresh` existed on the props type and were
   documented as the reason those panels refresh on open — and nothing ever called
   them. Plan/Plugins/Changes rendered from an empty cache until an unrelated action
   happened to populate it. `handleDockTabChange` now fires all three, plus
   `onModelsReload` and `onSettingsReload` (which had the same gap and were showing
   their *error* state after any reconnect).
2. **Four sidebar rows were permanently dead controls.** `onOpenPlugins`,
   `onOpenAutomations`, `onOpenModels`, `onOpenSettings` were declared on
   `WorkspaceSidebarProps`, rendered, and never passed by anyone — so those rows were
   always `disabled` and explained themselves with a width message the user could not
   act on *at any width*. They now route through `openDock(tab)`.
3. **`verify-sessions-hang` pinned a workspace with no sessions.** Its own comment
   says the pin exists so the baseline is "a property of this run", but it named
   `4.1f` unconditionally. It now walks the running workspaces and keeps the first
   that actually reports rows.

### Measurement traps hit again

- `innerText` mangled `Sessions` into `Se ion` (the app's font applies ligatures), so
  two probes silently read nothing. `textContent` throughout.
- `CDP targets.find(t => t.type === "page")` returned a blank tab; every probe then
  answered from `about:blank`. The suites now prefer the tab whose URL matches the app.
- A `page.navigate` to `/remote-pi/connect` leaves the launcher, which has neither
  sidebar nor dock; the app shell is `/`.

### Suites

| suite | result |
|---|---|
| `verify-settings` | **68/68** |
| `verify-models-config` | **44/44** |
| `verify-buttons` | **50/50** |
| `verify-automations` | **47/47** |
| `verify-changes` | **30/30** |
| `verify-web-skills` | OK |
| `verify-sessions-retry` | **7/7** |
| `verify-sessions-hang` | **7/7** |
| `verify-sessions-20x` | blocked by environment — see below |

**Assertion strength only increased.** Every replaced literal is a Chinese selector or
a Chinese regex; none became more permissive. Two assertions were *tightened* while
being retargeted: `3g` scoped from `document.documentElement` to the settings panel
(the transcript legitimately names installed packages), and `8a` now walks to the
nearest ancestor that actually holds panel text instead of hopping a fixed three
levels — a fixed hop silently picked an **empty** wrapper as soon as the markup moved.

### Known environment limitation

`verify-sessions-20x` restarts the daemon once per iteration and pairs a fresh
browser. On this machine the **English baseline crashes the same way** (verified by
`git stash`), and `verify-automations` currently fails its model-catalog assertions
because the `4.1f` workspace Pi does not answer `list_models` — also reproduced on the
English baseline. Both are environment defects, recorded here so a future run does not
re-diagnose them as localization regressions.
