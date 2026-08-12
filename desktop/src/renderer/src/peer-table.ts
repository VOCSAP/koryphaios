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
 * Build the aligned `peer_id = role` table.
 *
 * Two populations are dropped, and both omissions are deliberate:
 *  - the SUPERVISOR, which is not an agent of the Agents list (the sidebar
 *    filters it out too -- filtering here as well keeps the table right even
 *    if a future caller forgets, rather than silently leaking it);
 *  - sessions with no `peerId` yet (still booting), which would otherwise
 *    produce a row whose left column is empty.
 *
 * Returns '' when nothing is left to show, so callers can treat the empty
 * string as "nothing to copy".
 *
 * @param sessions rows to render, in display order
 * @param youLabel marker appended to the team-lead row -- the table is meant
 *   to be pasted INTO the lead's prompt, so the lead is the reader. Comes from
 *   the dictionary (`sidebar.peerTableYou`), never a hardcoded literal.
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
