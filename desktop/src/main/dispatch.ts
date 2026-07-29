// Queue → team-lead dispatch (PLAN C15): pure helpers for the operator's
// ordered "send to the lead next" queue on roadmap items. The wiring (broker
// reads, targeted announce, auto-dispatch watcher) lives in index.ts.
//
// SECURITY (C8 rule): the dispatch message is a CODE CONSTANT — never an
// operator/repo template.
//
// No electron imports so it is unit-testable under `bun test`.

import type { RoadmapItem } from '../shared/types'
import { queuedItems } from '../shared/workflow'

// queuedItems used to own its own filter+sort here (localeCompare tiebreak,
// diverging from the broker's BINARY-collation `ORDER BY queue, id` the
// moment an id left lowercase hex). Re-exported from shared/workflow so this
// module and desktop/src/main/index.ts keep importing it from './dispatch'
// unchanged, but the queue's actual order is derived in exactly one place
// (roadmap card 42edc88b phase 0).
export { queuedItems }

/** The next item to dispatch (lowest queue position), or null. */
export function firstQueued(items: RoadmapItem[]): RoadmapItem | null {
  return queuedItems(items)[0] ?? null
}

/** The position a newly queued item should take (max + 1). */
export function nextQueuePosition(items: RoadmapItem[]): number {
  return items.reduce((max, i) => (i.queue !== null && i.queue > max ? i.queue : max), 0) + 1
}

/**
 * R5 wave barrier (roadmap card 42edc88b phase 3): whether watchDispatched
 * may AUTOMATICALLY advance the queue. True only when (a) the previous wave
 * has fully drained -- dispatchedIds empty, the in-memory tracking structure
 * in index.ts that is the SOLE record of wave membership once an item is
 * dispatched (see its own doc comment for the restart caveat this makes
 * load-bearing) -- and (b) the next queued head's own dependencies are all
 * done or archived. A missing dependency (deleted from the roadmap) counts
 * as resolved, matching watchDispatched's own completion check.
 *
 * (b) exists because dispatchNextInner itself does NOT validate depends_on --
 * an unmet dependency at the head is a DAG violation the lane already flags
 * visually, and auto-dispatch must not race past it. This barrier gates ONLY
 * the automatic timer path; the operator's manual "send first to team-lead"
 * button (ipc.ts roadmap:dispatch) calls dispatchNext() directly and stays
 * UNGUARDED, the intended escape hatch when the barrier holds indefinitely
 * (e.g. an abandoned in-flight item, or a head whose dependency stalls).
 *
 * SEMANTIC HONESTY (audit §8): this is a BARRIER, not parallel dispatch --
 * dispatchNextInner still sends one head at a time. Waves stay informational
 * until 5852c074 lands multi-dispatch.
 *
 * The second parameter is intentionally structural (`{ size: number }`, not
 * a concrete collection type): only the COUNT of ids still tracked as
 * in-flight-wave-membership matters here, never their identity or the
 * claimed/unclaimed detail nextDispatchedState tracks below -- a plain Set
 * still satisfies this shape, so index.ts's Map<string, DispatchedEntry>
 * does too, with no change needed at this call site.
 */
export function canAutoDispatchNext(items: RoadmapItem[], dispatchedIds: { size: number }): boolean {
  if (dispatchedIds.size > 0) return false
  const head = firstQueued(items)
  if (!head) return false
  const byId = new Map(items.map((i) => [i.id, i]))
  return head.depends_on.every((depId) => {
    const dep = byId.get(depId)
    return !dep || dep.status === 'done' || dep.status === 'archived'
  })
}

/**
 * Per-id tracking record in index.ts's dispatchedIds Map (roadmap card
 * 6f19206e). `claimed` distinguishes "dispatched but the lead has not yet
 * set it in_progress" from "the lead actually picked it up" -- the
 * distinction the naive fix (delete on planned+unlocked) got wrong, since a
 * freshly dispatched item is ALSO planned+unlocked before it is claimed.
 */
export interface DispatchedEntry {
  claimed: boolean
}

/** What a watchDispatched tick should do with one tracked (id, entry) pair. */
export type DispatchedTickAction =
  | { kind: 'keep' }
  | { kind: 'claim' }
  | { kind: 'remove'; reason: 'done' | 'archived' | 'absent' | 'abandoned' }

/**
 * Pure per-tick transition for one dispatchedIds entry (roadmap card
 * 6f19206e). Fixes the lifecycle bug where dispatchedIds was only ever
 * cleaned on done/archived/absent: an operator stop (stopRoadmapItem) or an
 * idle-lock release (watchIdleLocks) reverts the item to planned/idea
 * without going through either, permanently closing the R5 wave barrier
 * (canAutoDispatchNext stays false forever, dispatchedIds.size never drops).
 *
 * `item` is `undefined` when the id has left the roadmap entirely (deleted)
 * -- handled as its own branch here, not left to the caller's loop, so the
 * exhaustiveness check below only ever narrows a real RoadmapStatus.
 *
 * The exhaustive switch on item.status (with a TS never-check default) is
 * deliberate: a future new status (e.g. "blocked"/"paused") must fail
 * compilation here instead of silently falling into 'keep' and closing the
 * barrier forever, the same failure mode this function exists to fix.
 *
 * NAMED TRAP, rejected: "remove when planned+unlocked" alone is wrong -- a
 * freshly dispatched item is planned+unlocked too (the lock only arrives
 * once the lead sets in_progress). The `claimed` flag is the sole
 * discriminant: only an entry that WAS claimed (locked+in_progress at some
 * earlier tick) and has since reverted to planned/idea unlocked counts as an
 * abandonment. A never-claimed entry seen planned+unlocked is kept as-is.
 *
 * `claim` is idempotent: an already-claimed entry is never handed back to
 * 'keep'-with-claimed-reset by a tick that observes the item momentarily
 * in_progress-but-unlocked (a lock release/reacquire race) -- that state is
 * simply 'keep', since the item's status never left in_progress.
 *
 * `in_progress` claims on STATUS ALONE, not on `locked`: broker.ts's lock
 * resolution only claims the work-lock for a non-'deck' author writing
 * status=in_progress (`by !== "deck" && !existing.locked`) -- the Deck's own
 * in_progress writes (e.g. an operator drag on the kanban, itself an
 * author='deck' upsert) leave `locked: false`. Requiring `item.locked` to
 * claim would strand exactly this item: claimed stays false through
 * in_progress, so a later revert to planned/idea reads as
 * never-claimed-kept instead of abandoned-removed -- the same permanently-
 * closed-barrier bug this function exists to fix, just reached through a
 * Deck-authored in_progress instead of a stop/idle-release. Same failure
 * mode via releaseStaleLocks (broker.ts): it clears locked AND flips
 * status back to planned in the SAME UPDATE, so an unlocked in_progress
 * window is not guaranteed to be observed by any given 20s tick either.
 * Abandonment is what actually needs `!item.locked` (see the planned/idea
 * branch below); claim does not.
 *
 * Every 'remove' outcome -- not just 'done' -- must be treated by the caller
 * as a completed transition (re-arm canAutoDispatchNext / dispatchNext()):
 * an abandonment frees the barrier exactly like a completion does, only the
 * journal wording differs.
 */
export function nextDispatchedState(entry: DispatchedEntry, item: RoadmapItem | undefined): DispatchedTickAction {
  if (!item) return { kind: 'remove', reason: 'absent' }
  switch (item.status) {
    case 'done':
      return { kind: 'remove', reason: 'done' }
    case 'archived':
      return { kind: 'remove', reason: 'archived' }
    case 'in_progress':
      return entry.claimed ? { kind: 'keep' } : { kind: 'claim' }
    case 'planned':
    case 'idea':
      return entry.claimed && !item.locked ? { kind: 'remove', reason: 'abandoned' } : { kind: 'keep' }
    default: {
      const _exhaustive: never = item.status
      return _exhaustive
    }
  }
}

/**
 * The targeted announce sent to the team-lead when an item is dispatched:
 * the full item plus the workflow contract (assign, keep the status current).
 */
export function composeDispatchText(item: RoadmapItem): string {
  const lines = [
    `Next roadmap item from the operator's dispatch queue (id ${item.id.slice(0, 8)}):`,
    '',
    `Title: ${item.title}`,
    `Kind: ${item.kind} | Priority: ${item.priority} | Value: ${item.value} | Effort: ${item.effort} | Status: ${item.status}`,
    item.description ? `Description: ${item.description}` : '',
    item.rationale ? `Rationale: ${item.rationale}` : '',
    item.context ? `Context (operator briefing): ${item.context}` : '',
    item.tags.length ? `Tags: ${item.tags.join(', ')}` : '',
    item.depends_on.length ? `Depends on: ${item.depends_on.map((d) => d.slice(0, 8)).join(', ')}` : '',
    '',
    'As team-lead: take it yourself or brief another peer with send_message. Use roadmap_get for full context, set the item in_progress with roadmap_update when the work REALLY starts (this locks it under the working peer), done when complete. Keep its status current — the Deck auto-dispatches the next queued item when this one is done.'
  ].filter((l) => l !== '')
  return lines.join('\n')
}

/**
 * Direct assignment of an item to ONE chosen peer (PLAN K6, the operator's
 * "process now" flow): the full item plus the take-it-now contract. Targeted
 * announce, so unlike the dispatch text there is no team-lead relaying step.
 * CODE CONSTANT (C8 rule).
 */
export function composeAssignText(item: RoadmapItem): string {
  const lines = [
    `The operator assigned THIS roadmap item to you — take it now (id ${item.id.slice(0, 8)}):`,
    '',
    `Title: ${item.title}`,
    `Kind: ${item.kind} | Priority: ${item.priority} | Value: ${item.value} | Effort: ${item.effort} | Status: ${item.status}`,
    item.description ? `Description: ${item.description}` : '',
    item.rationale ? `Rationale: ${item.rationale}` : '',
    item.context ? `Context (operator briefing): ${item.context}` : '',
    item.tags.length ? `Tags: ${item.tags.join(', ')}` : '',
    item.depends_on.length ? `Depends on: ${item.depends_on.map((d) => d.slice(0, 8)).join(', ')}` : '',
    '',
    'Pause your current step if needed. Use roadmap_get for full context, set the item to in_progress with roadmap_update when you actually start (this locks it under your peer_id), done when complete — or back to planned if you must abandon it.'
  ].filter((l) => l !== '')
  return lines.join('\n')
}

/**
 * The operator's STOP notice on an in_progress item (PLAN K3). Sent to the
 * supervisor (coordinate + report back) or broadcast to the whole group as a
 * fallback. Like the dispatch text, this is a CODE CONSTANT (C8 rule).
 */
export function composeStopText(item: RoadmapItem, viaSupervisor: boolean): string {
  const head = [
    `The operator asked to STOP all work on roadmap item "${item.title}" (id ${item.id.slice(0, 8)}).`,
    'The item has been unlocked and moved back to planned. Do not write to it anymore.'
  ]
  if (viaSupervisor) {
    head.push(
      'As supervisor: relay the stop to the peers working on this item (send_message), verify they acknowledged, then report the outcome to the operator (send_message to "operator").'
    )
  } else {
    head.push(
      'If you are working on this item: stop now, leave the code in a safe state, and do not set the item in_progress again unless the operator re-dispatches it.'
    )
  }
  return head.join('\n')
}
