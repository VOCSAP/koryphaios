# Stream Deck + integration (intention, not shipped)

Status: **idea / nice-to-have**. Nothing below is implemented. This file exists
so the intent survives the session that produced it; the tracked work lives on
the shared roadmap (cards tagged `#streamdeck`).

Target hardware: **Elgato Stream Deck +** -- 8 LCD keys, 4 rotary encoders with
push, 1 touch strip. The encoders and the strip are what make the `+` worth
targeting specifically: they give continuous controls (scrub, select, tune) that
a plain key grid cannot express.

## Why this is not just "more buttons"

The Deck already has a nav rail, an operator inbox, a workflow lane. A Stream
Deck adds one thing those cannot: **an out-of-window surface**. Its value is
entirely in the moments when Koryphaios is NOT the focused window -- an agent
raising attention while the operator is in an editor, a workflow finishing while
they are in a browser. Any feature whose payoff requires the Deck to already be
on screen does not belong here.

Corollary: every key must be readable at a glance from 60 cm, and every press
must be a complete action, not the first step of one.

## Architecture sketch

Two halves, and the split matters:

1. **A Stream Deck plugin** (Elgato SDK, JS/Node, runs inside the Stream Deck
   software as a separate process). It owns the key rendering and receives the
   hardware events. It is NOT part of the Electron app and cannot import from
   it.
2. **A bridge endpoint in the Deck main process** that the plugin talks to over
   localhost. State pushes out (attention count, git dirty count, workflow
   state), commands come in (focus session, start/stop workflow).

The bridge is the real design decision. Three candidates, in order of
preference (**revised 2026-08-03 after reading the code** -- the first two
swapped places; card `e89f1239` carries the measurements):

- **A dedicated loopback-only WS server wired into `api-registry.ts`.** That
  module, not `companion-server.ts`, is the seam built for a second transport:
  its header says the same handler table serves both Electron IPC and the
  companion bridge, through `invokeRemote` / `sendRemote` / `addEventSink`. A
  plugin plugged in there reuses the whole `DeckApi` protocol and duplicates
  only the authentication.
- Reuse `companion-server.ts`. It does HTTPS + WebSocket + a pairing token + a
  per-run credential + an address allow-list, but three properties fight a
  peripheral: it binds to the LAN interface on an **ephemeral** port
  (`listen(0, lanAddr)`, so the plugin has nothing to discover), its pairing
  token travels in a **QR code** consumed by the first hello (no headless
  enrolment path), and `companion:start` / `stop` / `status` are themselves in
  `REMOTE_BLOCKED_CHANNELS`. It stays the reference for the security *model*
  (per-address lockout, journalled connect/deny, per-run credential) rather
  than code to reuse as-is. One property does help: `isPrivateAddress` already
  accepts `127.0.0.1` and `::1`, so a loopback client is not refused by the
  allow-list.
- Stdio/named pipe. Cleanest trust boundary, worst fit for the Elgato SDK,
  which is itself a WebSocket client by construction.

Naming trap: `desktop/deck-plugin/` **already exists** and means the *Claude
Code* plugin (hooks + the deck-control / demo-browser MCP servers). The Elgato
plugin must not live there, nor take a name that reads as the same thing.

Whatever is chosen, hostile-input rule #4 applies: any string arriving from the
plugin (session id, card id, directive name) is an untrusted agent-facing
string. Re-validate main-side against the live registry, never string-glue it
into a command.

Security note that must be answered before any code: **binding to loopback is
not authentication.** Any local process -- including a sandboxed agent that
escaped its container, or any browser page via a DNS-rebinding hop -- can reach
a loopback WS. The companion server's pairing token exists precisely for this.
Do not ship a bridge that accepts unauthenticated frames because "it is only
localhost".

## The keys

Ranked. The first is the one that justifies the whole thing.

### 1. Attention key (blinking, with pending count)

Source of truth: `desktop/src/main/attention.ts`. **Corrected 2026-08-03**: it
detects per-session episodes and emits `{ id, waiting, manual? }` -- there is no
aggregate count anywhere (`needsAttention` is a per-session boolean each
renderer component reads on its own) and no timestamp or sequence on the event.
So `{count, lastSessionId, lastSessionName}` is main-side state to *create*, not
a relay. Prefer a monotonic event counter over a millisecond timestamp: it gives
a total order, so the tie below cannot happen at all.

Behaviour:
- Idle: dark key, Greek glyph, no count.
- One or more pending: key blinks, count rendered large.
- **Press: focus the app AND focus the session that raised the most recent
  attention.** This is the feature. A key that only shows a count is a worse
  notification than the taskbar already gives.

Focusing already exists and ships: `index.ts:702-706` does
`mainWindow.show()` + `focus()` + `webContents.send('session:focus', id)` when
an attention notification is clicked. Measure *that* path from a third-party
process before reaching for `setAlwaysOnTop(true)` + immediate `false` or
`app.focus({steal: true})` -- the Windows foreground lock may or may not bite
here, and the existing code is the cheapest way to find out.

The press does need a new registered channel though: `session:focus` is
deliberately window-only (see the `api-registry.ts` header -- it bypasses
`broadcast`). Give the new channel a `CHANNEL_TIERS` entry and put it in
`REMOTE_BLOCKED_CHANNELS`: a LAN-paired phone yanking the host window to the
foreground is a host action, same class as `shell:open-external`.

Open question: what "the last agent" means when two sessions raise attention
half a second apart. Resolve the object first (which session) then ask whether
the press may act on it -- the CLAUDE.md identity rule applies: a
`SELECT ... LIMIT 1` over attention events keyed by timestamp alone will pick
arbitrarily under a tie.

### 2. Roadmap workflow play/stop

One key, three states, driven by `dispatch.ts` (the workflow lane's dispatch
loop) and `roadmap-service.ts`.

- Shows `Play` when the lane has queued items and dispatch is idle.
- Shows `Stop` while a wave is in flight; pressing it interrupts.
- Shows a disabled/empty state when the lane is empty -- a key that looks
  pressable but does nothing is worse than a dark key.

The count of queued cards belongs on this key too (small, corner).

**Settled 2026-08-03: that path does not exist.** `roadmap:dispatch`
(`ipc.ts:612`) covers Play, main-side and argument-free. `roadmap:stop`
(`ipc.ts:614`) takes a *card id* and stops one card; there is no pause, no wave
interrupt, no global halt. So this key now depends on card `aaf4537d` (Pause /
Soft Stop / Hard Stop in the In-progress header), which owns the semantics of
stopping, and it must consume exactly that path -- a physical key and a header
button that stop different things is the worst of both worlds. The three levels
also give the key more than two states; short press for the default level, long
press for the destructive one, current level readable at 60 cm.

### 3. Git dirty count

Source, **corrected 2026-08-03**: reuse the `worktree:list` channel
(`ipc.ts:659`), not the service function directly. It already returns, per
worktree, the `dirty` count from `worktreeStatus()` (`worktree-service.ts:140`
-- this page said `:133`, which is `isDeckWorktreePath`) *and* the attached
session, with the `canonicalPath` comparison on both sides already applied and
commented there. So: no new git shelling, no new canonicalisation, no new read
channel. `diff-service.ts` stays the reference for parsing untracked files.

Key shows the count for the **active session's** work dir (worktree-aware --
each agent may sit on its own worktree, so a single repo-wide number is the
wrong abstraction here). Press opens the Deck's diff review on that dir.

Cost note: polling `git status` per session per second is a real cost on large
repos. Piggyback on whatever cadence the diff view already uses, and push on
change rather than on a timer.

### 4. Encoder: session carousel

Stream Deck + specific. Rotate to scrub through the open session tiles, push to
focus the selected one. The touch strip shows the session name + its state
colour while turning.

This is the one control that a keyboard shortcut genuinely cannot replace:
selecting among N sessions is continuous, not discrete.

### 5. Encoder: usage / quota gauge

`usage-service.ts` + `quota.ts` already track per-provider consumption. Render
the current window's usage on the touch strip; rotate to cycle providers. No
press action -- pure telemetry, and that is fine.

## Explicitly out of scope for a first pass

- Sending prompts from the Stream Deck (no text input on the hardware; a
  canned-snippet key is a different, later feature).
- Per-key custom images configurable by the operator. Ship a fixed, correct
  icon set first (Greek glyph set from `components/icons.tsx`, rendered to PNG
  at build time -- the Elgato SDK wants raster).
- Any Stream Deck Mini/XL layout variance. Target the `+` and the `+` only.

## Icons

The DESIGN.md rules still apply, with one translation: the Deck's SVG glyph set
is the source, but the Stream Deck needs 72x72 (or 144x144 @2x) PNGs. Generate
them from `icons.tsx` at build time rather than hand-drawing a second set --
two icon sets drift, and the drift is invisible until someone notices the
Stream Deck is a version behind. No emoji, same as everywhere else.
