// This module is the one place that decides what counts as a resolved sender: a
// tile_ref matching a tile this Deck window currently holds.
// tile_ref is untrusted routing metadata from whatever produced the approval;
// anything else is never treated as a name, only surfaced capped and stripped
// as unresolved.

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
 * A match returns the tile's real name; anything else returns the sanitized raw
 * value tagged resolved: false.
 * Callers must render the two shapes visibly differently and never fall back to
 * fabricating a name.
 */
export function resolveApprovalSender(
  tileRef: string | undefined | null,
  sessions: readonly SenderTile[]
): ApprovalSenderResolution {
  const ref = tileRef ?? ''
  // Strict equality only, never startsWith/includes: ref is
  // spawned-agent-controlled, so a value that merely guesses a prefix of a live
  // tile id must not impersonate it.
  const tile = ref ? sessions.find((s) => s.id === ref) : undefined
  if (tile) return { resolved: true, name: tile.name }
  return { resolved: false, raw: sanitizeUnresolvedTileRef(ref) }
}
