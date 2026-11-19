// Review marks: colour identity, scroll-aware box and page filter, then the review panel cards that carry them.

import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()

import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mockStore, storeMockStubs } from './_store-mock'
import {
  REVIEW_MARK_COLORS,
  regionMarkBox,
  reviewMarkColor,
  visibleRegionMarks
} from '../desktop/src/shared/review-marks.ts'
import * as realTypes from '../desktop/src/shared/types.ts'
import * as realPickPrompt from '../desktop/src/shared/pick-prompt.ts'
import * as realPickSecurity from '../desktop/src/shared/pick-security.ts'
import * as realPickShot from '../desktop/src/shared/pick-shot.ts'
import * as realPickCard from '../desktop/src/shared/pick-card.ts'
import * as realDrawStrokes from '../desktop/src/shared/draw-strokes.ts'
import * as realReviewMarks from '../desktop/src/shared/review-marks.ts'
import * as realDrawModifier from '../desktop/src/shared/draw-modifier.ts'
import * as realRecording from '../desktop/src/shared/recording.ts'
import type { PickAnnotation, PickRegion } from '../desktop/src/shared/types.ts'
// Erased at compile time: nothing of react may load before GlobalRegistrator.register().
import type { Root } from '../desktop/tests-support/react-test-harness'

const { act, React, createRoot, create } = await import('../desktop/tests-support/react-test-harness')

const PAGE = 'https://example.com/a'

// BrowserView reaches these through the tsconfig-only `@shared/*` alias, which bun does not resolve from the repo root.
mock.module('@shared/types', () => realTypes)
mock.module('@shared/pick-prompt', () => realPickPrompt)
mock.module('@shared/pick-security', () => realPickSecurity)
mock.module('@shared/pick-shot', () => realPickShot)
mock.module('@shared/pick-card', () => realPickCard)
mock.module('@shared/draw-strokes', () => realDrawStrokes)
mock.module('@shared/review-marks', () => realReviewMarks)
mock.module('@shared/draw-modifier', () => realDrawModifier)
mock.module('@shared/recording', () => realRecording)

const fakeUseDeck = create<Record<string, unknown>>(() => ({
  dict: {},
  config: { browserUrl: PAGE },
  sessions: [],
  browserPairedId: null,
  recordingSince: null,
  setBrowserPaired: () => {},
  setView: () => {},
  setSelected: () => {},
  showToast: () => {},
  setRecordingSince: () => {}
}))
mockStore({ useDeck: fakeUseDeck as never, ...storeMockStubs })

const { BrowserView } = await import('../desktop/src/renderer/src/components/BrowserView')

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

const PANEL_LIST: PickAnnotation[] = [
  regionAnnotation('r0', region({ x: 10 })),
  pickAnnotation('p1'),
  regionAnnotation('r2', region({ x: 70, tool: 'circle' })),
  regionAnnotation('r3', region({ x: 130 }))
]

let container: HTMLDivElement
let root: Root
let cards: HTMLElement[]

beforeAll(async () => {
  ;(window as unknown as { api: unknown }).api = {
    getBrowserPreloadPath: async () => 'C:/deck/preload.js',
    loadReview: async () => ({ version: realTypes.REVIEW_STATE_VERSION, pageUrl: PAGE, annotations: PANEL_LIST }),
    saveReview: async () => {},
    clearReview: async () => {},
    reportError: () => {}
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(BrowserView, { active: true }))
  })
  await act(async () => {
    await Promise.resolve()
  })
  cards = Array.from(container.querySelectorAll<HTMLElement>('.annotate-row'))
})

afterAll(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  await GlobalRegistrator.unregister()
})

function cardColor(card: HTMLElement): string {
  return card.style.getPropertyValue('--mark-color')
}

test('the review panel renders one card per restored annotation, picks included', () => {
  expect(cards).toHaveLength(PANEL_LIST.length)
})

test('each review card is headed by its 1-based position in the whole review', () => {
  const numbers = cards.map((c) => c.querySelector('.annotate-row-mark')?.textContent)
  expect(numbers, 'card i must show i + 1, the number formatAnnotationsReport gives that annotation').toEqual(
    PANEL_LIST.map((_, i) => String(i + 1))
  )
})

test('each review card carries the palette colour of its own position', () => {
  expect(
    cards.map(cardColor),
    'card i must take REVIEW_MARK_COLORS[i]; a shifted index or one colour for all breaks this'
  ).toEqual(PANEL_LIST.map((_, i) => REVIEW_MARK_COLORS[i] as string))
})

test('two consecutive review cards never share a colour', () => {
  const colors = cards.map(cardColor)
  colors.slice(1).forEach((color, i) => {
    expect(color, `cards ${i + 1} and ${i + 2} must differ`).not.toBe(colors[i])
  })
})

test('a region card has the same number and colour as its stroke mark drawn over the page', () => {
  const marks = Array.from(container.querySelectorAll('svg.review-marks g'))
  const regionsOnPage = PANEL_LIST.filter((a) => a.region?.pageUrl === PAGE).length
  expect(regionsOnPage, 'the fixture must pin at least one region, or the loop below asserts nothing').toBeGreaterThan(0)
  expect(marks, 'one stroke mark per region pinned on the current page; a pick has none').toHaveLength(regionsOnPage)
  for (const mark of marks) {
    const n = mark.querySelector('.review-mark-n')?.textContent ?? ''
    const card = cards[Number(n) - 1]
    expect(card, `a card at position ${n} must exist for the mark numbered ${n}`).toBeDefined()
    expect(mark.querySelector('circle')?.getAttribute('fill'), `mark ${n} and its card must share one colour`).toBe(
      cardColor(card!)
    )
  }
})
