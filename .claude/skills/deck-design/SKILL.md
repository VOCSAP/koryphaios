---
name: deck-design
description: Visual/UI work on the desktop app (desktop/) — styling a button or view, picking colours, adding CSS, fixing an unstyled control, building a new dialog/badge/banner, or adding/altering a rail icon (the Greek glyph set). Routes through DESIGN.md (validated tokens, colour semantics, button archetypes, iconography) so the Deck keeps one coherent look. Use for any change touching styles.css, icons.tsx or a component's visual classes; NOT for broker/server work or non-visual renderer logic.
---

# Deck UI design workflow

All visuals of the desktop renderer live in ONE stylesheet
(`desktop/src/renderer/src/styles.css`) driven by theme variables. The
reference guide is **`DESIGN.md`** (repo root) — read it first, it is short
and authoritative (extracted from the user-validated `main` styles).

## Workflow

1. **Read `DESIGN.md`.** Identify which archetype/primitive covers your case
   (button archetypes §3, primitives §4, colour semantics §2, iconography §5).
2. **Reuse before inventing.** Grep `styles.css` for an existing class doing
   the same job (`.btn`, `.primary`, `.chip`, `.rm-badge`, `.modal-actions`…).
   Only mint a new class when no recipe fits, built from the tokens
   (`--bg-*`, `--fg-*`, `--accent`, `--danger`, radius 6/8).
3. **Colour = meaning.** Blue `--accent` accept/validate · orange `#e08a3c`
   restore · red `--danger` destroy · purple template · green/amber states.
   Do not repurpose a semantic colour for decoration.
4. **No control keeps its native look.** Not just buttons — `<select>`,
   `<input>`, `<textarea>`, checkboxes too. A grey OS button or a square white
   dropdown means the control was forgotten. Buttons: give an archetype class
   (`.btn` secondary is the default) or ensure a container rule styles them
   (`.modal-actions button:not(.primary)`). Everything else must be covered by
   an ELEMENT-level rule in `styles.css` (`select { … }`) so the next instance
   is themed the day it is written — a per-instance class only fixes the one
   you are looking at. Always define hover (`:not(:disabled)`) and disabled
   (`opacity: 0.4`) states. Careful with `<select>`: a scoped rule that
   re-declares the `background` shorthand erases the custom chevron
   (DESIGN.md §4).
5. **A collapsible panel carries its OWN collapse control.** Never a toggle in
   a distant toolbar (a cross next to "Add" reads "close the view", so the
   operator asked for a feature that already existed). The control sits in the
   panel's header; the panel is rendered PERMANENTLY with a modifier class,
   never mounted/unmounted, otherwise collapsing removes the control too;
   collapsed it leaves a narrow rail with the GLYPH ALONE, at the same screen
   position the expanded control occupies. Two controls for one state is an
   affordance defect (DESIGN.md §4). Stated as a rule, implemented NOWHERE
   yet: cards `6aef4c54` (roadmap filters) and `67c21dd5` (graph
   conversations) are the first two instances, not the rule itself.
6. **Both themes.** Check dark AND light `data-theme`: no hardcoded greys;
   whites only on filled semantic buttons.
7. **Icons are Greek glyphs — NEVER emoji, anywhere.** Every icon (view,
   action button, badge, roadmap kind) comes from the registries of
   `desktop/src/renderer/src/components/icons.tsx`: `GLYPHS` (destinations),
   `GLYPH_ACTIONS` (actions), `GLYPH_BADGES` (identity/state), `GLYPH_KINDS`
   (roadmap types) — inline 24-grid SVG, stroke-only `currentColor` 1.5,
   mythological metaphor first (drawing rules in DESIGN.md §5). Reuse before
   drawing; an emoji in JSX is a bug. Sole exception: string contexts
   (`<option>`, concatenated labels) take an abstract typographic character
   (`✴ ◆ ✦ ⌂ ⎇`) — and `ContextMenu` labels accept JSX, so menus use glyphs.
   Adding a `DeckView` without registering a glyph is a compile error. The
   attention glow (`.is-glowing`, `--glow`, `glyph-glow` keyframes) is
   reserved for "an agent awaits the operator" semantics; its colour is the
   `glowColor` setting, never a hardcoded hex.
8. **Labels via i18n.** New user-visible text: key in `desktop/locales/en.json`
   + `fr.json` + `EN_DEFAULTS` (`desktop/src/main/i18n.ts`) — parity is
   test-enforced (`tests/i18n.test.ts`).
9. **Verify.** `npm run typecheck` in `desktop/`, `bun test` at the root (for
   locale parity), and eyeball the affected view in both themes if you can
   launch the app.

## Looking at a glyph you just drew

The drawing LAWS are DESIGN.md §5 (rules 5 to 8: the three 13px failure modes,
the shared-primitive fusion, the no-mirror two-state family, the paw-print
trap). This is the procedure for actually seeing them, which no stylesheet audit
and no test can replace.

1. **Judge at real size first, then zoomed.** Private Electron instance on its
   OWN CDP port, never the operator's window:
   `./node_modules/electron/dist/electron.exe . --user-data-dir=<temp>
   --remote-debugging-port=<port>`. Then `Page.captureScreenshot` with
   `clip: {x, y, width, height, scale: 8}` over the rail. A glyph approved only
   at x8 has not been judged.
2. **Capture stalls forever, with no error**, when the window stops producing
   frames. `Page.bringToFront` alone is NOT enough: send
   `Emulation.setDeviceMetricsOverride {width,height,deviceScaleFactor}`
   immediately before the capture. That override CHANGES the viewport, so
   re-measure every `getBoundingClientRect()` taken after it.
3. **Measure the box after any glyph swap**: the rendered glyph must stay 13x13
   and its `.icon-btn` 33x27, or a rail sum breaks. `--panel-rail-w` has ZERO
   slack on the roadmap side, and its folded rule is `overflow: hidden`, so a
   control one pixel too wide is CLIPPED in silence rather than pushed.
4. **Both themes, both states.** A diptych pair is only proved by capturing
   folded AND unfolded.
5. **Kill it by PID**, resolved from the port you opened:
   `netstat -ano | grep '127.0.0.1:<port>' | grep -i listening`, then
   `taskkill //PID <pid> //T //F`. Never `taskkill //IM electron.exe` on a
   shared checkout, or another agent's review instance dies with it. `//T` does
   not reliably take PTY children: count stray `cmd.exe` before launching, or
   you cannot tell your leftovers from a colleague's shell.

Your renderer edit is NOT on anyone's screen until `npm run build` runs: the
running Deck serves `app.asar`. Check `ls -la desktop/out/main/index.js` against
your edit before believing a report of "no effect".

## Where things go

- CSS rules: `styles.css`, inside the `/* ---------- Section */` matching the
  component; keep the existing comment tone (explain intent, not syntax).
- If your change adds a pattern genuinely NEW to the app (a new archetype,
  a new semantic colour), update `DESIGN.md` in the same commit so the guide
  never drifts from the stylesheet.
