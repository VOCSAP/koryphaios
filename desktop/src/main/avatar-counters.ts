import { MAX_AVATAR_COUNTER } from '../shared/avatar-protocol'
import type { AvatarDeckCounters } from '../shared/avatar-state'
import { awaitsModuleVerdict, type HookAwaitRow } from '../shared/hook-await'
import type { SessionRuntime } from '../shared/types'
import { reportError } from './log'

export interface AvatarCounterProjection {
  counters: AvatarDeckCounters
  unread: number
}

function emptyCounters(): AvatarDeckCounters {
  return {
    working: 0,
    idle: 0,
    unknown: 0,
    waiting: 0,
    exited: 0,
    rateLimited: 0
  }
}

export function isAvatarCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_AVATAR_COUNTER
}

function traceInvalidUnread(value: unknown): void {
  reportError('avatar-counters', `invalid inbox unread count (${String(value)}), bounded before the Avatar snapshot`)
}

/** The Avatar refuses the whole snapshot over one invalid counter, so an invalid unread count is bounded rather than sent. */
function boundedUnread(value: unknown, onInvalid: (value: unknown) => void): number {
  if (isAvatarCounter(value)) return value
  onInvalid(value)
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) return 0
  return Math.min(Math.trunc(value), MAX_AVATAR_COUNTER)
}

/**
 * `waiting` counts the tiles waiting on the operator plus the open Courrier
 * requests no tile waits on (ask_operator, a hook row without tile_ref). A row
 * a tile's module awaits is already counted through that tile's needsAttention.
 */
export function projectAvatarCounters(
  sessions: SessionRuntime[],
  pendingRows: readonly HookAwaitRow[] = [],
  unread = 0,
  onInvalidUnread: (value: unknown) => void = traceInvalidUnread
): AvatarCounterProjection {
  const counters = emptyCounters()

  for (const session of sessions) {
    if (session.status === 'exited') {
      counters.exited += 1
    } else if (session.needsAttention) {
      counters.waiting += 1
    } else if (session.rateLimited) {
      counters.rateLimited += 1
    } else {
      counters[session.activity] += 1
    }
  }

  for (const row of pendingRows) {
    const open = row.status === 'pending' || row.status === 'expired_notif'
    if (open && !awaitsModuleVerdict(row)) counters.waiting += 1
  }

  return { counters, unread: boundedUnread(unread, onInvalidUnread) }
}
