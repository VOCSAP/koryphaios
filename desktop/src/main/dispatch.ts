// Queue → team-lead dispatch (PLAN C15): pure helpers for the operator's
// ordered "send to the lead next" queue on roadmap items. The wiring (broker
// reads, targeted announce, auto-dispatch watcher) lives in index.ts.
//
// SECURITY (C8 rule): the dispatch message is a CODE CONSTANT — never an
// operator/repo template.
//
// No electron imports so it is unit-testable under `bun test`.

import type {
  AssignResult,
  DirectiveDispatch,
  DispatchedWaveMember,
  DispatchResult,
  RoadmapItem,
  StopResult
} from '../shared/types'
import type { GuardedWriteResult } from './roadmap-guarded-write'
// Dispatch-request shapes come from the REPO-ROOT shared/types.ts, the broker's
// own file: main-side only (no renderer/preload consumer), and
// desktop/tsconfig.node.json already carries the root file in its program.
// Type-only, so the repo-root bun harness never resolves it at runtime.
import type {
  AtomicDispatchCapability,
  AtomicDispatchDelivery,
  AtomicDispatchIntent,
  AtomicDispatchMember,
  DispatchedCard,
  DispatchRequest,
  DispatchRequestOutcome
} from '../../../shared/types'
import { queuedItems, resolveDependency, wavesOf } from '../shared/workflow'
import {
  composeAssignText,
  composeDispatchText,
  composeMultiDispatchText
} from '../../../shared/roadmap-dispatch-message'
import { ATOMIC_OPERATION_MARGIN_MS } from './broker-client'
import { dispatchedTargetsTail } from './directive-journal'
import { directiveKeys, isDirectiveCommand } from './directive'

// Re-exported so callers keep importing from './dispatch' while the queue
// order and the dependency rule are each derived in one place, the one the
// lane renders from.
export { queuedItems }

/** The next item to dispatch (lowest queue position), or null. */
export function firstQueued(items: RoadmapItem[]): RoadmapItem | null {
  return queuedItems(items)[0] ?? null
}

/** The position a newly queued item should take (max + 1). */
export function nextQueuePosition(items: RoadmapItem[]): number {
  return items.reduce((max, i) => (i.queue !== null && i.queue > max ? i.queue : max), 0) + 1
}

export { resolveDependency }

/** Why the automatic dispatch must not advance the queue this tick. */
export type AutoDispatchHold =
  | { kind: 'in-flight' }
  | { kind: 'empty' }
  | { kind: 'dependency'; head: RoadmapItem; unknown: string[]; pending: RoadmapItem[] }

/**
 * Gates only the automatic dispatch timer; the operator's manual "send first"
 * button calls dispatchNext() directly and stays unguarded on purpose.
 * `items` must include archived cards: a dependency that resolves to nothing
 * holds the queue, because the broker never deletes a card and an unresolved
 * entry is a mistyped or foreign id, not a finished prerequisite.
 * Second parameter is `{ size: number }` rather than a concrete collection type
 * because only the count of in-flight ids matters here.
 */
export function autoDispatchHold(items: RoadmapItem[], dispatchedIds: { size: number }): AutoDispatchHold | null {
  if (dispatchedIds.size > 0) return { kind: 'in-flight' }
  const head = firstQueued(items)
  if (!head) return { kind: 'empty' }
  const unknown: string[] = []
  const pending: RoadmapItem[] = []
  for (const depId of head.depends_on) {
    const dep = resolveDependency(items, depId)
    if (!dep) unknown.push(depId)
    else if (dep.status !== 'done' && dep.status !== 'archived') pending.push(dep)
  }
  return unknown.length > 0 || pending.length > 0 ? { kind: 'dependency', head, unknown, pending } : null
}

/** The journal reason for a queue held by the head's dependencies. */
export function dependencyHoldReason(hold: Extract<AutoDispatchHold, { kind: 'dependency' }>): string {
  const parts: string[] = []
  if (hold.unknown.length > 0) {
    parts.push(`depends on an id that matches no card: ${hold.unknown.join(', ')}; fix the card's depends_on`)
  }
  if (hold.pending.length > 0) {
    parts.push(`waiting on unfinished dependencies: ${hold.pending.map((i) => `"${i.title}"`).join(', ')}`)
  }
  return `next queued item "${hold.head.title}" ${parts.join('; ')} (use "send first to team-lead" to override)`
}

export function canAutoDispatchNext(items: RoadmapItem[], dispatchedIds: { size: number }): boolean {
  return autoDispatchHold(items, dispatchedIds) === null
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

export { composeDispatchText, composeMultiDispatchText, composeAssignText }

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
  /** 'skipped': the card closed since it was read; it is neither dispatched nor failed. */
  upsert: (item: RoadmapItem) => Promise<void | 'skipped'>
  warn: (line: string) => void
}

/**
 * Per-member atomicity: a member whose upsert throws is reported in `failed`
 * and excluded from `dispatched`, while sibling members that succeeded are
 * still included.
 * N=1 returns the single-item shape ({sent:true, title}) so existing consumers
 * stay behavior-identical; N>1 additionally carries count/titles.
 * If every member's upsert throws, the wave reports {sent:false,
 * reason:'error'} even though the announce already reached the lead.
 * A skipped member is warned about and listed in `result.skipped`; a wave
 * with only skipped members is still {sent:true}, the announce having been
 * delivered.
 */
export async function dispatchNormalWave(
  normal: RoadmapItem[],
  deps: DispatchWaveDeps
): Promise<{
  result: DispatchResult
  dispatched: RoadmapItem[]
  failed: { item: RoadmapItem; error: unknown }[]
  skipped: RoadmapItem[]
}> {
  if (normal.length === 0) {
    return { result: { sent: false, reason: 'empty-queue' }, dispatched: [], failed: [], skipped: [] }
  }
  const sent = await deps.announce(composeMultiDispatchText(normal))
  if (sent === 0) return { result: { sent: false, reason: 'no-lead' }, dispatched: [], failed: [], skipped: [] }
  const dispatched: RoadmapItem[] = []
  const failed: { item: RoadmapItem; error: unknown }[] = []
  const skipped: RoadmapItem[] = []
  for (const item of normal) {
    try {
      if ((await deps.upsert(item)) === 'skipped') {
        skipped.push(item)
        deps.warn(
          `wave member "${item.title}" was announced to the lead but its card closed before it was unqueued: the lead holds an order for a closed card`
        )
      } else dispatched.push(item)
    } catch (error) {
      failed.push({ item, error })
    }
  }
  const withSkipped = (r: DispatchResult): DispatchResult =>
    skipped.length === 0
      ? r
      : { ...r, skipped: skipped.map((i): DispatchedWaveMember => ({ id: i.id, title: i.title, kind: i.kind })) }
  if (dispatched.length === 0) {
    const result: DispatchResult = failed.length === 0 ? { sent: true } : { sent: false, reason: 'error' }
    return { result: withSkipped(result), dispatched, failed, skipped }
  }
  const result: DispatchResult =
    dispatched.length === 1
      ? { sent: true, title: dispatched[0]!.title }
      : { sent: true, count: dispatched.length, titles: dispatched.map((i) => i.title) }
  return { result: withSkipped(result), dispatched, failed, skipped }
}

/**
 * True when the wave left at least one tracked member: a wave whose members
 * were all skipped is sent but tracks nothing, so the barrier must not treat it
 * as in flight.
 */
export function dispatchTracked(result: DispatchResult): boolean {
  return result.sent && (result.dispatched?.length ?? 0) > 0
}

const OPERATION_LIFETIME_MS = 300_000

export interface AtomicPort {
  capability: AtomicDispatchCapability
  projectKey: string
  groupId: string
  /** A fresh id per attempt; only an unknown answer is settled under the id it was sent with. */
  newOperationId: () => string
  /** Signs and posts. A lost or unreadable answer is `unknown`, never a throw. */
  post: (action: 'execute' | 'resolve', intent: AtomicDispatchIntent) => Promise<AtomicDispatchDelivery>
}

export function atomicOperationId(nowMs: number, uuid: string, capability: AtomicDispatchCapability): string {
  const lifetime = Math.min(OPERATION_LIFETIME_MS, capability.max_operation_ms - ATOMIC_OPERATION_MARGIN_MS)
  return `${nowMs + lifetime}:${uuid}`
}

const toMember = (item: RoadmapItem): DispatchedWaveMember => ({ id: item.id, title: item.title, kind: item.kind })

function tokensOf(item: RoadmapItem): AtomicDispatchMember {
  if (item.content_rev === undefined || item.dispatch_state_tag === undefined) {
    throw new Error(`card "${item.title}" carries no revision or state tag, so the broker cannot check it is unchanged`)
  }
  return { id: item.id, expected_content_rev: item.content_rev, expected_dispatch_state_tag: item.dispatch_state_tag }
}

type SentDelivery = Extract<AtomicDispatchDelivery, { delivery: 'sent' }>

/** A sent outcome confirms exactly the intent's members: none missing, none extra, none twice. */
function confirmsEveryMember(intent: AtomicDispatchIntent, sent: SentDelivery): boolean {
  const ids = sent.cards.map((c) => c.id)
  return (
    ids.length === intent.members.length &&
    new Set(ids).size === ids.length &&
    intent.members.every((m) => ids.includes(m.id))
  )
}

/** An outcome that does not match what was asked is no outcome: it is unknown and gets settled. */
function checkedAnswer(intent: AtomicDispatchIntent, answer: AtomicDispatchDelivery): AtomicDispatchDelivery {
  if (answer.delivery !== 'sent' || confirmsEveryMember(intent, answer)) return answer
  return { delivery: 'unknown', operation_id: intent.operation_id, reason: 'invalid-response' }
}

async function attemptAtomic(
  port: AtomicPort,
  mode: AtomicDispatchIntent['mode'],
  targetKind: AtomicDispatchIntent['target_kind'],
  toPeerId: string,
  items: RoadmapItem[]
): Promise<{ delivery: AtomicDispatchDelivery; intent: AtomicDispatchIntent }> {
  if (items.length > port.capability.max_members) {
    throw new Error(`${items.length} cards exceed the ${port.capability.max_members} the broker accepts in one dispatch`)
  }
  const intent: AtomicDispatchIntent = {
    broker_id: port.capability.broker_id,
    operation_id: port.newOperationId(),
    project_key: port.projectKey,
    group_id: port.groupId,
    mode,
    target_kind: targetKind,
    to_peer_id: toPeerId,
    members: items.map(tokensOf)
  }
  const first = checkedAnswer(intent, await port.post('execute', intent))
  if (first.delivery !== 'unknown') return { delivery: first, intent }
  return { delivery: checkedAnswer(intent, await port.post('resolve', intent)), intent }
}

/** A delivery that stayed unknown: kept so a later tick settles it under the same id instead of resending. */
export interface PendingDispatch {
  intent: AtomicDispatchIntent
  members: DispatchedWaveMember[]
}

export interface AtomicWaveDeps {
  port: AtomicPort
  /** The lead, or the only active session; null when no request must be made at all. */
  target: () => { peerId: string; kind: 'lead' | 'sole-active-fallback' } | null
  /** The normal members of the head wave as the broker lists them now. */
  reread: () => Promise<RoadmapItem[]>
  journal: (line: string) => void
  warn: (line: string) => void
}

export interface WaveOutcome {
  result: DispatchResult
  /** Only members the broker confirmed sent. */
  dispatched: RoadmapItem[]
  failed: { item: RoadmapItem; error: unknown }[]
  pending: PendingDispatch | null
}

export function sentPayload(members: DispatchedWaveMember[]): Pick<DispatchResult, 'title' | 'count' | 'titles'> {
  return members.length === 1
    ? { title: members[0]!.title }
    : { count: members.length, titles: members.map((m) => m.title) }
}

/**
 * A refusal that proves a card or the queue moved is retried once on a fresh
 * read under a new operation id; an unknown answer is settled, never resent.
 */
export async function dispatchWaveAtomic(normal: RoadmapItem[], deps: AtomicWaveDeps): Promise<WaveOutcome> {
  const none = (result: DispatchResult): WaveOutcome => ({ result, dispatched: [], failed: [], pending: null })
  if (normal.length === 0) return none({ sent: false, reason: 'empty-queue' })
  const target = deps.target()
  if (!target) return none({ sent: false, reason: 'no-lead' })
  let members = normal
  let left: DispatchedWaveMember[] = []
  for (let attempt = 0; ; attempt++) {
    const { delivery, intent } = await attemptAtomic(deps.port, 'wave', target.kind, target.peerId, members)
    if (delivery.delivery === 'sent') {
      const dispatched = members
      deps.journal(
        `wave of ${dispatched.length} item(s) sent to ${target.kind === 'lead' ? 'the lead' : 'the only active session'} "${target.peerId}"`
      )
      const sentMembers = dispatched.map(toMember)
      return {
        result: {
          sent: true,
          delivery: 'sent',
          ...sentPayload(sentMembers),
          dispatched: sentMembers,
          ...(left.length > 0 ? { notSent: left } : {})
        },
        dispatched,
        failed: [],
        pending: null
      }
    }
    if (delivery.delivery === 'unknown') {
      const unconfirmed = members.map(toMember)
      deps.warn(`wave delivery to "${target.peerId}" is unconfirmed after resolve (${delivery.reason}): not resent`)
      return {
        result: {
          sent: false,
          delivery: 'unknown',
          reason: 'unconfirmed',
          unconfirmed,
          ...(left.length > 0 ? { notSent: left } : {})
        },
        dispatched: [],
        failed: [],
        pending: { intent, members: unconfirmed }
      }
    }
    if (attempt === 0 && (delivery.reason === 'card-changed' || delivery.reason === 'queue-changed')) {
      const fresh = await deps.reread()
      const freshIds = new Set(fresh.map((i) => i.id))
      left = normal.filter((i) => !freshIds.has(i.id)).map(toMember)
      for (const m of left) deps.warn(`card "${m.title}" left the wave before the retry: not sent`)
      if (fresh.length === 0) {
        return none({ sent: false, delivery: 'not-sent', reason: delivery.reason, notSent: normal.map(toMember) })
      }
      members = fresh
      continue
    }
    const named = delivery.card_ids.length > 0 ? members.filter((m) => delivery.card_ids.includes(m.id)) : members
    return none({
      sent: false,
      delivery: 'not-sent',
      reason: delivery.reason === 'no-target' ? 'no-lead' : delivery.reason,
      notSent: [...named.map(toMember), ...left]
    })
  }
}

export interface DispatchWaveSelection {
  /** null when the broker does not serve the atomic route. */
  atomic: AtomicWaveDeps | null
  legacy: DispatchWaveDeps
  trace: (line: string) => void
}

export async function dispatchWave(normal: RoadmapItem[], selection: DispatchWaveSelection): Promise<WaveOutcome> {
  if (selection.atomic) return dispatchWaveAtomic(normal, selection.atomic)
  selection.trace('broker serves no atomic dispatch: the wave is announced before its cards are written (previous order)')
  const previous = await dispatchNormalWave(normal, selection.legacy)
  return { result: previous.result, dispatched: previous.dispatched, failed: previous.failed, pending: null }
}

export type SettledDispatch =
  | { state: 'sent'; members: DispatchedWaveMember[] }
  | { state: 'not-sent' | 'abandoned'; members: [] }
  | { state: 'unknown' }

/**
 * Asks the broker again under the original operation id. Only the operator's own
 * dispatch may give up on a delivery whose answer can never come back (deadline
 * passed, or the broker is not the one that was asked).
 */
export async function settleUnconfirmed(
  pending: PendingDispatch,
  port: AtomicPort | null,
  manual: boolean
): Promise<SettledDispatch> {
  if (!port) return manual ? { state: 'abandoned', members: [] } : { state: 'unknown' }
  const answer = checkedAnswer(pending.intent, await port.post('resolve', pending.intent))
  if (answer.delivery === 'sent') return { state: 'sent', members: pending.members }
  if (answer.delivery === 'not-sent') return { state: 'not-sent', members: [] }
  const final = answer.reason === 'expired' || answer.reason === 'broker-mismatch'
  return manual && final ? { state: 'abandoned', members: [] } : { state: 'unknown' }
}

export interface UnconfirmedGate {
  /** Remembers a wave whose delivery stayed unknown; null leaves what is already remembered. */
  remember: (pending: PendingDispatch | null) => void
  /**
   * The result to return instead of dispatching while a delivery is unconfirmed,
   * or null when the dispatch may go on. A delivery that turns out sent is
   * handed to `track`; nothing new is ever sent in the same call.
   */
  beforeDispatch: (
    port: AtomicPort | null,
    manual: boolean,
    track: (members: DispatchedWaveMember[]) => void
  ) => Promise<DispatchResult | null>
}

export function createUnconfirmedGate(journal: DispatcherDeps['journal']): UnconfirmedGate {
  let pending: PendingDispatch | null = null
  return {
    remember: (next) => {
      if (next) pending = next
    },
    beforeDispatch: async (port, manual, track) => {
      if (!pending) return null
      const current = pending
      const settled = await settleUnconfirmed(current, port, manual)
      if (settled.state === 'unknown') {
        return { sent: false, delivery: 'unknown', reason: 'unconfirmed', unconfirmed: current.members }
      }
      pending = null
      if (settled.state === 'sent') {
        track(settled.members)
        journal(`unconfirmed wave delivery settled: ${settled.members.length} item(s) were sent`)
        return { sent: true, delivery: 'sent', ...sentPayload(settled.members), dispatched: settled.members }
      }
      journal(
        settled.state === 'abandoned'
          ? 'unconfirmed wave delivery given up by the operator: it may have reached the lead'
          : 'unconfirmed wave delivery settled: it was not sent'
      )
      return null
    }
  }
}

/**
 * Two distinct fixed notes: an empty target_peer_ids can't be fixed by
 * re-queuing, an unreachable target can. A target that was live and refused
 * gets a third note built from the report, naming each reason.
 */
export const UNRESOLVED_TARGET_NOTE =
  '[dispatch] marked done with no live target resolved -- nothing was injected. Safe to re-queue once the requested target is reachable: no live session was touched.'

export const NO_TARGET_REQUESTED_NOTE =
  '[dispatch] marked done with zero target_peer_ids set -- nothing was ever requested, so nothing was injected. Re-queuing alone will NOT fix this: set target_peer_ids first.'

/** Picks the note that matches why nothing was injected. */
export function unresolvedDirectiveNote(item: RoadmapItem, report: DirectiveDispatch): string {
  if (item.target_peer_ids.length === 0) return NO_TARGET_REQUESTED_NOTE
  const refused = report.refused ?? []
  if (refused.length === 0) return UNRESOLVED_TARGET_NOTE
  const named = refused.map(({ peerId, reason }) => `${peerId} (${reason})`).join(', ')
  return `[dispatch] marked done, nothing was injected: the live target(s) refused the command -- ${named}. Re-queue once they can take input.`
}

export interface DirectiveWaveDeps {
  /** 'skipped': the card closed since it was read; its command is not run. */
  markDone: (item: RoadmapItem) => Promise<void | 'skipped'>
  /** Uses executor-owned resolver buckets so this layer never re-derives liveness. */
  execute: (item: RoadmapItem) => Promise<DirectiveDispatch>
  journal: (line: string) => void
  reportError: (message: string, error: unknown) => void
  /** Called only after a valid directive settles with no writes or pending targets. */
  noteUnresolved: (item: RoadmapItem, report: DirectiveDispatch) => Promise<void>
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
    if ((await deps.markDone(item)) === 'skipped') continue
    try {
      const report = await deps.execute(item)
      executed.push(report)
      deps.journal(
        `directive card dispatched: "${item.title}" (${label}) -> ${dispatchedTargetsTail(
          report.injected.length,
          report.unreached.length
        )}`
      )
      // Parse refusals use directive:null and must not receive unresolved notes.
      if (report.directive !== null && report.injected.length === 0 && (report.pending?.length ?? 0) === 0) {
        try {
          await deps.noteUnresolved(item, report)
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
        ambiguous: d.unreached.filter((u) => u.reason === 'ambiguous').map((u) => u.peerId),
        ...(d.refused ? { refused: d.refused.map(({ peerId, reason }) => ({ peerId, reason })) } : {}),
        ...(d.pending ? { pending: d.pending.map((t) => t.peerId) } : {})
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
  const titles = (members: DispatchedWaveMember[] | undefined): string =>
    (members ?? []).map((m) => `"${m.title}"`).join(', ')
  if (result.delivery === 'unknown') {
    return `delivery NOT confirmed for ${titles(result.unconfirmed) || 'the wave'}: the order may or may not have reached the team-lead and was not resent; check before requesting again`
  }
  if (result.delivery === 'not-sent') {
    const named = titles(result.notSent)
    return `not sent (${result.reason ?? 'refused'})${named ? `: ${named}` : ''}; no card was moved and nothing was announced`
  }
  const skipped = result.skipped?.length ?? 0
  if (cardCount === 0 && skipped === 0) {
    // Not an error, and the reason matters: an empty queue and a missing
    // team-lead are both "nothing happened", for very different operator
    // actions.
    return `nothing eligible to dispatch (${result.reason ?? 'no reason reported'})`
  }
  const directives = result.directives?.length ?? 0
  const announced = result.dispatched?.length ?? 0
  const parts = [
    announced > 0 ? `${announced} card${announced === 1 ? '' : 's'} announced to the team-lead` : '',
    skipped > 0
      ? `${skipped} card${skipped === 1 ? '' : 's'} announced to the team-lead but closed before they were unqueued`
      : '',
    (result.notSent?.length ?? 0) > 0
      ? `${titles(result.notSent)} not sent: left the wave before the retry`
      : '',
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
      'As supervisor: relay the stop to the peers working on this item (send_message), verify they acknowledged, then report the outcome to the operator (notify_operator).'
    )
  } else {
    head.push(
      'If you are working on this item: stop now, leave the code in a safe state, and do not set the item in_progress again unless the operator re-dispatches it.'
    )
  }
  return head.join('\n')
}

export interface AssignDeps {
  read: (id: string) => Promise<RoadmapItem | null>
  /** Number of peers the targeted announce reached. */
  announce: (item: RoadmapItem, target: string) => Promise<number>
  write: (item: RoadmapItem) => Promise<GuardedWriteResult>
  journal: (line: string) => void
  warn: (line: string) => void
  reportError: (message: string, error: unknown) => void
  /** Set when the broker serves the atomic route; announce and write are then not used. */
  atomic?: AtomicPort | null
  /** Settles an assignment left unknown before another one of the same card may start. */
  gate?: AssignGate
}

export interface AssignGate {
  remember: (cardId: string, pending: PendingDispatch) => void
  /** The result to return instead of a new assignment of this card while an earlier one is unconfirmed, or null. */
  beforeAssign: (cardId: string, port: AtomicPort | null) => Promise<AssignResult | null>
}

// Per card: an unknown order about one card says nothing about another.
export function createAssignGate(journal: AssignDeps['journal']): AssignGate {
  const pending = new Map<string, PendingDispatch>()
  return {
    remember: (cardId, next) => {
      pending.set(cardId, next)
    },
    beforeAssign: async (cardId, port) => {
      const current = pending.get(cardId)
      if (!current) return null
      const title = current.members[0]?.title ?? cardId
      // A new assignment is the operator's own gesture, so it may give up like a manual dispatch.
      const settled = await settleUnconfirmed(current, port, true)
      if (settled.state === 'unknown') return { sent: false, delivery: 'unknown', reason: 'unconfirmed' }
      pending.delete(cardId)
      if (settled.state === 'sent') {
        journal(`unconfirmed assignment of "${title}" settled: it was sent`)
        return { sent: true, delivery: 'sent' }
      }
      journal(
        settled.state === 'abandoned'
          ? `unconfirmed assignment of "${title}" given up by the operator: it may have reached the peer`
          : `unconfirmed assignment of "${title}" settled: it was not sent`
      )
      return null
    }
  }
}

async function assignAtomic(item: RoadmapItem, target: string, port: AtomicPort, deps: AssignDeps): Promise<AssignResult> {
  let current = item
  for (let attempt = 0; ; attempt++) {
    const { delivery, intent } = await attemptAtomic(port, 'assign', 'assignee', target, [current])
    if (delivery.delivery === 'sent') {
      deps.journal(`item "${current.title}" assigned to "${target}"`)
      return { sent: true, delivery: 'sent' }
    }
    if (delivery.delivery === 'unknown') {
      deps.warn(`assignment of "${current.title}" to "${target}" is unconfirmed after resolve (${delivery.reason}): not resent`)
      deps.gate?.remember(current.id, { intent, members: [toMember(current)] })
      return { sent: false, delivery: 'unknown', reason: 'unconfirmed' }
    }
    if (attempt === 0 && delivery.reason === 'card-changed') {
      const fresh = await deps.read(current.id)
      if (fresh) {
        current = fresh
        continue
      }
    }
    return { sent: false, delivery: 'not-sent', reason: delivery.reason }
  }
}

/**
 * Without the atomic route the peer hears the order before the card moves, so a
 * skipped write leaves a peer holding an order for a changed card: sent stays
 * true, writeSkipped says so.
 */
export async function runAssign(id: string, peerId: string, deps: AssignDeps): Promise<AssignResult> {
  const target = peerId.trim()
  if (!target) return { sent: false }
  try {
    if (deps.gate) {
      const early = await deps.gate.beforeAssign(id, deps.atomic ?? null)
      if (early) return early
    }
    const item = await deps.read(id)
    if (!item) return { sent: false }
    if (deps.atomic) return await assignAtomic(item, target, deps.atomic, deps)
    if ((await deps.announce(item, target)) === 0) return { sent: false }
    if (!(await deps.write(item)).written) {
      deps.warn(
        `item "${item.title}" was assigned to "${target}" but its card closed before it moved to in_progress: the peer holds an order for a closed card`
      )
      return { sent: true, writeSkipped: true }
    }
    deps.journal(`item "${item.title}" assigned to "${target}"`)
    return { sent: true }
  } catch (e) {
    deps.reportError('assign failed', e)
    return { sent: false }
  }
}

export interface StopDeps {
  read: (id: string) => Promise<RoadmapItem | null>
  write: (item: RoadmapItem) => Promise<GuardedWriteResult>
  /** Delivers the stop notice and says how it went out. */
  notify: (item: RoadmapItem) => Promise<StopResult['via']>
  journal: (line: string) => void
  reportError: (message: string, error: unknown) => void
}

/**
 * The write comes first because the notice states the card is unlocked and back
 * to planned.
 */
export async function runStop(id: string, deps: StopDeps): Promise<StopResult> {
  const item = await deps.read(id)
  if (!item) return { stopped: false, via: 'none', reason: 'not-found' }
  let written: GuardedWriteResult
  try {
    written = await deps.write(item)
  } catch (e) {
    deps.reportError(`stop of "${item.title}" could not be written`, e)
    throw e
  }
  if (!written.written) return { stopped: false, via: 'none', reason: 'card-changed' }
  let via: StopResult['via'] = 'none'
  try {
    via = await deps.notify(written.item)
  } catch (e) {
    deps.reportError(`stop notice for "${written.item.title}" failed after the card was released`, e)
  }
  deps.journal(`stop requested on "${written.item.title}" (via ${via})`)
  return { stopped: true, via }
}

/**
 * One report per distinct failure of a polled call: a repeat of the last
 * message stays silent until a fully successful run calls recovered().
 */
export function createFailureReporter(report: (error: unknown) => void): {
  failed: (error: unknown) => void
  recovered: () => void
} {
  let last: string | null = null
  return {
    failed: (error) => {
      const message = error instanceof Error ? error.message : String(error)
      if (message === last) return
      last = message
      report(error)
    },
    recovered: () => {
      last = null
    }
  }
}

function headNormalMembers(items: RoadmapItem[]): RoadmapItem[] {
  const byId = new Map(items.map((i) => [i.id, i]))
  const ids = wavesOf(queuedItems(items))[0] ?? []
  return splitWave(ids.map((id) => byId.get(id)).filter((i): i is RoadmapItem => i !== undefined)).normal
}

/** What one dispatch run uses: all derived from a single endpoint and project key, resolved once. */
export interface DispatchRun {
  /** The broker's atomic capability as a port; null on a broker that certainly has none. */
  port: AtomicPort | null
  list: () => Promise<RoadmapItem[]>
  directives: DirectiveWaveDeps
  legacy: DispatchWaveDeps
}

export interface DispatcherDeps {
  /** Called once per run; rejects when the capability cannot be read. */
  openRun: () => Promise<DispatchRun>
  target: AtomicWaveDeps['target']
  /** Registers members the broker confirmed sent, so the auto-dispatch barrier waits on them. */
  track: (members: DispatchedWaveMember[]) => void
  journal: (line: string) => void
  warn: (line: string) => void
  trace: (line: string) => void
  reportError: (message: string, error: unknown) => void
}

export interface Dispatcher {
  /** `manual` is the operator's own button: the only caller that may give up on an unconfirmed delivery. */
  dispatch: (manual: boolean) => Promise<DispatchResult>
  inFlight: () => boolean
}

/**
 * The whole sequence of one dispatch with only its effects injected: capability
 * first, the unconfirmed delivery before any read or send, directives, then the
 * wave. Overlapping calls share one run, since two runs could double-inject a
 * directive.
 */
export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const gate = createUnconfirmedGate(deps.journal)
  let running: Promise<DispatchResult> | null = null

  const once = async (manual: boolean): Promise<DispatchResult> => {
    const executedDirectives: DirectiveDispatch[] = []
    const announcedMembers: DispatchedWaveMember[] = []
    // Attached to every exit; each half stays absent when empty, so a dispatch
    // that executed no directive or announced nothing keeps its plain shape.
    const withReports = (r: DispatchResult): DispatchResult => ({
      ...r,
      ...(executedDirectives.length > 0 ? { directives: executedDirectives } : {}),
      ...(announcedMembers.length > 0 ? { dispatched: announcedMembers } : {})
    })
    try {
      const run = await deps.openRun()
      const port = run.port
      const early = await gate.beforeDispatch(port, manual, deps.track)
      if (early) return withReports(early)
      // Directive-only waves drain first; the guard bounds the loop should a done-write fail to advance it.
      for (let guard = 0; guard < 64; guard++) {
        const items = await run.list()
        const waveIds = wavesOf(queuedItems(items))[0]
        if (!waveIds || waveIds.length === 0) return withReports({ sent: false, reason: 'empty-queue' })
        const byId = new Map(items.map((i) => [i.id, i]))
        const wave = waveIds.map((id) => byId.get(id)).filter((i): i is RoadmapItem => i !== undefined)
        const { directives, normal } = splitWave(wave)
        executedDirectives.push(...(await runDirectiveWave(directives, run.directives)))
        if (normal.length === 0) continue
        const { result, dispatched, failed, pending } = await dispatchWave(normal, {
          atomic: port
            ? {
                port,
                target: deps.target,
                reread: async () => headNormalMembers(await run.list()),
                journal: deps.journal,
                warn: deps.warn
              }
            : null,
          legacy: run.legacy,
          trace: deps.trace
        })
        gate.remember(pending)
        // The same `dispatched` array feeds the barrier and the outcome reported to a
        // requesting agent, so the two can never name different cards.
        deps.track(dispatched.map(toMember))
        announcedMembers.push(...dispatched.map(toMember))
        for (const { item, error } of failed) {
          deps.reportError(`wave member "${item.title}" failed to unqueue, not tracked`, error)
        }
        return withReports(result)
      }
      return withReports({ sent: false, reason: 'error' })
    } catch (e) {
      deps.reportError('dispatch failed', e)
      return withReports({ sent: false, reason: 'error' })
    }
  }

  return {
    dispatch: (manual) => {
      if (running) return running
      running = once(manual).finally(() => {
        running = null
      })
      return running
    },
    inFlight: () => running !== null
  }
}

/** What one assignment uses: all derived from a single endpoint and project key, resolved once. */
export interface AssignRun {
  port: AtomicPort | null
  read: AssignDeps['read']
  announce: AssignDeps['announce']
  write: AssignDeps['write']
}

export interface AssignerDeps {
  /** Called once per assignment; rejects when the capability cannot be read. */
  openRun: () => Promise<AssignRun>
  journal: AssignDeps['journal']
  warn: AssignDeps['warn']
  reportError: AssignDeps['reportError']
  trace: (line: string) => void
}

/** Capability first: a broker whose capability cannot be read gets no assignment in either order. */
export function createAssigner(deps: AssignerDeps): (id: string, peerId: string) => Promise<AssignResult> {
  const gate = createAssignGate(deps.journal)
  return async (id, peerId) => {
    let run: AssignRun
    try {
      run = await deps.openRun()
    } catch (e) {
      deps.reportError('assign: the broker capability could not be read, nothing was sent', e)
      return { sent: false, reason: 'error' }
    }
    if (!run.port) deps.trace('broker serves no atomic dispatch: the assignment is announced before its card is written (previous order)')
    return runAssign(id, peerId, {
      read: run.read,
      announce: run.announce,
      write: run.write,
      atomic: run.port,
      gate,
      journal: deps.journal,
      warn: deps.warn,
      reportError: deps.reportError
    })
  }
}

export function createDispatchRequestPoller(deps: {
  run: () => Promise<void>
  reportFailure: (error: unknown) => void
}): () => Promise<void> {
  const failures = createFailureReporter(deps.reportFailure)
  return async () => {
    try {
      await deps.run()
      failures.recovered()
    } catch (e) {
      failures.failed(e)
    }
  }
}
