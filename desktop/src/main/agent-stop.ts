// Pure module, no electron/node-pty import, so bun test can exercise
// broadcastStop against a fake StopDeps.
// StopMode/StopOutcome/StopReport are mirrored by value in the renderer's
// AgentStopControls component: rename a field here only alongside that copy.

import type { SessionRuntime } from '@shared/types'
import { resolveDirectiveTargets } from './directive'

/**
 * pause: bare ESC, not idle-gated, but GATED on screen-state (card 120148eb)
 * -- its own contract is reversible, so it refuses ('refused-modal') rather
 * than risk quitting the CLI on a modal-showing tile.
 * hard: bare ESC, not idle-gated, NOT gated -- its contract is to end the
 * session by force, right now, so the same worst case is in-contract.
 * soft: idle-gated conversation-turn injection.
 */
export type StopMode = 'pause' | 'soft' | 'hard'

export const STOP_MODES: readonly StopMode[] = ['pause', 'soft', 'hard']

/**
 * Fail-closed, not a deny-list: only the literal 'hard' skips the interrupt
 * gate.
 * Every other value, including any future StopMode, maps to 'pause'.
 */
export function toInterruptMode(mode: StopMode): 'pause' | 'hard' {
  return mode === 'hard' ? 'hard' : 'pause'
}

export type InterruptResult = 'interrupted' | 'no-terminal'

/** Mirrors SessionService.injectCommand's DirectiveOutcome (session-service.ts). */
export type InjectOutcome = 'written' | 'no-terminal' | 'busy-timeout' | 'refused-modal'

export interface StopOutcome {
  /** Tile id. Always present -- unlike peerId, which is null until the peer registers. */
  id: string
  peerId: string | null
  /**
   * 'error' is not produced by interrupt()/injectCommand() themselves (they
   * never throw) -- it is broadcastStop's own translation of a REJECTED
   * promise (Promise.allSettled 'rejected' branch), so one throwing tile
   * still gets a truthful entry instead of silently vanishing from the vector.
   */
  result: InterruptResult | InjectOutcome | 'error'
}

export interface StopReport {
  mode: StopMode
  outcomes: StopOutcome[]
  /**
   * Requested peerIds with no live, peer-resolved tile to stop -- malformed,
   * dormant, absent, or ambiguous (several live tiles share the id)
   * (resolveDirectiveTargets's `missing`, same meaning as executeDirective's).
   * Only ever non-empty when `peerIds` was passed: the peerIds-absent
   * ("everyone") path has nothing to report as missing. Omitted rather than
   * `[]` when there is nothing to show.
   */
  missing?: string[]
  /**
   * Absent/partial in 'soft' mode: a soft stop asks, it does not touch the
   * lock table. Built by the IPC layer (ipc.ts), not by broadcastStop --
   * lock-park/lock-release don't exist broker-side yet, so `error` carries
   * that failure instead of blocking the stop primitive itself.
   */
  locks: { parked?: number; released?: number; error?: string }
}

/** Injected dependencies: keeps this module free of electron/node-pty imports. */
export interface StopDeps {
  /**
   * Full SessionRuntime (not a narrowed {id, peerId} shape): the peerIds-present
   * path delegates to resolveDirectiveTargets, which needs `status` to exclude
   * exited tiles the same way executeDirective's live sessions already do.
   */
  list(): SessionRuntime[]
  /**
   * `mode` (card 120148eb) so the real implementation (SessionService.interrupt,
   * session-service.ts) can gate Pause on the same screen-state guard
   * injectCommand uses while leaving Hard unguarded -- see that method's own
   * doc for why. broadcastStop below always passes its own `mode` through
   * verbatim; there is no separate un-gated overload to fall back to.
   */
  interrupt(id: string, mode: StopMode): InterruptResult | 'refused-modal'
  injectCommand(id: string, command: string): Promise<InjectOutcome>
  journal(line: string): void
}

export interface StopDispatchResult {
  outcomes: StopOutcome[]
  missing: string[]
}

/** pause/hard touch the roadmap lock table (park/release); soft only asks. */
export function stopTouchesLocks(mode: StopMode): boolean {
  return mode === 'pause' || mode === 'hard'
}

/**
 * The peer_ids to lock-park/lock-release: derived from `outcomes` (what was
 * ACTUALLY dispatched to), never from a fresh service.list() -- a caller
 * re-deriving from the live tile set would park/release cards for tiles this
 * broadcast never touched (review round, correction 1/N4).
 */
export function lockTargets(outcomes: StopOutcome[]): string[] {
  return [...new Set(outcomes.map((o) => o.peerId).filter((p): p is string => p !== null))]
}

/**
 * Soft-stop injects a conversation turn rather than acting on the PTY directly,
 * unlike pause/hard.
 * Kept to a single line with no embedded newline for readability in the
 * terminal, not correctness.
 */
export const SOFT_STOP_MESSAGE =
  'Operator soft stop: finish the current turn, then stop. Do not start new work. ' +
  'Before stopping, release any roadmap card you hold (set it back to planned and clear your lock), ' +
  "and send your team-lead a one-line report of where you stopped."

/**
 * peerIds absent, present-and-empty, and present-and-non-empty are three
 * distinct cases: absent targets every live tile, present-and-empty is refused
 * rather than treated as "everyone", present-and-non-empty targets exactly
 * those peers.
 * Uses Promise.allSettled so one throwing or slow tile never blocks another's
 * outcome.
 */
export async function broadcastStop(
  mode: StopMode,
  deps: StopDeps,
  peerIds?: string[]
): Promise<StopDispatchResult> {
  if (peerIds !== undefined && peerIds.length === 0) {
    throw new Error(
      'broadcastStop: peerIds, when provided, must be non-empty -- omit it for "all tiles", never pass an empty array to mean that'
    )
  }
  const all = deps.list()
  let targets: Array<{ id: string; peerId: string | null }>
  let missing: string[]
  let ambiguous: string[] = []
  if (peerIds === undefined) {
    // The header button: every LIVE tile, peer-resolved or not -- a tile
    // whose peer hasn't registered yet is still a real process worth
    // stopping. Unlike the peerIds-present path below, matching is by tile
    // (not by peerId), so resolveDirectiveTargets (which requires a
    // peer-resolved session to ever match) doesn't apply here; exited tiles
    // are filtered the same way executeDirective's `live` set is (correction 3).
    targets = all.filter((s) => s.status !== 'exited')
    missing = []
  } else {
    // Delegates target resolution to resolveDirectiveTargets rather than a
    // hand-rolled filter.
    // That resolver assumes a real string[] and throws on a non-string element;
    // a non-string peerId here is filtered out and reported via `missing`
    // instead of crashing the call.
    const wellTyped: string[] = []
    const badType: string[] = []
    for (const p of peerIds) {
      if (typeof p === 'string') wellTyped.push(p)
      else badType.push(String(p))
    }
    const resolved = resolveDirectiveTargets(wellTyped, all)
    targets = resolved.matched
    missing = [...resolved.missing, ...badType]
    ambiguous = resolved.ambiguous
  }
  const settled = await Promise.allSettled(
    targets.map(async (t): Promise<StopOutcome> => {
      if (mode === 'soft') {
        const result = await deps.injectCommand(t.id, SOFT_STOP_MESSAGE)
        return { id: t.id, peerId: t.peerId, result }
      }
      const result = deps.interrupt(t.id, mode)
      return { id: t.id, peerId: t.peerId, result }
    })
  )
  const outcomes: StopOutcome[] = targets.map((t, i) => {
    // Iterate targets (not settled) so `t` never comes from an indexed
    // re-lookup of a same-length-by-construction array under
    // noUncheckedIndexedAccess -- the `r` guard below is the honest way to
    // keep the compiler's possibly-undefined check instead of asserting it away.
    const r = settled[i]
    if (r && r.status === 'fulfilled') {
      // Per-target journal line (review round, correction 7): matches
      // executeDirective's one-line-per-target template, so a soft stop
      // where most tiles time out still leaves an audit trail of which
      // agents actually complied, not just a final count.
      deps.journal(`stop ${mode} -> "${t.peerId ?? t.id}": ${r.value.result}`)
      return r.value
    }
    deps.journal(`stop ${mode} -> "${t.peerId ?? t.id}": error (${String(r ? r.reason : 'missing settle result')})`)
    return { id: t.id, peerId: t.peerId, result: 'error' }
  })
  if (missing.length > 0) {
    // Read resolveDirectiveTargets's own `ambiguous` field rather than
    // re-deriving it from `all`/`targets` -- re-filtering here would
    // duplicate the liveness predicate in a second place (review round).
    const ambigNote =
      ambiguous.length > 0 ? ` (${ambiguous.length} ambiguous, several live tiles share the id: ${ambiguous.join(', ')})` : ''
    deps.journal(`stop ${mode}: ${missing.length} target(s) not reachable: ${missing.join(', ')}${ambigNote}`)
  }
  deps.journal(`stop ${mode}: ${outcomes.length} target(s)`)
  return { outcomes, missing }
}
