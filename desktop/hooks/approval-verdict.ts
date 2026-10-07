export type PermissionVerdict = { kind: 'allow' } | { kind: 'deny' } | { kind: 'wait' } | { kind: 'none' }

// Own data properties only: an inherited or getter-backed field never counts as an answer.
function own(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return undefined
  const desc = Object.getOwnPropertyDescriptor(obj, key)
  return desc && 'value' in desc ? desc.value : undefined
}

/**
 * Reads the approval helper's output for the row `expectedId`. Only an answered,
 * hook-routed row of that id with answer_kind allow or deny settles the call;
 * anything else is `none`, which hands the call back to the native menu.
 */
export function verdictOf(expectedId: string, helperOutput: unknown): PermissionVerdict {
  if (expectedId === '' || own(helperOutput, 'ok') !== true) return { kind: 'none' }
  const approval = own(helperOutput, 'approval')
  // A still-pending wait carries no approval, so it cannot name its id.
  if (own(helperOutput, 'pending') === true) return approval === undefined ? { kind: 'wait' } : { kind: 'none' }
  if (own(approval, 'id') !== expectedId || own(approval, 'reply_route') !== 'hook') return { kind: 'none' }
  const status = own(approval, 'status')
  if (status === 'pending' || status === 'expired_notif') return { kind: 'wait' }
  if (status !== 'answered') return { kind: 'none' }
  const answerKind = own(approval, 'answer_kind')
  if (answerKind === 'allow') return { kind: 'allow' }
  if (answerKind === 'deny') return { kind: 'deny' }
  return { kind: 'none' }
}
