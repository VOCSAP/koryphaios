// Pure geometry + identity of the marks drawn over the page for pinned review
// regions (no DOM, no electron).

import type { PickAnnotation, PickRegion } from './types'
import { DEFAULT_PALETTE } from './palette'

// Entries 8-9 of the session palette are near-duplicates of 0 and 1.
export const REVIEW_MARK_COLORS: string[] = DEFAULT_PALETTE.slice(0, 8)

export interface ReviewScroll {
  x: number
  y: number
}

export interface ReviewMark {
  id: string
  n: number
  color: string
  tool: PickRegion['tool']
  box: { x: number; y: number; width: number; height: number }
}

/** Categorical identity only: the colour carries no meaning. */
export function reviewMarkColor(index: number): string {
  const n = REVIEW_MARK_COLORS.length
  return REVIEW_MARK_COLORS[((index % n) + n) % n] as string
}

/** Region bounds are viewport px at pin time; shifting by the scroll delta keeps the mark on its page content. */
export function regionMarkBox(
  region: PickRegion,
  scroll: ReviewScroll
): { x: number; y: number; width: number; height: number } {
  return {
    x: region.x + (region.scrollX ?? 0) - scroll.x,
    y: region.y + (region.scrollY ?? 0) - scroll.y,
    width: region.width,
    height: region.height
  }
}

/**
 * Marks of the regions pinned on `pageUrl`. `n` is the 1-based position in the
 * FULL list, the number formatAnnotationsReport gives the same annotation, so
 * the operator reads what the agent reads.
 */
export function visibleRegionMarks(
  annotations: PickAnnotation[],
  pageUrl: string,
  scroll: ReviewScroll
): ReviewMark[] {
  const marks: ReviewMark[] = []
  annotations.forEach((a, i) => {
    const region = a.region
    if (!region || region.pageUrl !== pageUrl) return
    marks.push({
      id: a.id,
      n: i + 1,
      color: reviewMarkColor(i),
      tool: region.tool,
      box: regionMarkBox(region, scroll)
    })
  })
  return marks
}
