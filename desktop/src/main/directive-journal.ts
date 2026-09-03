// Pure module (no electron/node import) so bun test exercises the exact wording
// index.ts's executeDirective journals.
// A composition-level bug (right ids present, wrong bucket) survives a source
// scan since call sites still read the correct symbols -- only a probe over
// real inputs (absent-only, ambiguous-only, both) catches it.

import type { UnreachedDirectiveTarget } from '../shared/types'

/**
 * The plainly-absent half of `missing`: everything that is not annotated as
 * ambiguous. Shared by the two exports below so the JOURNAL TEXT and the
 * STRUCTURED report can never disagree about which id is absent and which is
 * refused-because-ambiguous -- the exact split whose earlier inline version
 * silently dropped a whole category.
 */
function plainMissing(missing: readonly string[], ambiguous: readonly string[]): string[] {
  const ambiguousSet = new Set(ambiguous)
  return missing.filter((p) => !ambiguousSet.has(p))
}

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
  const absent = plainMissing(missing, ambiguous)
  const parts = [
    absent.length > 0 ? `no live target: ${absent.join(', ')}` : '',
    ambiguous.length > 0
      ? `refused: ${ambiguous.length} ambiguous (matched more than one live tile): ${ambiguous.join(', ')}`
      : ''
  ].filter(Boolean)
  return parts.join('; ')
}

/**
 * The SAME split as `unreachedTargetsText`, as data instead of prose (card
 * bf76d37f): the buckets stop being journaled-then-discarded and travel back
 * to the caller through `DirectiveDispatch.unreached`.
 *
 * Same inputs, same subtraction (`plainMissing` above), same order (absent
 * first, then ambiguous), and `ambiguous` is walked directly rather than
 * intersected with `missing` -- so an ambiguous id passed OUTSIDE the subset
 * contract is reported here exactly as the text already reports it. The two
 * outputs name the same ids for the same reasons, by construction.
 */
export function unreachedTargets(
  missing: readonly string[],
  ambiguous: readonly string[]
): UnreachedDirectiveTarget[] {
  return [
    ...plainMissing(missing, ambiguous).map((peerId): UnreachedDirectiveTarget => ({ peerId, reason: 'no-live-target' })),
    ...ambiguous.map((peerId): UnreachedDirectiveTarget => ({ peerId, reason: 'ambiguous' }))
  ]
}

/**
 * COUNTS-ONLY tail for runDirectiveWave's per-card "dispatched" journal line
 * (card bf76d37f), the synchronous witness of the hit/miss split at the moment
 * the card is consumed. Deliberately names NO id: listing them is
 * `unreachedTargetsText`'s job and executeDirective already journals that line
 * for the same card, so repeating the ids here would report them twice.
 *
 * `injected` is the number of live tiles the command was typed into,
 * `unreached` the number of requested ids that reached none.
 */
export function dispatchedTargetsTail(injected: number, unreached: number): string {
  const head = injected === 0 ? 'no target reached' : `${injected} target${injected === 1 ? '' : 's'}`
  return unreached === 0 ? head : `${head}, ${unreached} unreached`
}
