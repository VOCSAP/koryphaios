import type { SessionSkillRefusal } from '../../shared/types'

export interface SequenceToast {
  key: string
  level: 'error'
  params?: Record<string, string>
}

/** `true` puts main's `detail` in the toast: a rule or tile condition, never a command line. */
const REFUSAL_TOASTS = {
  'bad-request': ['toast.skillRefused.badRequest', false],
  'unknown-tile': ['toast.skillRefused.unknownTile', false],
  'not-eligible': ['toast.skillRefused.notEligible', true],
  'settings-unreadable': ['toast.skillRefused.settingsUnreadable', false],
  'command-refused': ['toast.skillRefused.commandRefused', true],
  'bad-plan': ['toast.skillRefused.badPlan', false],
  'no-source': ['toast.skillRefused.noSource', false],
  'sequence-active': ['toast.skillRefused.sequenceActive', false]
} as const satisfies Record<SessionSkillRefusal, readonly [string, boolean]>

/** An unknown refusal falls back to a generic "not started" toast carrying its code. */
export function skillRefusalToast(r: { reason: string; detail?: string }): SequenceToast {
  if (!Object.hasOwn(REFUSAL_TOASTS, r.reason)) {
    return { key: 'toast.skillRefused.other', level: 'error', params: { detail: r.detail ?? r.reason } }
  }
  const [key, withDetail] = REFUSAL_TOASTS[r.reason as SessionSkillRefusal]
  return withDetail ? { key, level: 'error', params: { detail: r.detail ?? r.reason } } : { key, level: 'error' }
}
