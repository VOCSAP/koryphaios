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
