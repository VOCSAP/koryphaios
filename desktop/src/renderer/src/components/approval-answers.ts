/**
 * Draft state and answer building for an AskUserQuestion request served by the
 * Claude Code module. Kept free of React and of '@shared' aliases so bun:test
 * imports it directly; the question shape is restated structurally.
 */

/** Matches the broker's free-text cap, so the counter shows what is kept. */
export const OTHER_MAX = 1000

export interface AnswerableQuestion {
  question: string
  options: ReadonlyArray<{ label: string }>
  multi_select: boolean
}

/** Picked option INDEXES, never labels: two options may not share a label but two questions may. */
export interface QuestionDraft {
  picked: number[]
  other: boolean
  otherText: string
}

/**
 * The questions the answer form renders, or null when it renders none: a
 * permission never shows its questions, and an empty list is no question.
 * The host hides the request's own text when this is non-null, because each
 * fieldset already carries its question.
 */
export function formQuestions<Q>(approval: {
  kind: string
  questions?: ReadonlyArray<Q> | null
}): ReadonlyArray<Q> | null {
  return approval.kind !== 'permission' && approval.questions && approval.questions.length > 0
    ? approval.questions
    : null
}

export function emptyDrafts(questions: ReadonlyArray<AnswerableQuestion>): QuestionDraft[] {
  return questions.map(() => ({ picked: [], other: false, otherText: '' }))
}

function patch(
  drafts: ReadonlyArray<QuestionDraft>,
  index: number,
  change: (d: QuestionDraft) => QuestionDraft
): QuestionDraft[] {
  return drafts.map((d, i) => (i === index ? change(d) : d))
}

/** Single choice replaces the pick and unchecks Other; multiple choice toggles. */
export function toggleOption(
  drafts: ReadonlyArray<QuestionDraft>,
  q: AnswerableQuestion,
  index: number,
  option: number
): QuestionDraft[] {
  return patch(drafts, index, (d) => {
    if (!q.multi_select) return { ...d, picked: [option], other: false }
    const picked = d.picked.includes(option) ? d.picked.filter((p) => p !== option) : [...d.picked, option]
    return { ...d, picked }
  })
}

export function toggleOther(
  drafts: ReadonlyArray<QuestionDraft>,
  q: AnswerableQuestion,
  index: number
): QuestionDraft[] {
  return patch(drafts, index, (d) =>
    q.multi_select ? { ...d, other: !d.other } : { ...d, picked: [], other: true }
  )
}

/** Cut by code point, so a surrogate pair is never split at the bound. */
export function clampOther(text: string): string {
  const points = Array.from(text)
  return points.length > OTHER_MAX ? points.slice(0, OTHER_MAX).join('') : text
}

export function setOtherText(
  drafts: ReadonlyArray<QuestionDraft>,
  index: number,
  text: string
): QuestionDraft[] {
  return patch(drafts, index, (d) => ({ ...d, otherText: clampOther(text) }))
}

export function otherLength(text: string): number {
  return Array.from(text).length
}

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu
const LINE_SPACING = new Set(['\t', '\r', '\n'])

/**
 * The Other text as the broker keeps it: invisible and control characters
 * dropped (tab and line breaks become spaces), whitespace collapsed, trimmed.
 * Judging the raw text would enable Send for an answer the broker refuses.
 */
export function cleanOther(text: string): string {
  return text
    .replace(INVISIBLE, (c) => (LINE_SPACING.has(c) ? ' ' : ''))
    .replace(/\s+/g, ' ')
    .trim()
}

/** An Other text that is empty once cleaned, or repeats a checked label, is no answer. */
export function questionComplete(q: AnswerableQuestion, d: QuestionDraft | undefined): boolean {
  if (!d) return false
  if (d.other) {
    const text = cleanOther(d.otherText)
    if (text === '') return false
    if (d.picked.some((p) => q.options[p]?.label === text)) return false
  }
  return d.picked.length > 0 || d.other
}

export function completedCount(
  questions: ReadonlyArray<AnswerableQuestion>,
  drafts: ReadonlyArray<QuestionDraft>
): number {
  return questions.filter((q, i) => questionComplete(q, drafts[i])).length
}

/**
 * Per question text, the chosen labels in DISPLAY order whatever the click
 * order, then the Other text last; the broker validates exactly that shape.
 * Null while any question is incomplete. Built with Object.fromEntries so a
 * question literally named "__proto__" stays an own key instead of setting
 * the prototype.
 */
export function buildAnswers(
  questions: ReadonlyArray<AnswerableQuestion>,
  drafts: ReadonlyArray<QuestionDraft>
): Record<string, string[]> | null {
  if (questions.length === 0 || drafts.length !== questions.length) return null
  if (!questions.every((q, i) => questionComplete(q, drafts[i]))) return null
  return Object.fromEntries(
    questions.map((q, i) => {
      const d = drafts[i]!
      const labels = q.options.filter((_, o) => d.picked.includes(o)).map((o) => o.label)
      if (d.other) labels.push(cleanOther(d.otherText))
      return [q.question, labels]
    })
  )
}

/** One question with a single choice: each option answers in one click. */
export function isOneClick(questions: ReadonlyArray<AnswerableQuestion>): boolean {
  return questions.length === 1 && !questions[0]!.multi_select
}
