// Card c8ee5732 -- the peer roster as pasteable plain text.
//
// Renders `peer_id = role` for every agent of the window, aligned on the `=`,
// so the operator can hand a freshly spawned team its own directory in one
// click instead of retyping it row by row. Kept as a PURE function with a
// structural row type (no `@shared/types` value import) so it stays loadable
// under `bun test` from the repo root, where the `@shared/*` alias is not
// mapped.

/**
 * Structural shape of what the table needs from a session. `SessionRuntime`
 * satisfies it; declaring it structurally keeps this module dependency-free.
 */
export interface PeerTableRow {
  peerId: string | null
  name: string
  lead?: boolean
  supervisor?: boolean
}

/**
 * Drops the supervisor and any session with no peerId yet (still booting), so
 * the table only lists ready agents.
 * Returns '' when nothing is left, so callers can treat the empty string as
 * nothing to copy.
 * @param youLabel comes from the dictionary, never a hardcoded literal -- the
 * table is pasted into the lead's own prompt.
 */
export function formatPeerTable(sessions: readonly PeerTableRow[], youLabel: string): string {
  const rows = sessions.flatMap((s) =>
    s.peerId && s.supervisor !== true
      ? [{ peerId: s.peerId, name: s.name, lead: s.lead === true }]
      : []
  )
  if (rows.length === 0) return ''
  const width = Math.max(...rows.map((r) => r.peerId.length))
  return rows
    .map((r) => `${r.peerId.padEnd(width)}  = ${r.name}${r.lead ? ` ${youLabel}` : ''}`)
    .join('\n')
}
