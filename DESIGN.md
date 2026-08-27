# DESIGN.md — Deck UI style guide

Source of truth for the desktop app's look & feel (`desktop/`). The patterns
below were extracted from the stylesheet validated by user feedback on `main`
(`desktop/src/renderer/src/styles.css`). Read this BEFORE creating or modifying
any UI (new view, dialog, button, badge, banner…) and reuse these recipes
instead of inventing new ones. One stylesheet for the whole renderer:
`desktop/src/renderer/src/styles.css` — no CSS-in-JS, no inline styles (except
truly dynamic values like a per-session colour).

## 1. Design tokens

Everything themable goes through CSS variables declared on
`[data-theme='dark']` / `[data-theme='light']`. **Never hardcode a grey** —
use the variables so both themes keep working.

| Variable       | Dark      | Light     | Role                                   |
| -------------- | --------- | --------- | -------------------------------------- |
| `--bg`         | `#181818` | `#f3f3f3` | Window background                      |
| `--bg-2`       | `#202020` | `#ffffff` | Panels, sidebar, tiles, modals         |
| `--bg-3`       | `#2a2a2a` | `#e8e8e8` | Inset surfaces, neutral buttons        |
| `--fg`         | `#e4e4e4` | `#1f1f1f` | Primary text                           |
| `--fg-dim`     | `#9a9a9a` | `#6a6a6a` | Secondary text, ghost buttons, meta    |
| `--border`     | `#333`    | `#d4d4d4` | 1px separators and control borders     |
| `--accent`     | `#4488ff` | `#2563eb` | Blue — primary actions, active/selected|
| `--accent-fg`  | `#fff`    | `#fff`    | Text on accent                         |
| `--danger`     | `#e05555` | `#c23b3b` | Red — destructive                      |
| `--selected`   | `#2d3b52` | `#d8e6ff` | Selected row background                |
| `--glow`       | `#d4a24a` | `#b8860b` | Gold — attention-glow halo (see §5)    |
| `--action-prompt` | `#e0b341` | `#b07d10` | Yellow — "compose / insert a prompt" |
| `--action-expand` | `#a06bff` | `#7c3aed` | Violet — "maximize / restore a tile" |
| `--select-arrow` | data URI | data URI | Chevron drawn for `<select>` (see §4)  |

Layout tokens: `--gap: 8px`, `--radius: 8px` (containers), base font 13px
(`ui-sans-serif` stack). Controls (buttons, inputs) use radius **6px**; small
inline elements 4px; pills `999px` (badges) or 10–12px (chips, peer tag).

**`--mono`** is THE monospace face — ids, code panes, diffs, logs, terminal
metadata. It is theme-independent, so it lives on `:root` and not in the two
colour blocks. Write `font-family: var(--mono)`; never paste a stack. Four
inconsistent stacks used to coexist in one window while 16 selectors asked for
a token nobody had declared, so two different monospace faces rendered side by
side. A dead token is invisible: `var(--x)` with **no fallback** on an
undeclared `--x` is invalid at computed-value time, the property becomes
`unset`, and `background: var(--bg-1)` simply paints nothing (that shipped for
20 days across git, Explorer and diff surfaces). `tests/desktop-css-tokens.test.ts`
is the guard: every token consumed under `desktop/src` must be declared in a
stylesheet or listed there as runtime-injected from TypeScript.

## 2. Colour semantics

Colour is meaning. Do not repurpose these:

- **Blue `var(--accent)`** — accept / validate / primary action ("Add peer",
  "Create", "Save", restore-workspace primary), active nav item, selected
  tile/row, focus border, thinking pulse.
- **Orange `#e08a3c`** — restoration actions ("Restore previous",
  template "Apply"). Filled, white text. (Worktree "orphan" warning uses the
  close `#e08a2e`.)
- **Red `var(--danger)`** — destructive: filled for the confirming action of a
  deletion (`.primary.danger`, `.ws-btn-danger`, `.template-del`), red
  text/border outline for row-level destructive actions (`.wt-actions
  .danger`, `.rm-detail-actions .danger`, `…-danger:hover` on ghosts). The
  template trio's "Cancel" red is `#e0655b`.
- **Purple `#a06bff`** — "Use template" (distinct from restore orange);
  violet `#b678ff` = "needs you" attention pulse.
- **Green** — positive states: `#3ec46d` running dot, `#2f7d4f` success toast.
- **Amber** — transient/warning states: `#e0b341` starting dot & "local"
  badge, `#9a6700` info toast.
- **Banner red `#a03030`** — full-width outage banner (state, not event).
- **Gold `var(--glow)`** — the "enchanted glyph" attention halo (§5). User-
  configurable (AppConfig.glowColor); never reuse it for anything but
  attention effects.

**Tile-head action tones.** The four actions that repeat in every terminal head
(agent AND supervisor) are colour-coded at rest, because four identical grey
glyphs in a row are unreadable at a glance: yellow `var(--action-prompt)`
insert a prompt · blue `var(--accent)` open the browser view · violet
`var(--action-expand)` maximize/restore · red `var(--danger)` close. Hover keeps
the tone and only brightens it (`filter: brightness(1.15)`) — swapping the
colour for `--fg` on hover would erase the coding. Classes: `.tile-btn-prompt`,
`.tile-btn-browser`, `.tile-btn-expand`, `.tile-btn-danger`. Yellow here is
`--action-prompt`, deliberately NOT `--glow` (which stays the attention halo).

**Syntax colours are OUTSIDE this system** (card `526665f7`). Exactly two
surfaces wear `.shiki-code`: the Files viewer (`ExplorerView.tsx`) and the diff
colorizer (`DiffText` in `DiffPanel.tsx`). A THIRD read-only code surface
exists and is deliberately untouched, the fenced code blocks of a roadmap card
description (`RoadmapItemModal.tsx`): they stay plain text. On the two coloured
surfaces, the token colours come from the VS Code `light-plus` / `dark-plus`
palettes, not from the tokens above. That is deliberate: those colours describe
a GRAMMAR (keyword, string, comment), not a product meaning, so they never
carry a Deck semantic and must never be reused as decoration elsewhere. Two
consequences worth knowing before touching them:

- **The theme switch is a pure CSS flip.** Shiki emits the light colour inline
  on each token and the dark one in the `--shiki-dark` custom property; the
  rule `[data-theme='dark'] .shiki-code span` swaps them. Its `!important` is
  load-bearing, not sloppiness: an inline style outranks every selector, so
  nothing else can win. Nothing re-tokenises on a theme change.
- **In a diff, structure and syntax are two independent layers.** The `+`/`-`
  marker and the tinted background keep saying added/removed (they are not
  spans, so the flip rule leaves them alone), while the code after the marker
  carries the syntax colours. A file whose language is unknown keeps the
  structural layer alone and renders as plain text, never an empty view.
- **Colour has a main-thread price, and it is capped.** Tokenising is
  synchronous (~4.2 ms per KB, measured in the renderer), so a big file freezes
  the whole window. Two caps in `@shared/code-lang` bound it, 64 KB per block
  and 256 KB per request; above them the surface stays plain text. Never widen
  a cap to colour one stubborn file.

## 3. Controls: nothing keeps its native look

**Rule zero for controls: an element that still looks like the OS drew it is a
bug**, exactly like an emoji in JSX. This covers EVERY interactive element, not
just buttons — `<button>`, `<select>`, `<input>`, `<textarea>`, radios,
checkboxes, range sliders. The native Windows/Chromium defaults (grey button,
square white dropdown, blue focus ring) ignore `data-theme` entirely, so one
unstyled control makes a whole view read as unfinished. Two ways to satisfy it:
give the element an archetype class, or rely on a rule that already targets it
(the element-level `select`, `textarea` and `input[type='radio']` rules,
`.modal-actions button:not(.primary)`, `.field input`). Still native and NOT
covered by any element rule as of 2026-08-27: `input[type='checkbox']` (11
sites, card `0d57a60c`). If you introduce a control type this guide does not cover yet, style
it at the ELEMENT level in `styles.css` and document it here — a per-instance
class only fixes the instance you were looking at, and the next one ships bare.

### Keyboard focus

The "blue focus ring" half of rule zero is answered ONCE, at element level:

```css
:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
```

It names no class on purpose — a control written tomorrow is themed the day it
is written. `:focus-visible` and not `:focus`, so a mouse click paints nothing.
The recipe is the same accent outline as `.graph-node.is-selected`: "this is the
element in play" already looks like that here.

A control may override it, and several text inputs do (they suppress the outline
and swap `border-color` instead). If you write such an override, give it a
visible focus affordance of its own — suppressing the outline and swapping
nothing leaves the control with no keyboard affordance at all. Note the
specificity: a bare `:focus-visible` is `(0,1,0)`, so any `.class:focus` beats
it, but a `.class { outline: none }` in a BASE rule only wins by source order.

Every `<button>` MUST match one of these archetypes — a bare, unstyled
`<button>` (native grey) is a bug. Either give it an archetype class or place
it in a container whose stylesheet rule styles descendant buttons (e.g.
`.modal-actions button:not(.primary)`).

| Archetype | Class(es) | Recipe | Use for |
| --- | --- | --- | --- |
| Primary | `.primary` | filled `--accent`, white text, no border, radius 6, padding 7px 12px, weight 500 | THE validating action of a view/dialog (aim for one per context) |
| Secondary | `.btn` | `--bg-3` fill, 1px `--border`, `--fg`, radius 6, padding 7px 12px | any standard action that is not the primary one (refresh, export, close…) |
| Compact secondary | `.btn.btn-sm` | same, padding 3px 8px, font 12px | dense rows, inline toolbars |
| Restore | `.btn-restore` (or legacy `.restore-prev`, `.btn-apply`) | filled `#e08a3c`, white text | restoration actions |
| Danger (confirm) | `.primary.danger`, `.ws-btn-danger` | filled `--danger`, white text | the confirming button of a destructive dialog |
| Danger (outline) | `.btn.danger` (scoped variants: `.wt-actions .danger`, `.rm-detail-actions .danger`) | secondary base, red text + red-mixed border | destructive action inside a row/list |
| Danger (icon) | `.icon-btn.danger` | `.icon-btn` base, same red text + red-mixed border as `.btn.danger` | a delete/trash GLYPH in a row (graph list…) — red at rest, a hover-only red reads as neutral |
| Ghost | `.tile-btn`, `.row-btn`, `.mode-btn`, `.icon-btn`, `.context-menu-item`, `.settings-tree-item` | transparent (or `--bg-3` for `.icon-btn`), `--fg`, hover reveals | icon buttons, per-row hover actions, menus |
| Chip | `.chip` | `--bg-3`, border, radius 12, padding 3px 10px, font 12 | preset/token pickers |

State rules (apply to every archetype):

- **Hover**: filled buttons → `filter: brightness(1.08)`; neutral/ghost →
  background swap (`--bg` ↔ `--bg-3`) and/or `--fg-dim` → `--fg`. Always guard
  with `:not(:disabled)` when the button can be disabled.
- **Disabled**: `opacity: 0.4` (0.45–0.5 accepted), `cursor: default`, no
  hover filter.
- Buttons never keep the native border/background: set both explicitly.

**The scoped danger variants in the table above are NOT portable, and this is
the one trap that kills a correct archetype class silently.** `.wt-actions
.danger` and `.rm-detail-actions .danger` score `(0,2,0)`; they work only
because those rows are not inside a `.modal-actions` footer. `.modal-actions
button:not(.primary)` scores `(0,2,1)`, two classes plus one element, so it
repaints every non-primary footer button neutral and BEATS the copied recipe.
Measured twice on the Courrier decline button (2026-08-13): the `(0,2,0)`
attempt still computed `rgb(228,228,228)`; `.modal-actions.inbox-modal-actions
button.danger` at `(0,3,1)` computes `rgb(224,85,85)` = `--danger`. The
recipe itself is `color: var(--danger); border-color: color-mix(in srgb,
var(--danger) 50%, transparent);` with **no** danger-specific `:hover`, since
the archetype's base hover carries it.

**How to check:** after adding ANY semantic colour to a button sitting in a
container that has its own `button` rule, read `getComputedStyle(el).color` on a
real render. Reading the stylesheet proves the rule EXISTS, never that it
APPLIES, and a typecheck, a test and a diff review are all blind to it. Same
failure shape as a className matching no selector at all, different cause.

## 4. Recurring primitives

- **Status dots** (`.dot`): 9px circle — green running, amber starting, grey
  exited, accent pulse "thinking", violet pulse "needs you".
- **Badges**: pill (`border-radius: 999px` or 8–10px), 1px border, 10–11px
  font. Colour = border+text tint, not fill (e.g. `.ws-badge-current` accent,
  `.ws-badge-locked` danger, `.wt-badge-orphan` orange). Counter badges on nav
  icons (`.nav-rail-badge`) are filled accent, 9px bold.
- **Toasts** (`.toast`): fixed bottom-center, white text, filled green
  (success) or amber (info). Transient EVENTS only.
- **Status banner** (`.status-banner`): fixed top, full-width, filled dark red
  — persistent STATE (e.g. broker offline). Actions inside use
  `.status-banner-action` (translucent white outline). A dismissed banner must
  leave a red indicator on the nav rail until the state clears.
- **Modals**: `.modal-backdrop` (45% black) + `.modal` (`--bg-2`, radius 8,
  padding 20). Footer = `.modal-actions` right-aligned; its non-`.primary`
  buttons are auto-styled as Secondary — order: neutral Cancel left, coloured
  action right. Popovers (`.popover`) are the 420px variant. Header =
  `.modal-head` (flex row, gap 8, `h2` 15px `flex: 1`), which pushes trailing
  icon buttons — the close cross — flush against the modal's own 20px padding.
  Per-modal twins exist (`.rm-detail-head`, `.usage-head`); a new dialog should
  take `.modal-head` rather than mint a third. Never align that cross with a
  `margin-left: auto` or an offset: the title's `flex: 1` is the mechanism.
- **Empty states**: centered `.empty-card` (`--bg-2`, border, radius 8) with
  `h2` + dim paragraph + `.empty-actions` row.
- **Inputs**: `--bg` fill, 1px `--border`, radius 4–6, padding 6px 8px,
  `font: inherit`; focus = `border-color: var(--accent)` (no outline ring).
- **Selects / dropdowns**: styled at the ELEMENT level (`select { … }`) so a new
  dropdown is themed the day it is written — same box as an input, plus
  `appearance: none` and a hand-drawn chevron (`--select-arrow`, per theme)
  since the native arrow cannot be themed. Consequences to respect: (a) a
  scoped rule must NEVER re-declare the `background` shorthand or the chevron
  disappears — set `background-color` only, or nothing at all; (b) the right
  padding (24px) reserves the chevron's lane, so a scoped `padding` must keep
  it; (c) the popup list is OS-drawn — `select option { background: var(--bg-2) }`
  is what stops it flashing white. Scoped classes should carry SIZE only
  (`max-width`, `font-size`), never the box.
- **Radios**: styled at the ELEMENT level too (`input[type='radio'] { … }`),
  same reason as `select` -- `accent-color` alone was the previous answer and
  it only repaints the CHECKED dot, so the unchecked state, which is what most
  radios show at rest, stayed native. `appearance: none`, then a 14px disc
  (16px inside a `.field-check` row, whose equal-specificity rule wins on
  source order, so the element block must sit BEFORE `.field-check input`),
  `border-radius: 50%`, `--bg` fill, 1px `--border` ring turning `--accent`
  when checked. The centre dot is a `background-image: radial-gradient` over
  the disc's own fill, for two reasons worth keeping: (a) Chromium renders NO
  generated content inside an `<input>` (a replaced element), so an `::after`
  dot is simply invisible; (b) an inset `box-shadow` ring would force
  hardcoding the PARENT surface colour, and these radios sit on two of them
  (`--bg-2` in a modal, the panel in Settings), so one of the two would show a
  seam. Hover must be guarded by `:not(:checked)`, or a checked radio loses its
  accent border under the cursor; `:disabled` is the shared `opacity: 0.4` +
  `cursor: default`. Focus is NOT redefined here: the global `:focus-visible`
  rule already paints the accent outline and follows the 50% radius. One trap
  when reusing this on another control: `appearance: none` does not clear
  Chromium's UA margin, so `margin: 0` makes the container's `gap`
  authoritative and TIGHTENS any row that was relying on both (`.tc-lead-toggle`
  had to go from 3px to 6px).
- **Collapsible side panels.** The reference implementation is the **Agents
  sidebar** (`.sidebar` / `.sidebar-collapsed`, `Sidebar.tsx`, card
  `079f034d`) — copy that one. It now has two siblings, both built on it: the
  roadmap filter panel (card `7a2e76c6`) and the graph conversation list (card
  `67c21dd5`), which share the rail token `--panel-rail-w` (58px, a sum
  recomputed for a lone control, not a copy of the sidebar's). The filter
  panel's `filterPanelOpen` WAS the PRE-standard pattern this rule replaces —
  it unmounted the panel conditionally, which is exactly what (a) forbids — and
  it is gone from the tree; the history is kept here because it is the clearest
  illustration of why (a) exists. One instance of that pattern is still LIVE and
  is not a sibling of the two above: the graph TIMELINE (`showTimeline` /
  `.graph-timeline` in `GraphView.tsx`), a different panel from the conversation
  list, still mounts conditionally and is still toggled from the floating
  `.graph-zoomctl` toolbar rather than from itself. It is out of scope of the
  cards named here; treat it as the last conversion left, not as a precedent.
  The collapse control lives ON THE PANEL, in the panel's own header,
  never in a distant toolbar. Four consequences, none optional. (a) The panel is
  rendered PERMANENTLY with a modifier class, never mounted/unmounted
  conditionally: a panel that disappears takes its control with it and leaves
  nothing to click to bring it back. (b) Collapsed, it keeps a narrow rail;
  expanded, the label reappears beside the SAME control, at the SAME screen
  position. One control, one position, two states, one gesture to learn.
  (c) The rail's width is not a constant to copy but a SUM to recompute:
  the Agents rail is **70px** (`--sidebar-rail-w`, and it was 58 until the role
  glyph of card `b5ba8cac` added an occupant) because it carries per-row signals
  (status dot, role glyph, team-lead laurel) and not a lone glyph. That
  divergence from `--panel-rail-w`'s 58 is exactly why the two stayed two
  tokens. Read the sum from the token's own comment in `styles.css`, never from
  this paragraph. A rail that leaves
  one pixel of slack overflows the day a scrollbar appears. Size it on its
  widest row, then leave real margin; suppress the scrollbar inside the rail
  (`scrollbar-width: none` + `::-webkit-scrollbar`) since a native bar steals a
  third of it — hiding the bar does not disable wheel scrolling. Anything that
  keeps LOCAL state (a draft in a `useState`) must be hidden with `display:
  none` rather than dropped from the tree, or collapsing silently destroys what
  the operator typed. (d) Corollary: two controls for one state is an
  affordance defect, not a convenience. Genesis, worth more than the bare
  rule: the roadmap filter panel already had a fully wired toggle, but parked
  at the far end of the top bar and showing a CROSS while the panel was open.
  Next to an "Add" button, a cross reads "close the view", not "hide the
  filters", so the operator, who uses that panel daily, asked for a feature
  that already existed. A misplaced affordance is not merely discreet, it is
  misleading. The sign itself stays an SVG glyph of the house family (§5),
  never an emoji — here the diptych pair `GLYPH_ACTIONS.panelFold` /
  `panelUnfold`, drawn as two mirrored entries so the frame and its hinge stay
  put while only the chevron changes direction.
- **Split button** (`.rm-stop-split`, first instance, card `aaf4537d`): two
  `.icon-btn`s in an `inline-flex` span, left face `border-radius: 6px 0 0 6px`,
  right face `0 6px 6px 0` plus `margin-left: -1px` so the two borders merge
  into one control. The right face only FLIPS the mode, it never fires; the
  action that fires is always the glyph currently shown on the LEFT face, so
  the control never asks the operator to remember a hidden state. The modes
  must differ by SHAPE (square stop vs shears), not by colour alone, or the
  control stops being readable in monochrome and for a colour-blind operator.
- **Headers of full views** (`.worktrees-head`, `.roadmap-head`,
  `.settings-head`…): flex row, `h2` 15px, actions right-aligned after a
  flex spacer, bottom border.
- **Frame resize handle.** A handle for dragging a panel's edge (e.g. the
  top edge of a stacked panel): the panel is `position: relative`, the handle
  `position: absolute; top/left/right: 0`, 6px thick, `cursor: row-resize` (or
  `col-resize` for a vertical edge), background `var(--accent)` at 0.4 opacity
  on hover. The panel's `overflow: hidden` (needed for its `border-radius: 8px`)
  is why the handle sits flush at `top: 0` rather than straddling the edge with
  a negative margin: a negative-margin handle would be clipped in half by that
  `overflow: hidden`, while a flush absolute box stays entirely inside the clip
  box, so the header does not shift by a pixel — and the clip rounds the
  handle's own ends to the frame's radius, so it reads as part of the frame,
  not as a rectangle glued on top. Moving a handle changes which element owns
  pointer events at that edge: check the header's own controls stay clickable
  along their top edge, not only at their center.

## 5. Iconography — the Greek glyph set

**Rule zero: the UI never uses emoji.** Every icon — rail destinations, action
buttons, badges, kind marks — is a hand-drawn SVG glyph from
`desktop/src/renderer/src/components/icons.tsx` (no emoji, no icon font, no
external set). Four registries cover every need; pick from them before drawing
anything: `GLYPHS` (view destinations), `GLYPH_ACTIONS` (generic actions),
`GLYPH_BADGES` (identity/state marks), `GLYPH_KINDS` (roadmap types). The only
tolerated non-SVG icons are abstract typographic characters (`✴ ◆ ✦ ⌂ ◇ ⎇ ›`)
in contexts where SVG cannot render (see the JSX/string rule below).

Visual language: **VS Code activity-bar contrast, Greek-glyph metaphors**
(Κορυφαῖος, the chorus leader — temple, theatre mask, armillary sphere,
scroll, labyrinth, constellation, olive branch, volumen, winged tablet,
caduceus, laurel, scales of Themis, xiphos, clepsydra, Olympic torch; git
keeps the universal branch graph). When adding a NEW icon, propose a metaphor
from this world first, and fall back to the universal shape only when the
mythological reading would hurt recognition (the SCM branch-graph precedent).

Rules for drawing a NEW glyph (follow them or the set stops looking like one
hand drew it):

0. **A glyph is a JSX ELEMENT, not a component**: `const IconX = (<Svg>…</Svg>)`,
   registered as `IconX` and rendered `{GLYPH_BADGES[key]}` — never `<Glyph />`.
   Writing it as a function typechecks in isolation and fails only at the call
   site, with a misleading "not a valid JSX element type".
1. Inline `<svg viewBox="0 0 24 24">` through the local `Svg` wrapper:
   `fill="none" stroke="currentColor"`, `stroke-width 1.5`, round caps/joins.
   Sizing/layout live in CSS, never in the SVG. **The `width="20"` on the
   wrapper is NOT the rendered size and never the number to use in width
   arithmetic**: `svg.glyph { width: 1em }` (`styles.css`) wins, and `:root` is
   fixed at 13px, so a glyph renders **13x13** and an `.icon-btn` holding one
   measures 33px border-box (13 + padding 9+9 + border 1+1). Reading the
   attribute instead inflates every rail sum by 7px.
2. **Stroke-only.** The single allowed fill is the small `Dot` accent
   (constellation stars, ellipsis). Never hardcode a colour — `currentColor`
   is what makes the dim/active/hover states and the glow work for free.
   Two sanctioned data-fill exceptions, both clipping a translucent rect
   inside the glyph's own silhouette:
   - fill LEVEL encodes live data (the amphora gauge, `AmphoraGauge`) — the
     colour rides `currentColor` via tone classes
     (`.usage-ok/.usage-warn/.usage-hot`), never a hex in the SVG;
   - fill PRESENCE encodes a blocking state (the sandbox pithos,
     `PithosGlyph`, amber inside when the shared auth volume has no Claude
     credentials, so agents cannot spawn). Here the strokes must keep the
     rail's dim/active tone while only the inside changes, so `currentColor`
     cannot carry it: the rect takes a class the stylesheet colours
     (`.glyph-fill-warn`, amber `#e0b341` per §2) — still no hex in the SVG.
3. Keep ~1.5–2px of margin inside the 24-grid, centre optically, prefer
   primitive shapes (`path`/`circle`/`rect`) with round numbers.
4. Pick a metaphor consistent with the mythology (when it stays readable —
   SCM's branch graph beats lore) and register the glyph in `GLYPHS`
   (`Record<GlyphName, …>`: adding a `DeckView` without a glyph is a compile
   error).
5. **A glyph is judged at 13px or not at all.** It is drawn on a 24 grid and
   rendered at 13 (rule 1), and a drawing that reads at 24 fails at 13 in three
   measured ways that no amount of tuning at full size reveals. Measured
   2026-08-27 on card `b5ba8cac`: 3 of 6 new glyphs failed the first pass and
   were redrawn.
   - **It becomes a LETTER.** An upright hammer (head bar + shaft) reads as a
     capital **T**; dividers with a hinge bar read as a capital **A**. This is
     the worst failure in an icon set, because the eye parses it as text. Fix by
     breaking the symmetry (tilt the object 45°) or by changing metaphor.
   - **Concave curves fill in.** Strands sagging toward an anchor (quadratic `Q`
     with an inward control point) merge into a blob. Use circular `A` arcs
     bulging AWAY from the anchor; they keep their gap.
   - **Two glyphs converge.** Circle plus tail (Ariadne's clew) reads as the
     search magnifier. Fix by adding the convention the metaphor owns (winding
     arcs inside the ball) and by mirroring the composition.
6. **Fusing two ideas: find the shared primitive, do not compromise.** Asked
   for a funnel ("filter") fused with a hamburger ("fold this panel"),
   `IconMenu` was already `M4.5 7h15 M4.5 12h15 M4.5 17h15`, three equal bars,
   and a funnel IS those bars with a taper. The compromise did not exist; it was
   one drawing all along. Keep the taper FRANK (10 → 6 → 2): halved, it falls
   back to a bare hamburger, which says "a list", not "this panel folds".
7. **Two states = one constant OBJECT + one directional SIGN, drawn as two
   glyphs, never `transform: scaleX(-1)`.** Mirroring slides the hinge to the
   other side, so the eye reads a DIFFERENT panel instead of the same one
   changing direction. The object says WHAT folds, the chevron says the
   GESTURE, which is why reusing the pair's chevron keeps the gesture identical
   across panels while the object legitimately differs. Reusing that chevron
   means the same relative segments TRANSLATED, not the literal path string: the
   `panelFold` chevron sits inside a frame reaching x=20.5, so pasted into a
   frameless glyph it ends the composition at 16.5 in a 24 box and renders
   visibly small and left-heavy beside its rail neighbours.
8. **A "one leader + N followers" mark drawn FRONTALLY reads as a PAW PRINT**,
   and no amount of tuning removes it (discs to capsules, arc widened,
   flattened, gaps increased: four attempts, all refused). Two properties
   produce the signal and breaking either is enough: N small shapes ABOVE a
   large one centred at the bottom, and the small ones on a curve convex upward.
   Turn the axis instead: profile view, leader LEFT, followers on a vertical arc
   RIGHT opening toward him. **Render monochrome, flat fill, on mid-grey FIRST.**
   Colour hides this class of defect entirely at large sizes, and the mono
   pass is what delivers the verdict.

**Badge glyphs** (`GLYPH_BADGES`) mark identity/state, never actions: laurel
crown = team lead, scales of Themis = judge, crossed xiphos = battle,
clepsydra = waiting (rate-limit, queue), head profile = the operator's graph
node, Olympic torch lit/out = remote link reconnecting/gone, plus universal
marks (lock, warning, gear, capsa = workspaces, paperclip, archive, star,
checkboxes). **Kind marks** (`GLYPH_KINDS`) are the roadmap types (4-point
star, scarab, brick wall, oil lamp, broom), each tinted by a
`.kind-glyph-*` class so the kanban keeps colour scanning. Provider sigils
(`✴ ◆ ✦ ⌂ ◇`) stay typographic characters: abstract, monochrome, and they
must survive string contexts (`<option>`, concatenated labels) where SVG
cannot go — that is the rule: JSX context → glyph, string context →
character. `ContextMenu` labels accept JSX for this reason.

**Action glyphs** (`GLYPH_ACTIONS`): generic UI actions (close, edit, trash,
refresh, search, copy, plus/minus, fit, back/forward, camera, target, code,
external…) share the same stroke language but stay universal shapes — the
mythology is reserved for destinations (rail `GLYPHS`) and identity moments
(the snippets thunderbolt). Sizing: `svg.glyph` renders at **1em**, so a glyph
inherits its host button's font-size exactly like the text character it
replaced — set the button's `font-size`, never the SVG's. Never leave a raw
character (`✕`, `⟳`, emoji) in a button: pick from `GLYPH_ACTIONS` or add one
following the rules above.

**Attention glow** ("fantasy glyph"): a rail entry with `.is-glowing` pulses
its glyph — gold halo `var(--glow)` + a subtle accent-blue inner sheen
(`glyph-glow` keyframes; static fallback under `prefers-reduced-motion`).
Semantics: *an agent/the supervisor awaits the operator* (inbox draft,
running companion). The colour is user-configurable in Settings > Appearance
(`AppConfig.glowColor`, sanitized to hex by `sanitizeGlowColor`, applied as
an inline `--glow` on `<html>` by App.tsx; `''` = theme default
`DEFAULT_GLOW` in `shared/palette.ts`).

## 6. Checklist when adding / modifying UI

1. Reuse an existing archetype/primitive; only add a new CSS class when no
   recipe fits, and derive it from the tokens above.
2. No control left native — `<button>`, `<select>`, `<input>`, `<textarea>`,
   checkbox alike (§3). Buttons take an archetype class or a styled container;
   everything else must be covered by an element-level rule. Always define
   hover + disabled states. Open the view in the app and look for the tell:
   a square white box or a grey OS button means the rule is missing.
3. Blue = validate, orange = restore, red = destroy. Check the colour matches
   the meaning, not the other way round.
4. Test both themes (`data-theme` dark/light): no hardcoded greys/whites
   outside the semantic colours listed here.
5. User-visible labels go through i18n (`useT()`): add the key to
   `desktop/locales/en.json`, `desktop/locales/fr.json` AND `EN_DEFAULTS` in
   `desktop/src/main/i18n.ts` (parity is test-enforced).
6. New rules go in `desktop/src/renderer/src/styles.css`, in the section
   commented for the component you touch (create a `/* ---------- X */`
   section if needed) — keep the file's comment style.
7. **Never an emoji.** Any icon need goes through the glyph registries of
   `icons.tsx` (§5) — reuse first, draw a new Greek-styled glyph second;
   an emoji character in JSX is a bug, like a bare `<button>`.
