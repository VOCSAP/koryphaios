// Pure helper for the Files-view code selection (PLAN GX7), shared so it can
// be unit-tested without the DOM. The renderer derives `before` (the text of
// the file up to the selection start) and `selected` (the selection string)
// from a DOM Range, then this computes the 1-based inclusive line span.

export interface LineRange {
  startLine: number
  endLine: number
}

/**
 * 1-based inclusive line span of a selection. `before` is everything before
 * the selection start (its newline count fixes the start line); `selected`
 * is the selection text. A selection dragged to the very start of the next
 * line carries a trailing newline that belongs to the FOLLOWING line, not the
 * selection — it is dropped so "select line 2" reports 2–2, not 2–3.
 */
export function selectionLineRange(before: string, selected: string): LineRange {
  const startLine = before.split('\n').length
  const body = selected.replace(/\n$/, '')
  const endLine = startLine + (body === '' ? 0 : body.split('\n').length - 1)
  return { startLine, endLine }
}
