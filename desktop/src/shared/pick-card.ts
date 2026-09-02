// "A review finding becomes a roadmap card" (Card review-to-roadmap-card):
// pure mapping from a design-review PickAnnotation (or a single pick-context
// dialog note) to roadmap fields, so a review finding can be filed without
// the operator retyping selector/bounds/screenshot/feedback by hand. Pure,
// no DOM, no window.api -- both call sites (BrowserView.tsx's review panel
// "Create cards", the pick-context dialog's "Create a card") build the
// window.api.roadmapUpsert payload / openRoadmapDraft seed by calling into
// here, this module never performs the write itself.

import type {
  ElementPick,
  PickAnnotation,
  PickAnnotationIntent,
  PickAnnotationPriority,
  PickNote,
  RoadmapKind,
  RoadmapPriority,
  RoadmapUpsertFields
} from './types'
import { annotationLabel, formatAnnotationSection, formatPickDetails } from './pick-prompt'
import { isParseableUrl, sanitizePickUrl } from './pick-security'

/**
 * What the operator wants done (PickAnnotationIntent) maps to what KIND of
 * roadmap card that is -- a fix reads as a bug, a change as a feature
 * request, a question or an approval as an idea (neither is actionable work
 * yet). A Record (not a switch) so TypeScript rejects the mapping at compile
 * time if PickAnnotationIntent ever grows a member this file forgets.
 */
const INTENT_TO_KIND: Record<PickAnnotationIntent, RoadmapKind> = {
  fix: 'bug',
  change: 'feature',
  question: 'idea',
  approve: 'idea'
}

export function intentToKind(intent: PickAnnotationIntent): RoadmapKind {
  return INTENT_TO_KIND[intent]
}

/** PickAnnotationPriority (urgency) to RoadmapPriority (MoSCoW), same Record-for-exhaustiveness reasoning as INTENT_TO_KIND. */
const PRIORITY_TO_ROADMAP: Record<PickAnnotationPriority, RoadmapPriority> = {
  blocking: 'must',
  important: 'should',
  suggestion: 'could'
}

export function priorityToRoadmap(priority: PickAnnotationPriority): RoadmapPriority {
  return PRIORITY_TO_ROADMAP[priority]
}

/** First `n` words of `text`, ellipsised when truncated -- local copy of BrowserView.tsx's helper (not exported there, and this module must stay DOM/renderer-free). */
function firstWords(text: string, n: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return ''
  return words.slice(0, n).join(' ') + (words.length > n ? '…' : '')
}

/** Sanitized URL pathname for a fallback title -- never the raw query/fragment (sanitizePickUrl's guarantee); 'page' when the url is empty, unparsable, or the sanitized pathname is itself empty. */
function pathnameOfSafe(url: string): string {
  const safe = sanitizePickUrl(url)
  if (!safe) return 'page'
  try {
    return new URL(safe).pathname || 'page'
  } catch {
    return 'page'
  }
}

/** True for the single-pick dialog's { pick, note } shape, as opposed to a persisted-review PickAnnotation. Discriminated on `note`: a PickAnnotation never carries that key. */
function isNoteTarget(
  a: PickAnnotation | { pick: ElementPick; note: PickNote }
): a is { pick: ElementPick; note: PickNote } {
  return 'note' in a
}

/**
 * Title for a roadmap card seeded from a review finding: the first 8 words
 * of the operator's comment when there is one (that is what the operator
 * actually said, so it beats any derived label), else `<label> on
 * <pathname>` from the target's own label (annotationLabel) and the page's
 * sanitized pathname. Capped at 120 chars; a title that comes out empty
 * after capping/trimming (comment was pure whitespace, tagName somehow
 * empty) falls back to a neutral 'Design finding' rather than shipping an
 * empty roadmap card title.
 */
export function cardTitle(
  a: PickAnnotation | { pick: ElementPick; note: PickNote },
  page: { url: string }
): string {
  const comment = isNoteTarget(a) ? a.note.comment : a.comment
  const trimmedComment = comment.trim()
  const label = isNoteTarget(a)
    ? annotationLabel({ pick: a.pick } as unknown as PickAnnotation)
    : annotationLabel(a)
  const title = trimmedComment ? firstWords(trimmedComment, 8) : `${label} on ${pathnameOfSafe(page.url)}`
  const capped = title.slice(0, 120).trim()
  return capped || 'Design finding'
}

/**
 * Full roadmap-card fields for ONE review annotation (BrowserView.tsx's
 * "Create cards" batch action, one window.api.roadmapUpsert call per
 * annotation). `description` reuses formatAnnotationSection verbatim -- the
 * same selector/source/bounds/styles/screenshot/HTML/feedback lines the
 * batch report shows the agent -- so the card and the report never drift.
 * Exactly the fields listed below: no `id` (this is always a creation, never
 * a patch) and no `project_key` (the main process injects that, see
 * RoadmapUpsertFields's own doc comment) -- a pick-list build, never a
 * spread of `a` into the result, so a future PickAnnotation field cannot
 * leak into a roadmap card unnoticed.
 */
export function annotationToCardFields(
  a: PickAnnotation,
  page: { url: string; viewport?: string }
): RoadmapUpsertFields {
  const sanitized = sanitizePickUrl(page.url)
  const safeUrl = sanitized || (isParseableUrl(page.url) ? 'current page' : page.url)
  const description = formatAnnotationSection(a, annotationLabel(a)).join('\n').trimEnd()
  const context = page.viewport
    ? `Created from the Deck browser review of ${safeUrl}\nViewport: ${page.viewport}`
    : `Created from the Deck browser review of ${safeUrl}`
  return {
    title: cardTitle(a, page),
    kind: intentToKind(a.intent),
    priority: priorityToRoadmap(a.priority),
    status: 'planned',
    description,
    context,
    tags: ['design-review']
  }
}

/**
 * Roadmap-draft SEED for the single-pick dialog's "Create a card" button
 * (store.ts's `openRoadmapDraft`) -- matches that function's seed shape
 * exactly ({ title, kind, description }), no `priority`/`context`/`tags`:
 * this path opens the create FORM for the operator to finish, it does not
 * write a card itself (contract shared with the wand/files-view seeds this
 * mirrors, see RoadmapView.tsx's roadmapSeed effect). `note.intent` may be
 * unset (operator sent the dialog untouched) -- defaults to 'change' so an
 * unclassified finding still lands as a feature-shaped draft, the same
 * default posture the dialog's own intent `<select>` opens on.
 */
export function pickNoteToCardSeed(
  pick: ElementPick,
  note: PickNote,
  page: { url: string }
): { title: string; kind: RoadmapKind; description: string } {
  const sanitized = sanitizePickUrl(page.url)
  const safeUrl = sanitized || (isParseableUrl(page.url) ? 'current page' : page.url)
  const selector = pick.selectors[0]?.value ?? pick.tagName
  const lead = `<${pick.tagName}> ${selector} on ${safeUrl}`
  const details = formatPickDetails(pick, note)
  const description = details ? `${lead}\n${details}`.trimEnd() : lead
  return {
    title: cardTitle({ pick, note }, page),
    kind: intentToKind(note.intent ?? 'change'),
    description
  }
}
