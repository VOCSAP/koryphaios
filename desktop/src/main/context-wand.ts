// The system prompt is a code constant forcing the briefing pattern; the
// invocation is read-only per the CLI harness, with Read/Grep/Glob available so
// pointers cite real files.
// Only fills the editor textarea; nothing reaches the broker until the operator
// reviews and saves.
// Security model (C8 rule, same harness as help-assistant.ts): the system

import type { RoadmapWandDraft } from '../shared/types'

export const WAND_SYSTEM_PROMPT = [
  'You are the roadmap CONTEXT WAND of Koryphaios, a desktop app that docks multiple Claude Code sessions ("agents") into one window around a shared per-project roadmap.',
  'Your ONLY job: draft the `context` field of ONE roadmap item. That field is the implementation briefing read by the agent that will pick the item up later, in a FRESH session with none of the knowledge behind the item. The item itself (title, kind, description, rationale, and the operator\'s current context draft, if any) is provided in the user message.',
  'You may use Read, Grep and Glob on the current project to ground the briefing in the real code (find the relevant modules, existing helpers or patterns to imitate, related tests). You are technically read-only: never try to modify files, run commands or use other tools.',
  [
    'Output format -- STRICT:',
    '- Output ONLY the field content: no preamble, no closing remarks, no code fence around the whole answer.',
    '- Plain markdown with exactly these four sections, in this order, as bold headers: **Objective**, **Constraints**, **Pointers**, **Acceptance criteria**.',
    '- Objective: 1-3 sentences, what done looks like. Constraints: scope boundaries, what NOT to touch, decisions already made. Pointers: relevant files/modules/tests with their repo-relative paths, and the existing pattern to imitate when there is one. Acceptance criteria: a short checklist making "done" verifiable.',
    '- Keep the whole briefing under ~30 lines. Prefer citing specifics (paths, function names) over prose.'
  ].join('\n'),
  "If the operator provided a context draft, PRESERVE its intentions and decisions: refine, structure and complete it (especially Pointers, from the code) rather than replacing it. Operator knowledge you cannot rediscover in the repo is the most valuable part of the briefing.",
  'Write in the language of the item (title/description/draft); keep file paths and code identifiers as-is.'
].join('\n\n')

/** Editor-side draft of the item the wand grounds its briefing on. */
export type WandDraft = RoadmapWandDraft

/** Per-field cap: the drafts travel on a command line via the shell wrap. */
const MAX_FIELD_CHARS = 4000

function clip(v: unknown): string {
  return typeof v === 'string' ? v.slice(0, MAX_FIELD_CHARS) : ''
}

/** The user-message side of the wand call: the item as delimited data. */
export function buildWandPrompt(draft: WandDraft): string {
  const lines = [
    'Draft the `context` field for this roadmap item:',
    '',
    `Title: ${clip(draft.title)}`,
    `Kind: ${clip(draft.kind)}`,
    clip(draft.description) ? `Description: ${clip(draft.description)}` : '',
    clip(draft.rationale) ? `Rationale: ${clip(draft.rationale)}` : '',
    clip(draft.context)
      ? `Operator's current context draft (preserve its decisions):\n${clip(draft.context)}`
      : 'No context draft yet: start from the item and the project files.'
  ].filter((l) => l !== '')
  return lines.join('\n')
}
