/**
 * Which approval rows a Claude Code module is waiting on, and for which tile.
 * One predicate for the main process (the tile's attention flag) and the
 * renderer (the tile's answer panel), so the badge and the panel cannot
 * disagree. Structural types and no imports: both sides and bun:test load it
 * as is.
 */

export interface HookAwaitRow {
  reply_route: string
  status: string
  origin: { tile_ref: string }
}

/** `tile_ref` is declared by the producer, never proven: it decides where the badge and the verdict panel show. */
export function awaitsModuleVerdict(row: HookAwaitRow): boolean {
  return (
    row.reply_route === 'hook' &&
    (row.status === 'pending' || row.status === 'expired_notif') &&
    row.origin.tile_ref !== ''
  )
}

/** The rows one tile waits on, oldest first: the module answers them in turn. */
export function hookRowsForTile<R extends HookAwaitRow & { created_at: string }>(
  rows: readonly R[],
  tileId: string
): R[] {
  return rows
    .filter((row) => awaitsModuleVerdict(row) && row.origin.tile_ref === tileId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
}
