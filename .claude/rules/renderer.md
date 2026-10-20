---
paths:
  - "desktop/src/renderer/**"
---

# Deck renderer

Tokens, `--banner-h` and the visual archetypes: `DESIGN.md` and the `deck-design` skill.

- Never build a new array or object inside a store selector (`useDeck((s) => s.sessions.filter(...))`); select the raw reference and derive in the component body.
  Why: zustand v5 compares snapshots with `Object.is`, so a fresh array each call loops the render ("getSnapshot should be cached"), and the typecheck stays green.
- Give an icon-only element its accessible name with `<span role="img" aria-label={t(...)}>` wrapping the glyph alone; a native `<button>` or `<a>` takes `aria-label` directly (precedent `SettingsView.tsx`).
  Why: `aria-label` on a role-less `<span>` is ignored, and `role="img"` on a wrapper replaces all of its text content.
- An entry point that opens a fresh editor or form bumps a `useRef(0)` nonce and passes `key={identity ?? 'new-' + nonce.current}`; every entry point shares that ref (`composerNonce` in `TemplatesDialog.tsx`).
  Why: the same component at the same position with structurally equal props does not remount, so its `useState` seed survives.
- Every `className` written in a component has a rule in `styles.css`; grep it before shipping.
  Why: no test or lint catches an orphan class, and one shipped with a header at the wrong height.
- Text or a control that can sit at the bottom-right of the viewport or of a bottom tile keeps `padding-right: 52px` (precedent `.wf-manual-hint`), and its visibility is proven with `document.elementFromPoint` at its centre and corners on a real render.
  Why: the fixed `.help-fab` paints over that corner, and a stylesheet read cannot see an overlap.
