import type { Approval } from './approval-auth'

/**
 * Tiles whose Claude Code module is waiting on an operator verdict: an open
 * `hook` row draws nothing on screen, so the PTY detector cannot see it.
 * `tile_ref` is the producer's declaration, used only to find a tile we own.
 */
export function hookAwaitedTiles(approvals: readonly Approval[]): Set<string> {
  const tiles = new Set<string>()
  for (const approval of approvals) {
    if (approval.reply_route !== 'hook') continue
    if (approval.status !== 'pending' && approval.status !== 'expired_notif') continue
    if (approval.origin.tile_ref) tiles.add(approval.origin.tile_ref)
  }
  return tiles
}

export interface PendingApprovalsIo<Deps> {
  deps(): Deps | null
  fetchPending(deps: Deps): Promise<Approval[]>
  setHookAwaited(tiles: ReadonlySet<string>): void
  broadcastPending(list: Approval[]): void
  report(text: string, err?: unknown): void
}

/**
 * One tick of the pending-approvals poll. A broker the Deck cannot read is
 * waited on by no module it can reach, so the hook source drops rather than
 * freezing tiles in "needs you" (which refuses directives, pause and a
 * graceful close). A failure is reported once until a tick succeeds again.
 */
export function createPendingApprovalsTick<Deps>(io: PendingApprovalsIo<Deps>): () => Promise<void> {
  let lastSignature = ''
  let failing = false
  const fail = (text: string, err?: unknown): void => {
    io.setHookAwaited(new Set())
    if (failing) return
    failing = true
    io.report(text, err)
  }
  return async () => {
    const deps = io.deps()
    if (!deps) return io.setHookAwaited(new Set())
    let list: Approval[]
    try {
      list = await io.fetchPending(deps)
    } catch (e) {
      return fail('pending approvals poll failed: the tiles waiting on a module verdict are no longer flagged', e)
    }
    failing = false
    io.setHookAwaited(hookAwaitedTiles(list))
    const signature = list.map((a) => `${a.id}:${a.status}`).join(',')
    if (signature !== lastSignature) {
      lastSignature = signature
      io.broadcastPending(list)
    }
  }
}
