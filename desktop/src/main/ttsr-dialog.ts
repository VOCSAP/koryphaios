// Text of the startup approval dialog of a repo rules file, and the
// sanitizer for any agent-authored text the Deck shows or logs. The operator
// approves exactly what the dialog shows, so it shows every field of every
// rule, in full; when that does not fit a dialog, the dialog offers no
// Approve button at all and sends the operator to Settings > Rules.
//
// Pure module, no electron: unit-tested under bun.

import type { TtsrRule } from '../shared/ttsr-types'

/** Longest dialog body that still offers Approve in place. */
export const TTSR_DIALOG_MAX_CHARS = 4000
export const TTSR_DIALOG_MAX_LINES = 60

/**
 * Agent-authored text made inert for display: line breaks become " / " so a
 * message cannot start a line that reads as the dialog's own text, and
 * every other control, bidi-override or invisible format character becomes
 * U+FFFD.
 */
export function displaySafe(text: string): string {
  return text
    .replace(/\r\n|\r|\n|\u2028|\u2029/g, ' / ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '\ufffd')
}

/** One rule, every field the hook acts on, each agent string sanitized. */
export function describeRuleForApproval(rule: TtsrRule, isFr: boolean): string[] {
  const s = displaySafe
  const lines = [`• ${s(rule.id)} [${s(rule.mode)}, ${s(rule.event)}, ${rule.tools.map(s).join('/')}, ${isFr ? 'champ' : 'field'} ${s(rule.field)}]`]
  if (rule.paths && rule.paths.length > 0) lines.push(`  ${isFr ? 'chemins' : 'paths'}: ${rule.paths.map(s).join(', ')}`)
  lines.push(`  ${isFr ? 'motif' : 'pattern'}: /${s(rule.pattern)}/${s(rule.flags ?? '')}`)
  lines.push(`  message: ${s(rule.message)}`)
  return lines
}

/** The full list of rules for the dialog, and whether it fits a dialog. */
export function approvalDialogBody(rules: readonly TtsrRule[], isFr: boolean): { text: string; fits: boolean } {
  const lines = rules.flatMap((r) => describeRuleForApproval(r, isFr))
  const text = lines.join('\n')
  return { text, fits: text.length <= TTSR_DIALOG_MAX_CHARS && lines.length <= TTSR_DIALOG_MAX_LINES }
}
