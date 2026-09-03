// Queue → team-lead dispatch (PLAN C15): pure helpers for the operator's
// ordered "send to the lead next" queue on roadmap items. The wiring (broker
// reads, targeted announce, auto-dispatch watcher) lives in index.ts.
//
// SECURITY (C8 rule): the dispatch message is a CODE CONSTANT — never an
// operator/repo template.
//
// No electron imports so it is unit-testable under `bun test`.

import type { DirectiveDispatch, DispatchResult, RoadmapItem } from '../shared/types'
// Dispatch-request shapes come from the REPO-ROOT shared/types.ts, the broker's
// own file: main-side only (no renderer/preload consumer), and
// desktop/tsconfig.node.json already carries the root file in its program.
// Type-only, so the repo-root bun harness never resolves it at runtime.
import type { DispatchedCard, DispatchRequest, DispatchRequestOutcome } from '../../../shared/types'
import { queuedItems } from '../shared/workflow'
import { dispatchedTargetsTail } from './directive-journal'
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
 * Gates only the automatic dispatch timer; the operator's manual "send first"
 * button calls dispatchNext() directly and stays unguarded on purpose.
 * A missing dependency (deleted from the roadmap) counts as resolved, matching
 * watchDispatched's own completion check.
 * Second parameter is `{ size: number }` rather than a concrete collection type
 * because only the count of in-flight ids matters here.
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
 * `claimed` is the sole discriminant for abandonment: a freshly dispatched item
 * is planned+unlocked too, same as an item that reverted after being claimed.
 * Claims on `in_progress` status alone, not on `locked`: a Deck-authored
 * in_progress write leaves `locked: false`, so requiring `locked` would strand
 * it as never-claimed.
 * Every 'remove' outcome, not just 'done', must be treated by the caller as
 * freeing the dispatch barrier.
 * The exhaustive switch on item.status has no default: a future new status must
 * fail compilation here rather than silently falling into 'keep'.
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
 * One announce for a whole head wave (N>=1 items sharing the head rank), so
 * the lead decides the parallelization. N=1 delegates to composeDispatchText
 * and stays byte-identical to the mono-item announce. Code constant, never an
 * operator/repo template.
 * An extra-agent request is routed through the supervisor via send_message:
 * only the supervisor holds deck-control's spawn tools, behind its own
 * operator confirmation gate.
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
 * Per-member atomicity: a member whose upsert throws is reported in `failed`
 * and excluded from `dispatched`, while sibling members that succeeded are
 * still included.
 * N=1 returns the single-item shape ({sent:true, title}) so existing consumers
 * stay behavior-identical; N>1 additionally carries count/titles.
 * If every member's upsert throws, the wave reports {sent:false,
 * reason:'error'} even though the announce already reached the lead.
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

/**
 * Two distinct constant notes, never merged or built with per-run detail: an
 * empty target_peer_ids can't be fixed by re-queuing, an unreachable target
 * can.
 * Kept as fixed strings rather than appended detail because the context field
 * is a full uncapped replace, so a growing note could grow without bound across
 * repeated failures.
 * composeUnresolvedContext strips any prior occurrence of either note before
 * appending, so a card whose failure reason changes between attempts never
 * accumulates both.
 */
export const UNRESOLVED_TARGET_NOTE =
  '[dispatch] marked done with no live target resolved -- nothing was injected. Safe to re-queue once the requested target is reachable: no live session was touched.'

export const NO_TARGET_REQUESTED_NOTE =
  '[dispatch] marked done with zero target_peer_ids set -- nothing was ever requested, so nothing was injected. Re-queuing alone will NOT fix this: set target_peer_ids first.'

const KNOWN_UNRESOLVED_NOTES = [UNRESOLVED_TARGET_NOTE, NO_TARGET_REQUESTED_NOTE]

/** Picks the note that matches WHY nothing was injected (card 249ed831). */
export function unresolvedDirectiveNote(item: RoadmapItem): string {
  return item.target_peer_ids.length === 0 ? NO_TARGET_REQUESTED_NOTE : UNRESOLVED_TARGET_NOTE
}

/**
 * An empty existingContext gets the note alone, with no leading blank
 * separator, so it doesn't read as a formatting bug.
 * The strip must remove both the prefixed and the bare form since the append is
 * conditional on that same empty-context case -- otherwise a note posed on an
 * empty context is never recognized on the next failure.
 */
export function composeUnresolvedContext(existingContext: string, note: string): string {
  const stripped = KNOWN_UNRESOLVED_NOTES.reduce(
    (acc, n) => acc.split(`\n\n${n}`).join('').split(n).join(''),
    existingContext
  )
  return stripped ? `${stripped}\n\n${note}` : note
}

export interface DirectiveWaveDeps {
  markDone: (item: RoadmapItem) => Promise<void>
  /**
   * Executes ONE directive card and reports what it reached (card bf76d37f).
   * The report is the executor's own resolver output, never re-derived here:
   * this module owns no liveness predicate and must not grow one.
   */
  execute: (item: RoadmapItem) => Promise<DirectiveDispatch>
  journal: (line: string) => void
  reportError: (message: string, error: unknown) => void
  /**
   * Card 249ed831 (form b): called once, right after `execute` resolves, when
   * and ONLY when the card was consumed with NOTHING done -- the exact
   * predicate is `report.directive !== null && report.injected.length === 0`,
   * checked by the caller below, not by this dep. `directive !== null`
   * excludes the separate parse-refusal branch (an invalid command, already
   * reported through `reportError` inside `execute` itself); this hook is
   * only for a VALID command that resolved zero live targets. Its failure is
   * caught by the caller and routed through `reportError` -- it must never
   * abort the wave or drop `report` from `executed`.
   */
  noteUnresolved: (item: RoadmapItem) => Promise<void>
}

/**
 * markDone always runs before execute: replaying an injection on retry is real,
 * non-reversible context loss, while losing a directive after a mark just costs
 * a re-queue.
 * If markDone throws, the item is neither marked nor executed and stays queued
 * for the next drain pass; earlier siblings already committed keep their
 * mark+execute.
 * A card whose execute resolves but reaches zero live targets is still marked
 * done; deps.noteUnresolved is what tells the operator to re-queue it.
 * A card whose execute throws is absent from the returned array rather than
 * present with empty lists, since nothing is known about what it reached.
 */
export async function runDirectiveWave(
  directives: RoadmapItem[],
  deps: DirectiveWaveDeps
): Promise<DirectiveDispatch[]> {
  const executed: DirectiveDispatch[] = []
  for (const item of directives) {
    const label = isDirectiveCommand(item.directive) ? directiveKeys(item.directive) : `${item.directive ?? '?'}`
    await deps.markDone(item)
    try {
      const report = await deps.execute(item)
      executed.push(report)
      deps.journal(
        `directive card dispatched: "${item.title}" (${label}) -> ${dispatchedTargetsTail(
          report.injected.length,
          report.unreached.length
        )}`
      )
      // `directive !== null`, not `injected.length === 0`, is what
      // distinguishes a parse-refusal (excluded here) from a
      // resolved-but-unreached card: the parse-refusal branch also reaches this
      // code with an empty `injected`.
      if (report.directive !== null && report.injected.length === 0) {
        try {
          await deps.noteUnresolved(item)
        } catch (e) {
          deps.reportError(`could not post the unresolved-target note for "${item.title}"`, e)
        }
      }
    } catch (e) {
      deps.journal(
        `directive card "${item.title}" (${label}) marked done but execution threw: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
      deps.reportError(`directive execution threw after done-upsert for "${item.title}"`, e)
    }
  }
  return executed
}

// ---------------------------------------------------------------------------
// Dispatch requests (card bf76d37f): an agent asks through its MCP tool, the
// broker PARKS the request, the Deck serves it here and posts the outcome back.
// ---------------------------------------------------------------------------

/**
 * Projection, not derivation: the three buckets come straight from the
 * executor's own DirectiveDispatch, nothing here re-inspects sessions.
 * A normal card carries three empty buckets, indistinguishable from a directive
 * that reached nothing except by `kind`, so kind is carried per card rather
 * than assumed per branch.
 * An empty `cards` array is a success (nothing was eligible), never turned into
 * an error.
 */
export function composeDispatchOutcome(result: DispatchResult): DispatchRequestOutcome {
  const cards: DispatchedCard[] = [
    ...(result.directives ?? []).map((d): DispatchedCard => {
      const missing = d.unreached.map((u) => u.peerId)
      return {
        id: d.id,
        title: d.title,
        kind: 'directive',
        matched: d.injected.map((t) => t.peerId),
        missing,
        ambiguous: d.unreached.filter((u) => u.reason === 'ambiguous').map((u) => u.peerId)
      }
    }),
    ...(result.dispatched ?? []).map((m): DispatchedCard => ({
      id: m.id,
      title: m.title,
      kind: m.kind,
      matched: [],
      missing: [],
      ambiguous: []
    }))
  ]
  return { cards, note: dispatchOutcomeNote(result, cards.length) }
}

/** One readable line, used as-is by the requesting agent. */
function dispatchOutcomeNote(result: DispatchResult, cardCount: number): string {
  if (cardCount === 0) {
    // Not an error, and the reason matters: an empty queue and a missing
    // team-lead are both "nothing happened", for very different operator
    // actions.
    return `nothing eligible to dispatch (${result.reason ?? 'no reason reported'})`
  }
  const directives = result.directives?.length ?? 0
  const announced = result.dispatched?.length ?? 0
  const parts = [
    announced > 0 ? `${announced} card${announced === 1 ? '' : 's'} announced to the team-lead` : '',
    directives > 0 ? `${directives} directive card${directives === 1 ? '' : 's'} executed by the Deck` : ''
  ].filter(Boolean)
  return parts.join('; ')
}

/**
 * Everything runDispatchRequestPoll touches, injected. index.ts owns the
 * Electron-coupled wiring (broker endpoint, project key, the real dispatchNext
 * and its re-entrancy guard); this function owns the DECISION, which is why it
 * is here and not there -- index.ts imports electron and cannot be imported
 * under `bun test`, so a decision left inline would only ever be source-scanned.
 */
export interface DispatchRequestPollDeps {
  /** The pending requests parked broker-side for this project. */
  list: () => Promise<DispatchRequest[]>
  /**
   * True while a dispatch is already running. READ, never re-implemented: the
   * re-entrancy guard lives on dispatchNext in index.ts and stays the single
   * one. See the park branch below for why this is a read and not a lock.
   */
  inFlight: () => boolean
  dispatch: () => Promise<DispatchResult>
  resolve: (id: string, outcome: DispatchRequestOutcome) => Promise<void>
  reportError: (message: string, error: unknown) => void
}

/**
 * Park, not drain: when a dispatch is already in flight the tick resolves
 * nothing and leaves requests pending for the next tick, rather than queuing
 * behind the in-flight run.
 * A dispatch that throws is still answered with a failure note; silence is the
 * one outcome that's never acceptable, since a swallowed exception would look
 * identical to an honest timeout.
 * A resolve that throws is reported without aborting the remaining requests of
 * the same tick.
 */
export async function runDispatchRequestPoll(deps: DispatchRequestPollDeps): Promise<void> {
  const requests = await deps.list()
  // No early return on an empty list: the loop below IS the mechanism that
  // never triggers a dispatch nobody asked for. A `requests.length === 0`
  // guard here was measured REDUNDANT -- removing it left every probe green,
  // which makes it a line no test can falsify rather than a guarantee.
  if (deps.inFlight()) return
  for (const req of requests) {
    let outcome: DispatchRequestOutcome
    try {
      outcome = composeDispatchOutcome(await deps.dispatch())
    } catch (e) {
      deps.reportError(`dispatch request ${req.id} failed to dispatch`, e)
      outcome = { cards: [], note: `dispatch failed: ${e instanceof Error ? e.message : String(e)}` }
    }
    try {
      await deps.resolve(req.id, outcome)
    } catch (e) {
      deps.reportError(`dispatch request ${req.id} could not be resolved`, e)
    }
  }
}

/**
 * Priority order: a successful auto-dispatch always clears the flag; otherwise
 * an in-flight wave (dispatchedSize > 0) leaves it unchanged; otherwise it
 * tracks whether the queue still has a head.
 * An empty queue never arms the barrier since there is nothing to be blocked
 * on.
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
