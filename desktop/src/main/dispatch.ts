// Queue → team-lead dispatch (PLAN C15): pure helpers for the operator's
// ordered "send to the lead next" queue on roadmap items. The wiring (broker
// reads, targeted announce, auto-dispatch watcher) lives in index.ts.
//
// SECURITY (C8 rule): the dispatch message is a CODE CONSTANT — never an
// operator/repo template.
//
// No electron imports so it is unit-testable under `bun test`.

import type { DispatchResult, RoadmapItem } from '../shared/types'
import { queuedItems } from '../shared/workflow'
import { directiveKeys, isDirectiveCommand } from './directive'

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
 * SEMANTIC HONESTY (audit §8): this is a BARRIER, not a scheduler --
 * dispatchNextInner (roadmap card 5852c074) sends one whole head WAVE per
 * call (splitWave + dispatchNormalWave below), never reaching past it to a
 * second wave. The barrier still gates only whether that next wave-send may
 * fire automatically.
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
 * Full-detail snapshot lines for one item, shared by the single- and
 * multi-item dispatch composers below. Conditional fields collapse to ''
 * (filtered by the caller) when empty, same as the original inline shape.
 */
function itemSnapshotLines(item: RoadmapItem): string[] {
  return [
    `Title: ${item.title}`,
    `Kind: ${item.kind} | Priority: ${item.priority} | Value: ${item.value} | Effort: ${item.effort} | Status: ${item.status}`,
    item.description ? `Description: ${item.description}` : '',
    item.rationale ? `Rationale: ${item.rationale}` : '',
    item.context ? `Context (operator briefing): ${item.context}` : '',
    item.tags.length ? `Tags: ${item.tags.join(', ')}` : '',
    item.depends_on.length ? `Depends on: ${item.depends_on.map((d) => d.slice(0, 8)).join(', ')}` : ''
  ]
}

/**
 * The targeted announce sent to the team-lead when an item is dispatched:
 * the full item plus the workflow contract (assign, keep the status current).
 */
export function composeDispatchText(item: RoadmapItem): string {
  const lines = [
    `Next roadmap item from the operator's dispatch queue (id ${item.id.slice(0, 8)}):`,
    '',
    ...itemSnapshotLines(item),
    '',
    'As team-lead: take it yourself or brief another peer with send_message. Use roadmap_get for full context, set the item in_progress with roadmap_update when the work REALLY starts (this locks it under the working peer), done when complete. Keep its status current — the Deck auto-dispatches the next queued item when this one is done.'
  ].filter((l) => l !== '')
  return lines.join('\n')
}

/**
 * R5+ multi-dispatch (roadmap card 5852c074): the targeted announce sent to
 * the team-lead for a WHOLE head wave (N>=1 items sharing the queue's head
 * rank, see wavesOf in shared/workflow.ts) in a single message, delegating
 * the parallelization decision to the lead. N=1 delegates verbatim to
 * composeDispatchText so the mono-item announce is byte-identical to before
 * -- this composer only changes shape once there is an actual wave to
 * describe. CODE CONSTANT (C8 rule): never an operator/repo template.
 *
 * SPAWN GATE NOTE: deck-control's spawn tools (deck_spawn_session/team) are
 * injected only into the SUPERVISOR's --mcp-config (see index.ts, the
 * "Supervisor deck-control" comment above controlDeps), never into a
 * team-lead session — so the contract below routes an extra-agent request
 * through the supervisor
 * via send_message rather than implying the lead can spawn directly. The
 * supervisor's own spawn already carries a full operator confirmation gate
 * (approveSpawn / supervisorSpawnMode in index.ts); nothing new is added
 * here.
 */
export function composeMultiDispatchText(items: RoadmapItem[]): string {
  if (items.length <= 1) return composeDispatchText(items[0]!)
  const lines: string[] = [
    `${items.length} roadmap items from the operator's dispatch queue, to process IN PARALLEL (ids ${items
      .map((i) => i.id.slice(0, 8))
      .join(', ')}):`,
    ''
  ]
  items.forEach((item, i) => {
    if (i > 0) lines.push('---')
    lines.push(`[${i + 1}/${items.length}] id ${item.id.slice(0, 8)}:`, ...itemSnapshotLines(item))
  })
  lines.push(
    '',
    "As team-lead: distribute these across your team via send_message, respecting each role — you do NOT need to take them all yourself. If the team cannot absorb the parallelism, ask the SUPERVISOR (send_message) to spawn an additional agent — you have no direct spawn capability. Use roadmap_get for full context on each item, set an item in_progress with roadmap_update when work REALLY starts on it (this locks it under the working peer), done when complete. Keep each item's status current — the Deck auto-dispatches the next queued wave when this one fully completes."
  )
  return lines.filter((l) => l !== '').join('\n')
}

/**
 * Partitions a head wave (roadmap card 5852c074) into directive cards and
 * normal (announceable) items. Directive members execute immediately and are
 * NEVER announced (CT3 contract, preserved for the multi-item wave exactly as
 * it was for the single-item queue); the caller drives that side effect in
 * index.ts (Electron-coupled: executeDirective injects into live terminals),
 * this function only decides the split. Order within each bucket is
 * preserved from the input wave.
 */
export function splitWave(wave: RoadmapItem[]): { directives: RoadmapItem[]; normal: RoadmapItem[] } {
  const directives: RoadmapItem[] = []
  const normal: RoadmapItem[] = []
  for (const item of wave) {
    ;(item.kind === 'directive' ? directives : normal).push(item)
  }
  return { directives, normal }
}

/** Network calls injected into dispatchNormalWave, so it stays unit-testable. */
export interface DispatchWaveDeps {
  announce: (text: string) => Promise<number>
  upsert: (item: RoadmapItem) => Promise<void>
}

/**
 * Orchestrates ONE wave's normal (non-directive) members (roadmap card
 * 5852c074, acceptance criteria 1 and 3): a single announce carrying
 * composeMultiDispatchText's output, then a per-member upsert with per-member
 * atomicity -- a member whose upsert throws is reported in `failed` and is
 * NOT included in `dispatched`, so the caller never tracks it in
 * dispatchedIds, while sibling members that succeeded still are.
 *
 * N=1 returns the pre-5852c074 single-item DispatchResult shape
 * ({sent:true, title}) so existing consumers (index.ts's journal line,
 * RoadmapView.tsx's toast) stay byte-behavior-identical; N>1 additionally
 * carries count/titles. If every member's upsert throws, the wave is
 * reported as {sent:false, reason:'error'} even though the announce already
 * reached the lead -- there is nothing left to track, and 'error' is the
 * closest existing reason bucket for that (rare) split-brain case.
 */
export async function dispatchNormalWave(
  normal: RoadmapItem[],
  deps: DispatchWaveDeps
): Promise<{ result: DispatchResult; dispatched: RoadmapItem[]; failed: { item: RoadmapItem; error: unknown }[] }> {
  if (normal.length === 0) return { result: { sent: false, reason: 'empty-queue' }, dispatched: [], failed: [] }
  const sent = await deps.announce(composeMultiDispatchText(normal))
  if (sent === 0) return { result: { sent: false, reason: 'no-lead' }, dispatched: [], failed: [] }
  const dispatched: RoadmapItem[] = []
  const failed: { item: RoadmapItem; error: unknown }[] = []
  for (const item of normal) {
    try {
      await deps.upsert(item)
      dispatched.push(item)
    } catch (error) {
      failed.push({ item, error })
    }
  }
  if (dispatched.length === 0) return { result: { sent: false, reason: 'error' }, dispatched, failed }
  const result: DispatchResult =
    dispatched.length === 1
      ? { sent: true, title: dispatched[0]!.title }
      : { sent: true, count: dispatched.length, titles: dispatched.map((i) => i.title) }
  return { result, dispatched, failed }
}

export interface DirectiveWaveDeps {
  markDone: (item: RoadmapItem) => Promise<void>
  execute: (item: RoadmapItem) => Promise<void>
  journal: (line: string) => void
  reportError: (message: string, error: unknown) => void
}

/**
 * Runs one wave's directive members (card b1932a6a): mark-then-execute, the
 * reverse of the previous execute-then-mark order. RATIONALE (cost asymmetry
 * verified by reviewer): both orders can fail, at different prices --
 * execute-then-mark risks REPLAYING the injection on the next drain when the
 * done-upsert fails right after injection already fired (a doubled /clear on
 * a live session is real, non-reversible context loss); mark-then-execute
 * instead risks LOSING the directive when execution fails after the mark
 * already committed (the operator just re-queues it -- near-zero cost). So
 * `deps.markDone` always runs first, uncaught: if IT throws, nothing was
 * marked or executed, and the item stays queued for the next drain pass --
 * the same retry behavior the old order already had on an upsert failure.
 *
 * That reordering has a cost: once marked, a failure is now INVISIBLE in
 * roadmap state (the card reads done even though nothing was injected). The
 * per-item journal line below is therefore the ONLY witness of that outcome
 * -- LOAD-BEARING since this card, not "verbose logging" to trim later.
 * `deps.execute` throwing (the new failure mode this reorder introduces) is
 * caught HERE, not left to abort the whole wave: the mark already committed,
 * so there is no rollback an abort would protect, and siblings in the same
 * wave must still get their turn.
 *
 * ACCEPTED GAP: a process death between `markDone` resolving and `execute`
 * starting (or before `execute` reaches its own per-target journal calls)
 * loses the directive with no journal line at all. Accepted per the same
 * cost analysis: a silently lost directive is cheap to re-queue, a doubled
 * injection is not.
 */
export async function runDirectiveWave(directives: RoadmapItem[], deps: DirectiveWaveDeps): Promise<void> {
  for (const item of directives) {
    const label = isDirectiveCommand(item.directive) ? directiveKeys(item.directive) : `${item.directive ?? '?'}`
    await deps.markDone(item)
    try {
      await deps.execute(item)
      deps.journal(`directive card dispatched: "${item.title}" (${label})`)
    } catch (e) {
      deps.journal(
        `directive card "${item.title}" (${label}) marked done but execution threw: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
      deps.reportError(`directive execution threw after done-upsert for "${item.title}"`, e)
    }
  }
}

/**
 * Pure decision for watchDispatched's barrierPending flag (roadmap card
 * 0e55a30b, absorbed into 5852c074) -- see its doc comment on the
 * `barrierPending` declaration in index.ts for the gap this closes. Three
 * transitions, in priority order:
 *  1. `dispatchSucceeded` -> always false (an auto-dispatch just fired,
 *     whatever blocked it before is resolved).
 *  2. otherwise, `dispatchedSize > 0` -> unchanged (`current`): a previous
 *     wave is still in flight, which says nothing about a dependency block.
 *  3. otherwise (dispatchedSize === 0, nothing just dispatched) ->
 *     `queueHasHead`: true only when the queue still has a head item, so an
 *     EMPTY queue never arms the barrier (there is nothing to be blocked on),
 *     while a head stuck on an unmet dependency does.
 */
export function nextBarrierPending(
  current: boolean,
  dispatchedSize: number,
  dispatchSucceeded: boolean,
  queueHasHead: boolean
): boolean {
  if (dispatchSucceeded) return false
  if (dispatchedSize > 0) return current
  return queueHasHead
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
