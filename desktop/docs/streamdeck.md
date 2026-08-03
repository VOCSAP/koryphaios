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
preference:

- **Reuse `companion-server.ts`.** It already does HTTPS + WebSocket + a
  pairing token + a per-run credential + an address allow-list, and it already
  bridges the whole `DeckApi` protocol (`shared/companion.ts`). A Stream Deck
  plugin is, protocol-wise, a very small companion client. Cost: the companion
  server is off by default and started by an explicit operator gesture, which
  is wrong for a peripheral that should work from app launch -- so this needs
  either a second start mode or a persisted "auto-start for local peripherals"
  setting, and that setting is a security decision (see below).
- A dedicated loopback-only WS server. Smaller blast radius, but duplicates the
  auth/pairing/journalling work that `companion-server.ts` already got right.
- Stdio/named pipe. Cleanest trust boundary, worst fit for the Elgato SDK,
  which is itself a WebSocket client by construction.

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

Source of truth: `desktop/src/main/attention.ts`. It already tracks which
sessions raised attention and already drives the in-app badge, so the plugin
needs a push of `{count, lastSessionId, lastSessionName}`, not a new mechanism.

Behaviour:
- Idle: dark key, Greek glyph, no count.
- One or more pending: key blinks, count rendered large.
- **Press: focus the app AND focus the session that raised the most recent
  attention.** This is the feature. A key that only shows a count is a worse
  notification than the taskbar already gives.

Focusing means `BrowserWindow.show()` + `focus()` on the main window, then the
existing in-app "select session" path. On Windows, `focus()` from a background
process is unreliable (foreground lock); expect to need
`setAlwaysOnTop(true)` + immediate `false`, or `app.focus({steal: true})`.
Verify on the actual OS, do not assume.

Open question: what "the last agent" means when two sessions raise attention
half a second apart. Resolve the object first (which session) then ask whether
the press may act on it -- the CLAUDE.md identity rule applies: a
`SELECT ... LIMIT 1` over attention events keyed by timestamp alone will pick
arbitrarily under a tie.

### 2. Roadmap workflow play/stop

One key, two states, driven by `dispatch.ts` (the workflow lane's dispatch
loop) and `roadmap-service.ts`.

- Shows `Play` when the lane has queued items and dispatch is idle.
- Shows `Stop` while a wave is in flight; pressing it interrupts.
- Shows a disabled/empty state when the lane is empty -- a key that looks
  pressable but does nothing is worse than a dark key.

The count of queued cards belongs on this key too (small, corner).

Depends on the existing dispatch pause/resume path actually being reachable
from main; if interrupting a wave is currently only expressible through the UI,
that plumbing is part of this card, not a precondition of it.

### 3. Git dirty count

Source: `worktree-service.ts:133` already computes uncommitted-change count via
`git status --porcelain`, and `diff-service.ts` parses the same output. Reuse,
do not re-shell.

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
