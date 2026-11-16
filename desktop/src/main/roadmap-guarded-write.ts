// Kept free of Electron imports so the CAS decisions stay executable under bun test.

import type { RoadmapItem, RoadmapUpsertFields } from '../shared/types'
import { isRoadmapStaleSaveError } from '../../../shared/roadmap-append'
import { operatorStopRequest } from './roadmap-release-request'
import { RoadmapRequestError } from './roadmap-service'

export interface GuardedWriteIo {
  /** The card as it is now, or null when it is deleted or archived. */
  read: (id: string) => Promise<RoadmapItem | null>
  write: (fields: RoadmapUpsertFields) => Promise<RoadmapItem>
  trace: (line: string) => void
}

export type GuardedWriteResult =
  | { written: true; item: RoadmapItem }
  | { written: false; reason: 'gone' | 'ineligible' }

/** Null means the card must not be written. */
export type GuardedDecision = (card: RoadmapItem) => RoadmapUpsertFields | null

function isStaleSave(e: unknown): boolean {
  return e instanceof RoadmapRequestError && e.status === 409 && isRoadmapStaleSaveError(e.message)
}

function withRevision(fields: RoadmapUpsertFields, card: RoadmapItem): RoadmapUpsertFields {
  return card.content_rev === undefined ? fields : { ...fields, expected_content_rev: card.content_rev }
}

/**
 * One retry only: a second stale save is thrown to the caller's own failure
 * path, since a card changing under two writes in a row is not a race to win.
 */
export async function writeGuarded(
  label: string,
  snapshot: RoadmapItem,
  decide: GuardedDecision,
  io: GuardedWriteIo
): Promise<GuardedWriteResult> {
  const skip = (reason: 'gone' | 'ineligible'): GuardedWriteResult => {
    io.trace(`${label}: card ${snapshot.id} "${snapshot.title}" is ${reason} since it was read, nothing written`)
    return { written: false, reason }
  }
  const first = decide(snapshot)
  if (first === null) return skip('ineligible')
  try {
    return { written: true, item: await io.write(withRevision(first, snapshot)) }
  } catch (e) {
    if (!isStaleSave(e)) throw e
  }
  const fresh = await io.read(snapshot.id)
  if (fresh === null) return skip('gone')
  const second = decide(fresh)
  if (second === null) return skip('ineligible')
  return { written: true, item: await io.write(withRevision(second, fresh)) }
}

const CLOSED_STATUSES: ReadonlySet<string> = new Set(['done', 'archived'])

function closedSince(snapshot: RoadmapItem, card: RoadmapItem): boolean {
  return CLOSED_STATUSES.has(card.status) && card.status !== snapshot.status
}

export function markDirectiveDone(snapshot: RoadmapItem, io: GuardedWriteIo): Promise<GuardedWriteResult> {
  return writeGuarded(
    'directive done-write',
    snapshot,
    (card) => (closedSince(snapshot, card) ? null : { id: card.id, queue: null, status: 'done' }),
    io
  )
}

export function unqueueDispatched(snapshot: RoadmapItem, io: GuardedWriteIo): Promise<GuardedWriteResult> {
  return writeGuarded(
    'dispatch unqueue',
    snapshot,
    (card) =>
      closedSince(snapshot, card)
        ? null
        : { id: card.id, queue: null, status: card.status === 'idea' ? 'planned' : card.status },
    io
  )
}

export function assignInProgress(snapshot: RoadmapItem, io: GuardedWriteIo): Promise<GuardedWriteResult> {
  return writeGuarded(
    'assignment',
    snapshot,
    (card) => (closedSince(snapshot, card) ? null : { id: card.id, status: 'in_progress', queue: null }),
    io
  )
}

export function requestOperatorStop(snapshot: RoadmapItem, io: GuardedWriteIo): Promise<GuardedWriteResult> {
  return writeGuarded(
    'operator stop',
    snapshot,
    (card) => (card.status === snapshot.status ? operatorStopRequest(card) : null),
    io
  )
}
