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

Layout tokens: `--gap: 8px`, `--radius: 8px` (containers), base font 13px
(`ui-sans-serif` stack). Controls (buttons, inputs) use radius **6px**; small
inline elements 4px; pills `999px` (badges) or 10–12px (chips, peer tag).

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

## 3. Button archetypes

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
| Ghost | `.tile-btn`, `.row-btn`, `.mode-btn`, `.icon-btn`, `.context-menu-item`, `.settings-tree-item` | transparent (or `--bg-3` for `.icon-btn`), `--fg-dim`, hover reveals | icon buttons, per-row hover actions, menus |
| Chip | `.chip` | `--bg-3`, border, radius 12, padding 3px 10px, font 12 | preset/token pickers |

State rules (apply to every archetype):

- **Hover**: filled buttons → `filter: brightness(1.08)`; neutral/ghost →
  background swap (`--bg` ↔ `--bg-3`) and/or `--fg-dim` → `--fg`. Always guard
  with `:not(:disabled)` when the button can be disabled.
- **Disabled**: `opacity: 0.4` (0.45–0.5 accepted), `cursor: default`, no
  hover filter.
- Buttons never keep the native border/background: set both explicitly.

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
  action right. Popovers (`.popover`) are the 420px variant.
- **Empty states**: centered `.empty-card` (`--bg-2`, border, radius 8) with
  `h2` + dim paragraph + `.empty-actions` row.
- **Inputs**: `--bg` fill, 1px `--border`, radius 4–6, padding 6px 8px,
  `font: inherit`; focus = `border-color: var(--accent)` (no outline ring).
- **Headers of full views** (`.worktrees-head`, `.roadmap-head`,
  `.settings-head`…): flex row, `h2` 15px, actions right-aligned after a
  flex spacer, bottom border.

## 5. Iconography — the Greek glyph set

The navigation rails (desktop rail, mobile tabs/sheet) use a custom icon set
in `desktop/src/renderer/src/components/icons.tsx`, NOT emoji and NOT an icon
font. Visual language: **VS Code activity-bar contrast, Greek-glyph
metaphors** (Κορυφαῖος, the chorus leader — temple, theatre mask, armillary
sphere, scroll, labyrinth, constellation, olive branch, volumen, winged
tablet, caduceus; git keeps the universal branch graph).

Rules for drawing a NEW glyph (follow them or the set stops looking like one
hand drew it):

1. Inline `<svg viewBox="0 0 24 24">` through the local `Svg` wrapper:
   `fill="none" stroke="currentColor"`, `stroke-width 1.5`, round caps/joins.
   Rendered at 20px by the wrapper; sizing/layout live in CSS, never in the SVG.
2. **Stroke-only.** The single allowed fill is the small `Dot` accent
   (constellation stars, ellipsis). Never hardcode a colour — `currentColor`
   is what makes the dim/active/hover states and the glow work for free.
3. Keep ~1.5–2px of margin inside the 24-grid, centre optically, prefer
   primitive shapes (`path`/`circle`/`rect`) with round numbers.
4. Pick a metaphor consistent with the mythology (when it stays readable —
   SCM's branch graph beats lore) and register the glyph in `GLYPHS`
   (`Record<GlyphName, …>`: adding a `DeckView` without a glyph is a compile
   error).

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
2. No bare `<button>`: archetype class or styled container, always with hover
   + disabled states.
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
