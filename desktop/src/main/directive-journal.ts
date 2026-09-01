// Journal wording for a directive card's UNREACHED targets (card 6c380073,
// review round 2). Pure: no electron/node import, so `bun test` exercises the
// exact strings index.ts's executeDirective journals.
//
// WHY THIS IS ITS OWN MODULE, and why a source scan was not enough. The first
// version of this wording lived inline in executeDirective and shipped a
// REGRESSION that a source scan could not see: when nothing matched AND at
// least one id was ambiguous, the message listed only the ambiguous ids and
// SILENTLY DROPPED the plainly-absent ones. A scan proves which SYMBOLS a call
// site reads (`ambiguous` read, not re-derived) and it was green on that
// wording -- the defect was in the COMPOSITION of the message, which only a
// probe over real inputs can catch. Hence: a pure function, three probes
// (absent only, ambiguous only, and BOTH -- the case that was broken), and a
// presence scan at the call site on top.
//
// The stakes are not cosmetic: runDirectiveWave is mark-then-execute, so the
// card is already consumed by the time this text is written. This journal line
// is the ONLY report the operator ever gets, which is what makes a dropped id
// a real loss rather than a typo.

/**
 * One journal fragment per NON-EMPTY category, joined with '; '. `ambiguous`
 * is a SUBSET of `missing` (directive.ts's own contract: an id that matched
 * more than one live tile is a DETAIL of why it is missing, not a competing
 * bucket), so the plainly-absent ids are `missing` minus `ambiguous` -- and
 * both halves are always reported, never one at the expense of the other.
 *
 * Returns '' when both categories are empty, so a caller can skip journaling
 * entirely rather than emitting an empty tail.
 */
export function unreachedTargetsText(missing: readonly string[], ambiguous: readonly string[]): string {
  const ambiguousSet = new Set(ambiguous)
  const plainMissing = missing.filter((p) => !ambiguousSet.has(p))
  const parts = [
    plainMissing.length > 0 ? `no live target: ${plainMissing.join(', ')}` : '',
    ambiguous.length > 0
      ? `refused: ${ambiguous.length} ambiguous (matched more than one live tile): ${ambiguous.join(', ')}`
      : ''
  ].filter(Boolean)
  return parts.join('; ')
}
