// Text of the startup approval dialog of a repo rules file, and the
// sanitizer for any agent-authored text the Deck shows or logs. The operator
// approves exactly what the dialog shows, so it shows every field of every
// rule, in full; when that does not fit a dialog, the dialog offers no
// Approve button at all and sends the operator to Settings > Rules.
//
// Pure module, no electron: unit-tested under bun.

import { ambiguousAlternationWarnings } from '../shared/ttsr-rules'
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

export function bunMissingNotice(isFr: boolean): string {
  return isFr
    ? "bun n'a pas pu démarrer quand ces règles ont été chronométrées : elles l'ont été sous V8, et le hook qui les applique, lancé par bun, peut ne pas démarrer dans une tuile qui a le même PATH."
    : "bun could not start when these rules were timed: they were timed under V8, and the hook that enforces them, launched by bun, may not start in a tile with the same PATH."
}

/**
 * Warnings shown under the rules: the ambiguous-alternation advisories, then
 * the bun notice when the timing probe could not start bun (`bunUnavailable`
 * is the probe's reason, already reported by the probe itself).
 */
export function approvalWarnings(rules: readonly TtsrRule[], isFr: boolean, bunUnavailable: string | undefined): string[] {
  const warnings = ambiguousAlternationWarnings(rules)
  if (bunUnavailable !== undefined) warnings.push(bunMissingNotice(isFr))
  return warnings
}

/** The full list of rules and their warnings for the dialog, and whether it fits a dialog. */
export function approvalDialogBody(
  rules: readonly TtsrRule[],
  isFr: boolean,
  warnings: readonly string[] = []
): { text: string; fits: boolean } {
  const lines = rules.flatMap((r) => describeRuleForApproval(r, isFr))
  for (const w of warnings) lines.push(`${isFr ? 'avertissement' : 'warning'}: ${displaySafe(w)}`)
  const text = lines.join('\n')
  return { text, fits: text.length <= TTSR_DIALOG_MAX_CHARS && lines.length <= TTSR_DIALOG_MAX_LINES }
}
