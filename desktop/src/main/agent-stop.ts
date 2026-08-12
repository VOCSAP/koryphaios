// Multi-tile stop broadcast (roadmap card aaf4537d, lot 3). Pure module --
// no electron/node-pty import -- so bun test can exercise broadcastStop
// against a fake StopDeps without a real PTY/session stack. Mirrors
// executeDirective's fire-per-target dispatch (main/index.ts, function
// executeDirective) but swaps its fire-and-forget shape for
// Promise.allSettled + a returned outcome vector: an operator who clicks
// "stop all" deserves a report, not silence.
//
// Review round (lot 3, MERGEABLE AVEC CORRECTIONS): the peerIds-present path
// now delegates target resolution to resolveDirectiveTargets (directive.ts,
// CT3's already-tested resolver) instead of a hand-rolled peerId filter --
// that closes the charset/trim/dedupe gaps this file used to have and
// surfaces `missing` for the peerIds that requested a tile with no live,
// peer-resolved session. lockTargets/stopTouchesLocks are exported so the
// lock-park/lock-release wiring in ipc.ts is no longer untested inline logic.
//
// Wire contract kept in lockstep with the renderer's consumer (lot 4,
// AgentStopControls.tsx) BY VALUE: StopMode/StopOutcome/StopReport here are
// what desktop/src/shared/types.ts's DeckApi re-exports, and what the
// component's own local copy (kept for it to compile ahead of this file
// landing) is written against. Do not rename a field here without also
// checking that file.

import type { SessionRuntime } from '@shared/types'
import { resolveDirectiveTargets } from './directive'

/** pause/hard: bare ESC, not idle-gated. soft: idle-gated conversation-turn injection. */
export type StopMode = 'pause' | 'soft' | 'hard'

export const STOP_MODES: readonly StopMode[] = ['pause', 'soft', 'hard']

export type InterruptResult = 'interrupted' | 'no-terminal'

/** Mirrors SessionService.injectCommand's DirectiveOutcome (session-service.ts). */
export type InjectOutcome = 'written' | 'no-terminal' | 'busy-timeout'

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
   * dormant, or absent (resolveDirectiveTargets's `missing`, same meaning as
   * executeDirective's). Only ever non-empty when `peerIds` was passed:
   * the peerIds-absent ("everyone") path has nothing to report as missing.
   * Omitted rather than `[]` when there is nothing to show.
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
  interrupt(id: string): InterruptResult
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
 * Soft-stop is a request TO THE AGENT, not a verb on the process (unlike
 * pause/hard, which act on the PTY directly via interrupt) -- so it injects
 * a conversation turn, not a CLI command. Single line, no embedded '\n':
 * SessionService.injectCommand writes this text in one pty.write then a
 * separate '\r' to submit, so an internal newline would submit early and
 * truncate the rest as a second, never-submitted line.
 */
export const SOFT_STOP_MESSAGE =
  'Operator soft stop: finish the current turn, then stop. Do not start new work. ' +
  'Before stopping, release any roadmap card you hold (set it back to planned and clear your lock), ' +
  "and send your team-lead a one-line report of where you stopped."

/**
 * Fires one independent stop action per live tile and resolves once every
 * one has settled -- a slow or throwing tile never blocks another's outcome
 * (Promise.allSettled semantics, deliberately not Promise.all).
 *
 * `peerIds`, absent vs. present vs. present-and-empty, are three distinct
 * cases (aaf4537d lot 3 amendment, escalate-only-the-stragglers): absent
 * targets every live tile (the header button); present-and-non-empty
 * targets only those peers (e.g. escalating soft-stop stragglers to hard,
 * without also touching -- and releasing the cards of -- agents who already
 * took the stop); present-and-EMPTY is refused rather than silently treated
 * as "everyone", same discipline as /roadmap/lock-park|lock-release.
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
    // Delegates to the already-tested resolver (directive.ts) instead of a
    // hand-rolled filter: closes the charset/trim/dedupe gaps this file used
    // to have, and surfaces `missing` for peerIds with no live, peer-resolved
    // match (review round, correction 2).
    //
    // resolveDirectiveTargets's OWN contract assumes a real string[] --
    // its `raw.trim()` throws on a non-string element, and its one existing
    // caller (executeDirective) is guaranteed one by sanitizeRoadmapItem's
    // strList() upstream. broadcastStop has no such guarantee at its own
    // boundary (ipc.ts re-validates before calling it, but a non-string
    // slipping past TS -- e.g. a stale/fuzzed payload -- must not crash this
    // function outright): non-strings are filtered out here and reported via
    // `missing`, same "never a silent drop" discipline as a malformed peerId.
    const wellTyped: string[] = []
    const badType: string[] = []
    for (const p of peerIds) {
      if (typeof p === 'string') wellTyped.push(p)
      else badType.push(String(p))
    }
    const resolved = resolveDirectiveTargets(wellTyped, all)
    targets = resolved.matched
    missing = [...resolved.missing, ...badType]
  }
  const settled = await Promise.allSettled(
    targets.map(async (t): Promise<StopOutcome> => {
      if (mode === 'soft') {
        const result = await deps.injectCommand(t.id, SOFT_STOP_MESSAGE)
        return { id: t.id, peerId: t.peerId, result }
      }
      const result = deps.interrupt(t.id)
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
    deps.journal(`stop ${mode}: ${missing.length} target(s) not reachable: ${missing.join(', ')}`)
  }
  deps.journal(`stop ${mode}: ${outcomes.length} target(s)`)
  return { outcomes, missing }
}
