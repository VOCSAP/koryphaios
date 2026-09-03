/**
 * Approval.options carries two opposite semantics depending on kind:
 * 'permission' poses ["Allow","Deny"] as labels for the CLI's Ink chooser,
 * which accepts allow/deny only — typing the label back as free text leaves the
 * agent stuck on a menu that doesn't take text input.
 * 'question' lets the agent choose its own options, so there the label is the
 * answer and answerKind: 'text' is correct — nothing is typed into a terminal,
 * the broker relays it as a peer message.
 * Discrimination is always on kind, never on the option's label string — an
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
    // Only optionIndex===1 (the real second Ink option) is a decided 'deny';
    // every other index, including a future third option or NaN, degrades to
    // 'text' rather than silently becoming the destructive deny verdict.
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
