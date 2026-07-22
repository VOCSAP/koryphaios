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
4. **No bare `<button>`.** Native grey means the control was forgotten: give
   it an archetype class (`.btn` secondary is the default) or ensure a
   container rule styles it (`.modal-actions button:not(.primary)`). Always
   define hover (`:not(:disabled)`) and disabled (`opacity: 0.4`) states.
5. **Both themes.** Check dark AND light `data-theme`: no hardcoded greys;
   whites only on filled semantic buttons.
6. **Icons are Greek glyphs, not emoji.** Rail/tab icons come from
   `desktop/src/renderer/src/components/icons.tsx` (`GLYPHS[view]`): inline
   24-grid SVG, stroke-only `currentColor` 1.5, mythological metaphor —
   drawing rules in DESIGN.md §5. Adding a `DeckView` without registering a
   glyph is a compile error. The attention glow (`.is-glowing`, `--glow`,
   `glyph-glow` keyframes) is reserved for "an agent awaits the operator"
   semantics; its colour is the `glowColor` setting, never a hardcoded hex.
7. **Labels via i18n.** New user-visible text: key in `desktop/locales/en.json`
   + `fr.json` + `EN_DEFAULTS` (`desktop/src/main/i18n.ts`) — parity is
   test-enforced (`tests/i18n.test.ts`).
8. **Verify.** `npm run typecheck` in `desktop/`, `bun test` at the root (for
   locale parity), and eyeball the affected view in both themes if you can
   launch the app.

## Where things go

- CSS rules: `styles.css`, inside the `/* ---------- Section */` matching the
  component; keep the existing comment tone (explain intent, not syntax).
- If your change adds a pattern genuinely NEW to the app (a new archetype,
  a new semantic colour), update `DESIGN.md` in the same commit so the guide
  never drifts from the stylesheet.
