# Embedded browser & design feedback (experimental)

An embedded web browser for web-front work, opened two ways:

- **Rail entry `🌐 Browser`** — full-width browser: URL bar, back/forward,
  reload (Shift-click bypasses the cache), page DevTools, open in the system
  browser. The last URL is remembered (`http://localhost:3000` by default).
- **`🌐` button on an agent tile** — the same browser with that agent's
  terminal **docked on the left** (resizable split): the classic "agent on
  one side, live site on the other" web-design loop. The docked terminal is a
  second view of the same PTY — the original tile keeps its scrollback, and a
  resize nudge makes Claude's TUI repaint into the dock.

Pages load in an isolated `persist:deck-browser` partition; `window.open` /
`target=_blank` links open in the system browser, never in new Electron
windows.

## Element picker (`⌖`)

Click it, then click any element in the page: a description (tag, size, best
selector — `data-testid`-style attributes preferred over structural CSS
paths — and visible text) is pasted into the docked agent's prompt
(bracketed paste, nothing auto-submitted): complete the sentence and press
Enter. With no docked agent the description is copied to the clipboard.
`Esc` cancels.

The pasted description carries an `[element context]` block beyond the base
sentence: role/accessible name, allowlisted attributes, computed styles
(filtered of their default values so only signal remains), nearby sibling
text, a readable ancestor path, and a capped `outerHTML` snippet — the agent
usually has enough to locate and restyle the element without a follow-up
screenshot. Every field is optional and best-effort; an older external
deck-design client still works with none of them. Secrets never reach the
prompt: attribute/id/text/HTML values matching a credential-like pattern
(`api_key`, `csrf`, `password`, …) are redacted or the field is dropped
outright, and every URL (page URL, `href`/`src`) has its query string and
fragment stripped. This is applied twice — once in-page as the pick is built,
once again at the design endpoint on the untrusted POST body from an external
app — so a compromised or malicious page cannot smuggle a token past a single
check. When the picked element belongs to a React app in a DEV build, the
block also carries the surrounding component stack (`react: <App> >
<ProductCard>`) and the JSX source location (`source:
src/ProductCard.tsx:42:7`) pulled from React's dev-only debug metadata — both
absent in production builds and on React 19+, which removed that metadata.

A cropped screenshot of the picked element is captured automatically and
appended to the prompt as a saved path for the agent to `Read` — same
`annotations/` folder under app state and 7-day pruning as draw mode below.
It is absent for picks made through an external design-endpoint app (no
capture capability there) and whenever the capture, crop, or save step fails
for any reason (a busy or torn-down page): the base description is still
delivered, silently, without a screenshot.

While inspect mode is armed, two hover shortcuts skip the click entirely: `C`
picks the currently hovered element without ever dispatching a click at the
page, so a state that collapses on click (an open dropdown, a hover menu)
survives into the captured description; `S` sends just a screenshot of the
hovered element, no page-context prompt. `S` needs the embedded browser's
capture pipeline — the external deck-design client simply ignores the key
and stays armed.

### Pick-context dialog

After a single pick — an inspect-mode click, the `C` hover shortcut, or a pick
delivered through an external design-endpoint app — a modal asks for an
optional note plus an optional intent and priority before the description is
delivered. Sending with nothing filled in yields exactly the previous prompt,
byte for byte. A filled-in note's lines (`note:`, then `intent:`, then
`priority:` when given) land at the top of the `[element context]` block,
ahead of `role:`/`source:` and the rest. The element screenshot capture (see
above) runs while the dialog is open and is awaited on send, so it is still
attached even though the operator took a moment to type. `Esc`, clicking the
backdrop, or Cancel discard the pick — nothing is pasted or copied. A "Don't
ask again" box in the dialog and a matching toggle in Settings both write
`pickContextPrompt` (persisted in the Deck config, default on) to skip the
dialog on future picks. The `S` screenshot-only shortcut and review
(annotate) mode are unaffected — they keep delivering exactly as before.

### Review mode (Chantier OD5)

A second toolbar toggle turns the one-pick-one-prompt flow above into a
batch review: arm it and every pick (click or `C`) pins a new annotation
instead of exiting inspect mode, up to 20 per page — further picks are
refused with a toast until one is sent or removed. Each pinned element gets
its own comment, an intent (`fix` / `change` / `question` / `approve`) and a
priority (`blocking` / `important` / `suggestion`), edited in a right-hand
panel over the webview that never covers the docked terminal. `Esc` in the
guest disarms picking but leaves the panel and its drafts untouched — the
toggle re-arms picking to keep adding elements. "Send review" folds every
pinned element (selector, source/react context, bounds, styles, HTML,
auto-screenshot when captured, and the operator's comment) into ONE
structured `## Design Feedback` message, pasted or copied exactly like a
single pick; "Discard" clears the batch without sending anything. Switching
away from the Browser view (unmounting `BrowserView`) loses any pending
draft — accepted for this first version, same as any other unsaved-in-memory
UI state in the Deck.

### Persistence

The review panel's pending annotations survive a window reload or app
restart: written to `review-pending.json` under the app's state directory
(`main/review-state-service.ts`), debounced ~300ms after every change to
`pendingAnnotations`, and cleared immediately (not waiting on the debounce)
on Send or Discard. Loaded once on mount and validated STRICTLY: any single
bad item, or a screenshot path that fails a containment/existence check,
fails the WHOLE load rather than restoring a half-good draft — a review is
one unit the operator composed together. A missing file is the normal
"nothing was ever saved" state and stays silent; any other load or save
failure (corrupt file, main's validator refusing a save) reports to the
renderer's error log and surfaces as a toast, never a silent catch.

### Roadmap cards

Two ways a review finding becomes a roadmap card instead of a prompt
(`shared/pick-card.ts`), neither touching the docked agent. The pick-context
dialog's "Create a card" seeds a roadmap DRAFT (`openRoadmapDraft`) from the
single pick and its note and switches to the Roadmap view — nothing is
written until the operator saves it there, and the pick is consumed by the
draft rather than delivered as a prompt. The review panel's "Create cards"
instead creates one card PER pinned finding directly (`roadmapUpsert`, one
call each, in order), after a confirmation naming the count. Intent maps to
roadmap kind (`fix`→bug, `change`→feature, `question`/`approve`→idea) and
priority to MoSCoW (`blocking`→must, `important`→should, `suggestion`→could).
Cards land in the Deck's project roadmap — the app-wide project, the same
scope the Roadmap view shows — and the review itself is left as-is
afterwards: cards and the agent prompt are complementary sinks for the same
findings, so the operator may still send the review too.

## Viewport presets

Render the page at a device size (iPhone SE, iPad, laptop…) centred in the
pane. The active preset is appended to every element and annotation prompt
(`[viewport: 375x667 – iPhone SE]`), so the agent knows which breakpoint you
were looking at.

## Draw mode (`✏`)

Sketch a region over the page on a canvas overlay — a red stroke, freehand or
circle (two toolbar toggles next to `✏`: freehand draws the path as-is,
circle inscribes an ellipse in the bounding box of the drag's start and end
point). Covers the feedback the element picker can't express ("this whole
block is misaligned").

**Every completed stroke pins its own region into the same review panel an
element pick fills** (see "Review mode" above) — draw mode has no send
button of its own any more; sending is the panel's "Send review". The moment
a stroke finishes (pointer up with at least two points, or a hold ending
mid-stroke — see below), it becomes a `region` annotation (bounds, tool,
page URL) alongside any pinned elements, with the same per-page cap (20),
comment/intent/priority fields, and "Discard" behaviour. The canvas itself
only ever shows the ONE in-progress stroke: the instant it is pinned the
overlay is cleared, exactly like a pick leaves no mark on the guest page. A
cropped screenshot of the stroke's own bounding box — padded for context,
with the stroke burned back onto the crop at the right position and scale —
is captured asynchronously and attached to the annotation, same
`annotations/` folder and 7-day pruning as the element picker's auto-shot.
Unlike that auto-shot, a FAILED region capture is not silent: the screenshot
is the region's only evidence (there is no selector or HTML to fall back
on), so a failure surfaces as a toast and the annotation stays pinned
without one. `⌫` clears the in-progress stroke; `Esc` exits the toolbar
toggle (armed strokes elsewhere — a hold in progress — are unaffected by
Escape, only the toolbar mode).

**Hold-to-draw**: holding Ctrl (Cmd on macOS) while the pointer is over the
page shows the draw canvas for as long as the key is held, WITHOUT entering
the toolbar's draw mode — the page stays interactive between holds, so a
quick region note doesn't require toggling a mode on and back off. Ending
the hold mid-stroke finishes it exactly like a pointer-up (the stroke is
pinned, not dropped) unless the toolbar draw mode is *also* active, in which
case the canvas stays up and the stroke keeps going. The modifier is watched
from TWO places and merged: the guest page's own document (the pointer
started over the page, before any canvas exists to intercept key events —
the `<webview>` guest is a separate process from the host window) and the
host window (once the canvas/toolbar has focus). Hold-to-draw applies to the
web pane only — the window-mirror's still isn't interactive, so only the
toolbar toggle (`✏`) applies there.

Draw mode and the review panel are no longer mutually exclusive: they can be
armed together (a stroke pins straight into a panel a review pick may
already be filling). Only the element picker (`⌖`, single-pick INSPECT mode)
stays mutually exclusive with both draw and review — picking and the
review-multi-pick guest listener share the same document-level hooks, and
the draw canvas overlay would swallow the guest's own pointer events
regardless.

## Window mirror (`🪟`)

The same pane can mirror **any OS window** (still capture, `⟳` refreshes):
pick a window, draw a region over the still with `✏` (freehand or circle)
and send it through the review panel, same as the web pane — see "Draw
mode" above. Design feedback on NATIVE apps — the Koryphaios window itself,
a Tauri build, anything — with zero integration in the target. Element
picking stays web-only; the sketch + the agent's multimodal `Read` answer
the "which element" question for native targets. Hold-to-draw does not
apply here (the still isn't interactive) — only the toolbar toggle does.
The embedded web page keeps its state while in window mode.

## Recording (REC)

The toolbar's REC button records a demo-ready video — a modal first asks for
the capture scope:

- **Browser pane only** — the embedded page (at the active viewport preset if
  one is set), for a demo of the site under development;
- **Whole Koryphaios window** — the full Deck, for a demo of Koryphaios
  itself (tiles, roadmap, supervisor… keep navigating: the recording follows).

While recording, the REC button pulses red with an elapsed-time readout and
the browser rail entry carries a red dot from every view. Clicking REC again
stops and saves the clip under the app-state `recordings/` folder (MP4 when
the runtime can mux it, WebM otherwise — both embed in a GitHub README); the
saved path is shown in a toast. Capture is served by the main process with
the Deck's own window only (no OS picker, no arbitrary-source access from the
renderer); the pane crop is computed renderer-side (`shared/recording.ts`).

### Scripted scenario (demo driver)

The dialog's optional **scenario** field turns the recording into an
agent-driven demo: describe what to show ("open the dashboard, create a
project named Demo…"), pick the model (Claude CLI targets only, Sonnet
default — remembered in `config.demoTarget`), and the Deck launches ONE
throwaway `claude -p` whose only capabilities are five `demo_*` MCP tools on
the embedded page: `demo_read` (structured snapshot: text excerpt +
interactive elements with stable selectors), `demo_navigate`, `demo_click`
and `demo_type` (real input events with human pacing, visible on the video),
`demo_wait` (viewer-pacing pauses). The recording auto-stops when the agent
reports the scenario done; stopping the recording cancels the agent.
`demo_navigate`/`demo_click`/`demo_type` results carry a self-review
`reminder` field once the agent has gone too long without a `demo_read`
(always after a navigation, or after 3 actions since the last read) — a
result-level nudge re-asserting the system prompt's contract at the moment
the agent actually drifts from it.

Security shape: the agent's bridge (`demo-browser-mcp.mjs`) talks to a
loopback endpoint + Bearer token minted PER RUN (`demo-control.ts`) — never
the supervisor's deck-control token; the harness is a code constant (C8), the
scenario text is framed as data; all file/shell/web tools are disallowed; a
120-step cap bounds runaway loops; selectors and texts coming back from the
agent enter page scripts JSON-encoded only, and navigation is restricted to
http(s).

## Design mode inside external apps (Tauri, Electron…)

Any webview-based app can join the element-picking loop **without being
embedded**:

1. At launch the app starts a **loopback design endpoint** (127.0.0.1,
   random port, Bearer token minted per launch) and injects
   `CLAUDE_DECK_DESIGN_URL` / `CLAUDE_DECK_DESIGN_TOKEN` into every session
   terminal it spawns. The claude-peers broker is never involved — picks are
   a strictly local loop.
2. Add the client script (`deck-plugin/design/deck-design.js`, built by
   `npm run build:design`) to the external app's **dev build** and hand it
   the env pair (Tauri `initialization_script`, or `<meta
   name="deck-design-url">` + `<meta name="deck-design-token">` + a script
   tag on a plain page).
3. Launch the app **from a session terminal inside the window** (it inherits
   the env pair), press `Ctrl+Shift+D` in the app, pick an element: its
   description lands in the docked (else selected) agent's prompt, exactly
   like a pick from the embedded browser. The script stays inert when the
   env pair is absent — safe to leave in a dev build launched outside
   Koryphaios.
