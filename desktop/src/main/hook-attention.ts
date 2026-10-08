import type { Approval } from './approval-auth'
import { awaitsModuleVerdict } from '../shared/hook-await'

/**
 * Tiles whose Claude Code module is waiting on an operator verdict: an open
 * `hook` row draws nothing on screen, so the PTY detector cannot see it.
 */
export function hookAwaitedTiles(approvals: readonly Approval[]): Set<string> {
  const tiles = new Set<string>()
  for (const approval of approvals) {
    if (awaitsModuleVerdict(approval)) tiles.add(approval.origin.tile_ref)
  }
  return tiles
}

export interface PendingApprovalsIo<Deps> {
  deps(): Deps | null
  fetchPending(deps: Deps): Promise<Approval[]>
  setHookAwaited(tiles: ReadonlySet<string>): void
  broadcastPending(list: Approval[]): void
  /** No list could be read this tick: a consumer holding the last one must drop it. */
  pendingUnavailable?(): void
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
  // The next readable list is broadcast even if it equals the last one, so a consumer that dropped it gets it back.
  const unavailable = (): void => {
    io.setHookAwaited(new Set())
    io.pendingUnavailable?.()
    lastSignature = ''
  }
  const fail = (text: string, err?: unknown): void => {
    unavailable()
    if (failing) return
    failing = true
    io.report(text, err)
  }
  return async () => {
    const deps = io.deps()
    if (!deps) return unavailable()
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
