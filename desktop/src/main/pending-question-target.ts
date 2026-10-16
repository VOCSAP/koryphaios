import { awaitsModuleVerdict, type HookAwaitRow } from '../shared/hook-await'

export interface PendingQuestionRow extends HookAwaitRow {
  id: string
  created_at: string
}

export interface PendingQuestionSession {
  id: string
  needsAttention: boolean
}

export type PendingQuestionTarget =
  | { kind: 'inbox'; approvalId: string }
  | { kind: 'tile'; id: string }
  | { kind: 'none' }

/**
 * Where the oldest question waiting on the operator is answered. A hook row
 * goes to its tile, whose answer panel opens on focus; a hook row naming no
 * live tile has no panel to open, so it falls back to the Courrier, which
 * lists every pending row. Without any open row, the first tile flagged as
 * waiting, in the service's own order.
 */
export function pendingQuestionTarget(
  rows: readonly PendingQuestionRow[],
  sessions: readonly PendingQuestionSession[]
): PendingQuestionTarget {
  const open = rows.filter((row) => row.status === 'pending' || row.status === 'expired_notif')
  let oldest: PendingQuestionRow | undefined
  for (const row of open) {
    if (!oldest || row.created_at.localeCompare(oldest.created_at) < 0) oldest = row
  }
  if (oldest) {
    const tile = oldest.origin.tile_ref
    if (awaitsModuleVerdict(oldest) && sessions.some((s) => s.id === tile)) return { kind: 'tile', id: tile }
    return { kind: 'inbox', approvalId: oldest.id }
  }
  const waiting = sessions.find((s) => s.needsAttention)
  return waiting ? { kind: 'tile', id: waiting.id } : { kind: 'none' }
}
