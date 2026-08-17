/**
 * What clicking option[N] of a Courrier approval chip should DO (card
 * c7df3781).
 *
 * `Approval.options` carries two OPPOSITE semantics depending on `kind`:
 *  - 'permission' (desktop/hooks/approval-hook.ts's `buildApprovalRequest`,
 *    `reply_route: 'pty'`) poses `["Allow", "Deny"]` as LABELS. The answer
 *    the CLI's Ink chooser accepts is allow/deny, never free text — typing
 *    the label back (`answerKind: 'text'`) leaves the agent stuck on a menu
 *    that does not take text input.
 *  - 'question' (`ask_operator`, `reply_route: 'channel'`) lets the AGENT
 *    choose the options; there the label IS the answer, and `answerKind:
 *    'text'` is correct — nothing is typed into a terminal, the broker
 *    relays it as a peer message.
 *
 * Discrimination is on `kind`, NEVER on the option's label string — an
 * English UI label is not a stable verdict identifier.
 */

// Deliberately NOT importing `ApprovalKind` from '@shared/types': this
// module is imported directly by a bun:test file with no tsconfig
// resolving that alias (see BUN.md / desktop pure-module convention), so
// the union is duplicated here structurally instead.
export type VerdictApprovalKind = 'permission' | 'question' | 'plan'
export type VerdictAnswerKind = 'allow' | 'deny' | 'text'

export function verdictAnswerKindFor(
  kind: VerdictApprovalKind,
  optionIndex: number
): VerdictAnswerKind {
  if (kind === 'permission') {
    // Mutation review, MAJOR-1: this used to be `optionIndex === 0 ? 'allow'
    // : 'deny'` -- a CATCH-ALL where every index other than 0 (a future
    // third Ink option such as "Allow, and don't ask again", a stray -1, or
    // NaN) silently became the DESTRUCTIVE 'deny' verdict, with no test
    // moving. Only optionIndex===1 -- the real second option emitted today
    // by buildApprovalRequest's `["Allow", "Deny"]` -- is a DECIDED 'deny'.
    // Every other index (including NaN: NaN===0 and NaN===1 are both false,
    // so it falls through here too) degrades to 'text' instead: benign
    // (retype the label) rather than destructive.
    if (optionIndex === 1) return 'deny'
    if (optionIndex === 0) return 'allow'
    return 'text'
  }
  // Mutation review, MINOR-3: 'plan' is a valid ApprovalKind (shared/types.ts)
  // with no current producer (grepped: only declarations/fixtures mention
  // it). Explicit branch, not a fallthrough into the 'question' case below --
  // 'text' is the right default TODAY because nothing emits a 'plan'
  // approval and the channel is not a pty chooser, but that is a DECISION
  // that can be revisited, not an omission a future reader has to rediscover.
  if (kind === 'plan') return 'text'
  return 'text'
}
