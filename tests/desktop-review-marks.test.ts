// Review marks: colour identity, scroll-aware box and page filter (pure module).

import { expect, test } from 'bun:test'
import {
  REVIEW_MARK_COLORS,
  regionMarkBox,
  reviewMarkColor,
  visibleRegionMarks
} from '../desktop/src/shared/review-marks.ts'
import type { PickAnnotation, PickRegion } from '../desktop/src/shared/types.ts'

const PAGE = 'https://example.com/a'

function region(overrides: Partial<PickRegion> = {}): PickRegion {
  return { x: 100, y: 200, width: 50, height: 40, tool: 'freehand', pageUrl: PAGE, ...overrides }
}

function regionAnnotation(id: string, r: PickRegion): PickAnnotation {
  return { id, comment: '', intent: 'change', priority: 'suggestion', region: r }
}

function pickAnnotation(id: string): PickAnnotation {
  return {
    id,
    comment: '',
    intent: 'change',
    priority: 'suggestion',
    pick: { tagName: 'div', selectors: [], classes: [], width: 1, height: 1, pageUrl: PAGE } as never
  }
}

test('eight consecutive indices give eight distinct colours and index 8 cycles to index 0', () => {
  const colors = Array.from({ length: 8 }, (_, i) => reviewMarkColor(i))
  expect(new Set(colors).size).toBe(8)
  expect(reviewMarkColor(8)).toBe(reviewMarkColor(0))
  expect(REVIEW_MARK_COLORS).toHaveLength(8)
})

test('regionMarkBox shifts by pin scroll minus current scroll', () => {
  const box = regionMarkBox(region({ scrollX: 10, scrollY: 300 }), { x: 4, y: 100 })
  expect(box).toEqual({ x: 106, y: 400, width: 50, height: 40 })
})

test('regionMarkBox gives a region without scroll fields zero pin offset', () => {
  const box = regionMarkBox(region(), { x: 0, y: 30 })
  expect(box.x).toBe(100)
  expect(box.y).toBe(170)
})

test('visibleRegionMarks drops other pages and element picks but keeps full-list numbering', () => {
  const list = [
    pickAnnotation('p'),
    regionAnnotation('r1', region()),
    regionAnnotation('other', region({ pageUrl: 'https://example.com/b' })),
    regionAnnotation('r2', region({ tool: 'circle' }))
  ]
  const marks = visibleRegionMarks(list, PAGE, { x: 0, y: 0 })
  expect(marks.map((m) => m.id)).toEqual(['r1', 'r2'])
  expect(marks.map((m) => m.n)).toEqual([2, 4])
  expect(marks[0]!.color).toBe(reviewMarkColor(1))
  expect(marks[1]!.color).toBe(reviewMarkColor(3))
  expect(marks[1]!.tool).toBe('circle')
})
