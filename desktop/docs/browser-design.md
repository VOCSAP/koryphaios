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

## Viewport presets

Render the page at a device size (iPhone SE, iPad, laptop…) centred in the
pane. The active preset is appended to every element and annotation prompt
(`[viewport: 375x667 – iPhone SE]`), so the agent knows which breakpoint you
were looking at.

## Draw mode (`✏`)

Sketch freehand over the page (red strokes on a canvas overlay), then `📸`:
the page screenshot is composited with your strokes, saved as a PNG under app
state (pruned after 7 days), and its file path is pasted into the docked
agent's prompt — the agent `Read`s the image and sees exactly what you
circled. `⌫` clears the sketch, `Esc` exits. Covers the feedback the element
picker can't express ("this whole block is misaligned").

## Window mirror (`🪟`)

The same pane can mirror **any OS window** (still capture, `⟳` refreshes):
pick a window, annotate the capture with `✏`, send with `📸`. Design feedback
on NATIVE apps — the Koryphaios window itself, a Tauri build, anything —
with zero integration in the target. Element picking stays web-only; the
sketch + the agent's multimodal `Read` answer the "which element" question
for native targets. The embedded web page keeps its state while in window
mode.

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
