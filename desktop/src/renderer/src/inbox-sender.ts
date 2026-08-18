// Card 55c5470e: pure sender-resolution logic for the Courrier operateur,
// extracted out of InboxPanel.tsx so it is unit-testable without pulling in
// react/react-dom/zustand (TESTING.md "0b" -- a root-level tests/ file may
// not bare-import those, only through desktop/tests-support/react-test-
// harness.ts, which pays a real DOM-mutation cost). This module imports
// NOTHING from react or the app store: it is plain data in, plain data out.
//
// WHY THIS EXISTS: `origin.tile_ref` on a blocking-question approval is
// UNTRUSTED routing metadata (shared/types.ts ApprovalOrigin.tile_ref doc) --
// it is declared by whatever produced the approval, which for the Notification
// hook path is a spawned agent's own environment. Before this card, the Deck's
// sender display trusted it (or a similarly unset `from_peer`) directly,
// degrading to a bare '?' with no way to tell "nobody claimed this" apart
// from "the field is simply absent". This module is the ONE place that
// decides what counts as a resolved sender: a `tile_ref` that matches a tile
// THIS Deck window actually holds right now (the same "re-validate against
// our own live tiles" property the reply path already relies on). Anything
// else is NEVER treated as a name -- it only ever reaches the caller inside
// the explicit "unresolved" shape, capped and stripped, so it cannot imitate
// a real tile label.

/** Longest raw `tile_ref` returned in the unresolved case. Cosmetic cap, not
 * itself the security boundary -- the boundary is that this value is never
 * classified as `resolved`. */
export const UNRESOLVED_TILE_REF_MAX = 32

/** Minimal shape this module needs from a live session/tile. */
export interface SenderTile {
  id: string
  name: string
}

export type ApprovalSenderResolution =
  | { resolved: true; name: string }
  | { resolved: false; raw: string }

/** Strip C0/DEL control characters and cap length, for display of an
 * otherwise-untrusted raw tile_ref. Never used for a value already deemed
 * `resolved`. */
export function sanitizeUnresolvedTileRef(raw: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately stripping C0/DEL
  const stripped = raw.replace(/[\x00-\x1f\x7f]/g, '').trim()
  return stripped.length > UNRESOLVED_TILE_REF_MAX
    ? `${stripped.slice(0, UNRESOLVED_TILE_REF_MAX)}…`
    : stripped
}

/**
 * Resolve an approval's sender against the renderer's live tile registry.
 * A match returns the tile's real name; anything else (no match, empty
 * tile_ref, a hostile/oversized value) returns the sanitized raw value
 * tagged `resolved: false` -- callers must render the two shapes visibly
 * differently and must never fall back to fabricating a name.
 *
 * Enforced by InboxPanel.tsx's `senderOf()`, the only place this
 * discriminated union is turned into DOM (name only vs a wrapped `<code>`
 * element); guarded by tests/desktop-inbox-sender-dom.test.ts, which mounts
 * the real component and asserts on the rendered DOM for all three shapes.
 */
export function resolveApprovalSender(
  tileRef: string | undefined | null,
  sessions: readonly SenderTile[]
): ApprovalSenderResolution {
  const ref = tileRef ?? ''
  // Strict equality on purpose, never startsWith/includes/a normalised
  // compare: `ref` is spawned-agent-controlled, so a value that only
  // guesses a PREFIX of a live tile id (partial leak, truncated log, brute
  // force) must not impersonate it. Pinned by
  // tests/desktop-inbox-sender.test.ts's "a tile_ref that is a PREFIX of a
  // real tile id does not resolve" case.
  const tile = ref ? sessions.find((s) => s.id === ref) : undefined
  if (tile) return { resolved: true, name: tile.name }
  return { resolved: false, raw: sanitizeUnresolvedTileRef(ref) }
}
