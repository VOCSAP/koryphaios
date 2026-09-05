// Pure comparison of the two sides of a replication conflict, shared by the
// resolution dialog and its test. No React, no electron, no @shared alias:
// this module is importable by a relative path from bun test.

import {
  ROADMAP_SYNC_CONTENT_FIELDS,
  type RoadmapSyncConflict,
  type RoadmapSyncContent,
  type RoadmapSyncContentField,
  type RoadmapSyncResolution
} from './types'

/**
 * The three arbitrations, as data: the main-process IPC guard validates
 * against this list and the dialog renders one button per entry, so a fourth
 * choice cannot reach the broker through a button nobody validated.
 */
export const ROADMAP_SYNC_RESOLUTIONS: readonly RoadmapSyncResolution[] = [
  'remote',
  'local',
  'merge_reopen'
]

/**
 * The two fields whose divergence is a LIFECYCLE transition rather than an
 * edit: a card closed on one side and enriched on the other is the conflict
 * the operator must read first, so they are pulled to the top of the list
 * instead of appearing in column order.
 */
export const ROADMAP_SYNC_TRANSITION_FIELDS: readonly RoadmapSyncContentField[] = [
  'status',
  'deleted_at'
]

export interface RoadmapSyncFieldDiff {
  field: RoadmapSyncContentField
  local: unknown
  remote: unknown
  /** The common-base value; undefined when the card had never been synced. */
  base: unknown
  /** False when `base` is null: neither side can be said to have "changed". */
  hasBase: boolean
  localChanged: boolean
  remoteChanged: boolean
  /** True for `status` / `deleted_at`, which are rendered first and marked. */
  transition: boolean
}

/**
 * Structural equality over the shapes a content field can hold: a string, a
 * string array, a boolean or null. Arrays are compared element-wise -- `===`
 * on two arrays is always false, which would report every card as differing
 * in `tags` and drown the real divergence.
 */
export function sameSyncValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false
    return a.length === b.length && a.every((x, i) => x === b[i])
  }
  return a === b
}

function pick(content: RoadmapSyncContent | Record<string, unknown> | null, field: string): unknown {
  return content === null ? undefined : (content as Record<string, unknown>)[field]
}

/**
 * The fields that actually DIFFER between the two sides, transition fields
 * first, then column order. A field equal on both sides is dropped: showing it
 * would bury the three or four lines the operator has to arbitrate under
 * fifteen identical ones.
 */
export function conflictFieldDiffs(conflict: RoadmapSyncConflict): RoadmapSyncFieldDiff[] {
  const base = conflict.base
  const ordered = [
    ...ROADMAP_SYNC_TRANSITION_FIELDS,
    ...ROADMAP_SYNC_CONTENT_FIELDS.filter((f) => !ROADMAP_SYNC_TRANSITION_FIELDS.includes(f))
  ]
  const out: RoadmapSyncFieldDiff[] = []
  for (const field of ordered) {
    const local = pick(conflict.local as unknown as Record<string, unknown>, field)
    const remote = pick(conflict.remote as unknown as Record<string, unknown>, field)
    if (sameSyncValue(local, remote)) continue
    const baseValue = pick(base, field)
    out.push({
      field,
      local,
      remote,
      base: baseValue,
      hasBase: base !== null,
      localChanged: base !== null && !sameSyncValue(local, baseValue),
      remoteChanged: base !== null && !sameSyncValue(remote, baseValue),
      transition: ROADMAP_SYNC_TRANSITION_FIELDS.includes(field)
    })
  }
  return out
}

/** Localized words the formatter needs; supplied by the caller's dictionary. */
export interface SyncValueLabels {
  /** An empty string or an empty list. */
  empty: string
  /** A null value (no deletion date, no directive). */
  none: string
  yes: string
  no: string
}

/**
 * One display line for a content value. Never returns an empty string: a blank
 * cell reads as "this side is missing" instead of "this side is empty", which
 * is exactly the distinction the operator is arbitrating.
 */
export function formatSyncValue(value: unknown, labels: SyncValueLabels): string {
  if (value === null || value === undefined) return labels.none
  if (typeof value === 'boolean') return value ? labels.yes : labels.no
  if (Array.isArray(value)) return value.length === 0 ? labels.empty : value.join(', ')
  const text = String(value)
  return text.length === 0 ? labels.empty : text
}

/**
 * Dispatch-queue positions the upstream order overwrote BETWEEN two readings
 * of the replica status, or null when nothing can be announced yet.
 *
 * `queue_replaced` is cumulative for the lifetime of the local broker, so the
 * raw number is never what the operator is told: a Deck attaching to a broker
 * that has been replicating for a day would announce that whole day's losses
 * as if they had just happened.
 *
 * - `prev === null` (nothing observed yet) -> null: the first reading only
 *   establishes the baseline. A Deck restart must not replay history.
 * - the counter went DOWN (the local broker restarted, its counter with it)
 *   -> 0: silently re-baseline rather than report a negative or a fake surge.
 * - the counter is absent (a non-replica or older broker) -> 0: there is
 *   nothing to compare, and a missing field is not a loss.
 */
export function queueReplacedDelta(prev: number | null, next: number | undefined): number | null {
  if (typeof next !== 'number' || !Number.isFinite(next)) return 0
  if (prev === null) return null
  return next > prev ? next - prev : 0
}

/**
 * The baseline to remember after that reading. Kept next to the delta so the
 * two halves of one decision cannot drift: a counter that was not reported
 * leaves the baseline where it was, and never resets it to "never seen".
 */
export function nextQueueReplacedSeen(prev: number | null, next: number | undefined): number | null {
  return typeof next === 'number' && Number.isFinite(next) ? next : prev
}

/**
 * Positions still waiting to be announced after observing `delta`.
 *
 * The toast throttle (one per key per 5 s) DROPS a repeat, it does not queue
 * it, while the baseline advances regardless -- so a second lossy pass inside
 * the throttle window would be lost for good. Accumulating means the next
 * toast that gets through names every position, not only the latest batch.
 *
 * `null` (first observation) and 0 leave the pending count alone: neither is
 * something to announce, and neither cancels what is already waiting.
 */
export function pendingQueueReplaced(pending: number, delta: number | null): number {
  return delta === null || delta <= 0 ? pending : pending + delta
}
