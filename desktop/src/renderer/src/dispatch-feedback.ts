import type { AssignResult, DispatchResult, StopResult } from '@shared/types'

export interface ToastFeedback {
  key: string
  level: 'success' | 'info'
  params?: Record<string, string | number>
}

// Refusals proving the card or the queue moved between the read and the broker's
// transaction: nothing was written or announced, so retrying on a fresh read is safe.
const CHANGED_REASONS = new Set(['card-changed', 'queue-changed', 'ineligible'])

// The broker refused before writing anything; a manual dispatch leaves no journal line for these.
const REFUSED_REASONS = new Set(['write-failed', 'cancelled-before-execution'])

const isUnconfirmed = (r: { delivery?: string; reason?: string }): boolean =>
  r.delivery === 'unknown' || r.reason === 'unconfirmed'

/** An unconfirmed delivery is checked first: it must never read as "nothing sent", which invites a resend. */
export function dispatchFeedback(r: DispatchResult): ToastFeedback {
  if (isUnconfirmed(r)) return { key: 'toast.orderUnconfirmed', level: 'info' }
  if (r.sent) {
    const sent = r.dispatched?.length ?? r.count ?? (r.title !== undefined ? 1 : 0)
    // Skipped cards were announced to the lead and closed afterwards: the lead holds orders for closed cards.
    const skipped = r.skipped?.length ?? 0
    if (skipped > 0) return { key: 'toast.dispatchSkipped', level: 'info', params: { sent, n: skipped } }
    const notSent = r.notSent?.length ?? 0
    if (notSent > 0) return { key: 'toast.dispatchPartial', level: 'info', params: { sent, n: notSent } }
    return { key: 'toast.dispatched', level: 'success' }
  }
  if (r.reason === 'no-lead') return { key: 'toast.dispatchNoLead', level: 'info' }
  if (r.reason && CHANGED_REASONS.has(r.reason)) return { key: 'toast.orderCardChanged', level: 'info' }
  if (r.reason && REFUSED_REASONS.has(r.reason)) return { key: 'toast.orderNotSent', level: 'info' }
  return { key: 'toast.dispatchFailed', level: 'info' }
}

export function assignFeedback(r: AssignResult): ToastFeedback {
  if (isUnconfirmed(r)) return { key: 'toast.orderUnconfirmed', level: 'info' }
  if (r.sent) {
    if (r.writeSkipped) return { key: 'toast.assignSkipped', level: 'info' }
    return { key: 'toast.assignSent', level: 'success' }
  }
  if (r.reason && CHANGED_REASONS.has(r.reason)) return { key: 'toast.orderCardChanged', level: 'info' }
  if (r.reason && REFUSED_REASONS.has(r.reason)) return { key: 'toast.orderNotSent', level: 'info' }
  return { key: 'toast.assignFailed', level: 'info' }
}

export function stopFeedback(r: StopResult): ToastFeedback {
  if (!r.stopped) {
    if (r.reason === 'card-changed') return { key: 'toast.stopCardChanged', level: 'info' }
    if (r.reason === 'not-found') return { key: 'toast.stopNotFound', level: 'info' }
    return { key: 'toast.stopFailed', level: 'info' }
  }
  if (r.via === 'supervisor') return { key: 'toast.stopSupervisor', level: 'success' }
  if (r.via === 'broadcast') return { key: 'toast.stopBroadcast', level: 'success' }
  return { key: 'toast.stopNoPeers', level: 'info' }
}
