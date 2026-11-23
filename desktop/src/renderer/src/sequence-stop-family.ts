import type { SequenceStopReason } from '../../shared/types'

export type StopFamily =
  | 'cancelled'
  | 'revoked'
  | 'aborted'
  | 'turnFailed'
  | 'sessionEnded'
  | 'injectionRefused'
  | 'notStarted'
  | 'trackingLost'

/** `fault` paints the stopped banner amber: something broke, as opposed to a stop someone asked for. */
export interface StopFamilyEntry {
  family: StopFamily
  fault: boolean
}

const TRACKING_LOST: StopFamilyEntry = { family: 'trackingLost', fault: false }

export const STOP_FAMILIES = {
  'operator-cancelled': { family: 'cancelled', fault: false },
  revoked: { family: 'revoked', fault: false },
  'turn-aborted': { family: 'aborted', fault: false },
  'turn-error': { family: 'turnFailed', fault: true },
  'turn-refused': { family: 'turnFailed', fault: true },
  'compact-failed': { family: 'turnFailed', fault: true },
  'session-ended': { family: 'sessionEnded', fault: false },
  'source-changed': { family: 'sessionEnded', fault: false },
  'injection-no-terminal': { family: 'injectionRefused', fault: true },
  'injection-busy-timeout': { family: 'injectionRefused', fault: true },
  'injection-refused-modal': { family: 'injectionRefused', fault: true },
  'injection-screen-unavailable': { family: 'injectionRefused', fault: true },
  'injection-needs-attention': { family: 'injectionRefused', fault: true },
  'injection-rate-limited': { family: 'injectionRefused', fault: true },
  'no-command-run': { family: 'notStarted', fault: true },
  'no-turn-start': { family: 'notStarted', fault: false },
  'unknown-command': { family: 'notStarted', fault: false },
  'dialogue-command': { family: 'notStarted', fault: false },
  'empty-plan': TRACKING_LOST,
  'bad-nonce': TRACKING_LOST,
  'step-too-long': TRACKING_LOST,
  'bad-args': TRACKING_LOST,
  'foreign-command': TRACKING_LOST,
  'foreign-turn': TRACKING_LOST,
  'unexpected-turn': TRACKING_LOST,
  'turn-overlap': TRACKING_LOST,
  'turn-mismatch': TRACKING_LOST,
  'seq-gap': TRACKING_LOST,
  'seq-regressed': TRACKING_LOST,
  'signal-refused': TRACKING_LOST,
  'step-mismatch': TRACKING_LOST,
  'quiescence-unknown': TRACKING_LOST
} as const satisfies Record<SequenceStopReason, StopFamilyEntry>

/** Unknown reasons fall back to lost tracking and never claim a fault. */
export function stopFamily(reason: string | null): StopFamilyEntry {
  if (reason !== null && Object.hasOwn(STOP_FAMILIES, reason)) return STOP_FAMILIES[reason as SequenceStopReason]
  return TRACKING_LOST
}
