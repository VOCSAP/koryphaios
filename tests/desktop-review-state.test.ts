// Persisted design-review annotations (main/review-state-service.ts): the
// embedded browser's pending PickAnnotation[] must survive a window reload /
// app restart. STRICT / fail-closed / pick-list validation -- see the
// module's own header comment for why one bad item rejects the WHOLE file.
// Node builtins only (no electron), like the module under test.

import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearReviewState,
  readReviewState,
  REVIEW_STATE_VERSION,
  validatePersistedReview,
  writeReviewState
} from '../desktop/src/main/review-state-service.ts'
import { PICK_BUDGET } from '../desktop/src/shared/pick-security.ts'

// ----- fixtures -----

function validPick(overrides: Record<string, unknown> = {}) {
  return {
    tagName: 'button',
    id: 'submit',
    classes: ['btn', 'btn-primary'],
    text: 'Submit',
    selectors: [{ type: 'id', value: '#submit' }],
    width: 80,
    height: 32,
    pageUrl: 'https://example.com/checkout',
    // 'data-evil' is not in PICK_ATTRIBUTE_ALLOWLIST (nor aria-*); 'title' is.
    // Exercises that a valid pick is actually routed through sanitizePick.
    attributes: { title: 'Submit order', 'data-evil': 'should be stripped' },
    ...overrides
  }
}

function validAnnotation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    comment: 'this needs a bigger tap target',
    intent: 'fix',
    priority: 'blocking',
    pick: validPick(),
    ...overrides
  }
}

function validReview(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    pageUrl: 'https://example.com/checkout',
    annotations: [validAnnotation()],
    ...overrides
  }
}

function withDir(fn: (dir: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'kory-review-state-'))
  return (async () => {
    try {
      await fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })()
}

function neverCalled() {
  let called = false
  return {
    report: (_m: string, _e: unknown) => {
      called = true
    },
    wasCalled: () => called
  }
}

// ----- round trip + missing/corrupt file -----

test('write then read round-trips a valid review', () =>
  withDir(async (dir) => {
    const annotationsDir = join(dir, 'annotations')
    mkdirSync(annotationsDir, { recursive: true })
    const shotPath = join(annotationsDir, 'annotation-shot.png')
    writeFileSync(shotPath, Buffer.from('fake-png-bytes'))

    const file = join(dir, 'review-pending.json')
    const review = validReview({
      annotations: [validAnnotation({ screenshotPath: shotPath })]
    })
    await writeReviewState(file, review as never)

    const spy = neverCalled()
    const read = await readReviewState(file, { annotationsDir, report: spy.report })
    expect(spy.wasCalled()).toBe(false)
    expect(read).not.toBeNull()
    expect(read!.version).toBe(REVIEW_STATE_VERSION)
    expect(read!.pageUrl).toBe('https://example.com/checkout')
    expect(read!.annotations).toHaveLength(1)
    expect(read!.annotations[0]!.screenshotPath).toBe(shotPath)
  }))

test('missing file returns null silently (report NOT called)', () =>
  withDir(async (dir) => {
    const spy = neverCalled()
    const result = await readReviewState(join(dir, 'nope.json'), {
      annotationsDir: join(dir, 'annotations'),
      report: spy.report
    })
    expect(result).toBeNull()
    expect(spy.wasCalled()).toBe(false)
  }))

test('corrupt JSON returns null and reports exactly once', () =>
  withDir(async (dir) => {
    const file = join(dir, 'review-pending.json')
    writeFileSync(file, '{ not valid json')
    let calls = 0
    const result = await readReviewState(file, {
      annotationsDir: join(dir, 'annotations'),
      report: () => {
        calls += 1
      }
    })
    expect(result).toBeNull()
    expect(calls).toBe(1)
  }))

// ----- per-rule rejection probes (one mutation each, valid fixture otherwise) -----

const ANNOTATIONS_DIR = '/tmp/unused-annotations-dir' // no screenshotPath in these fixtures

test('wrong version rejects the whole file', async () => {
  const review = validReview({ version: 2 })
  expect(await validatePersistedReview(review, { annotationsDir: ANNOTATIONS_DIR })).toBeNull()
})

test('duplicate id rejects the whole file', async () => {
  const review = validReview({
    annotations: [validAnnotation({ id: 'dup' }), validAnnotation({ id: 'dup' })]
  })
  expect(await validatePersistedReview(review, { annotationsDir: ANNOTATIONS_DIR })).toBeNull()
})

test('non-string comment rejects the whole file', async () => {
  const review = validReview({ annotations: [validAnnotation({ comment: 12345 })] })
  expect(await validatePersistedReview(review, { annotationsDir: ANNOTATIONS_DIR })).toBeNull()
})

test('invalid intent rejects the whole file', async () => {
  const review = validReview({ annotations: [validAnnotation({ intent: 'nope' })] })
  expect(await validatePersistedReview(review, { annotationsDir: ANNOTATIONS_DIR })).toBeNull()
})

test('invalid priority rejects the whole file', async () => {
  const review = validReview({ annotations: [validAnnotation({ priority: 'nope' })] })
  expect(await validatePersistedReview(review, { annotationsDir: ANNOTATIONS_DIR })).toBeNull()
})

test('both pick and region present rejects the whole file', async () => {
  const region = { x: 1, y: 1, width: 10, height: 10, tool: 'freehand', pageUrl: 'https://example.com' }
  const review = validReview({ annotations: [validAnnotation({ region })] }) // still has pick too
  expect(await validatePersistedReview(review, { annotationsDir: ANNOTATIONS_DIR })).toBeNull()
})

test('neither pick nor region present rejects the whole file', async () => {
  const review = validReview({ annotations: [validAnnotation({ pick: undefined })] })
  expect(await validatePersistedReview(review, { annotationsDir: ANNOTATIONS_DIR })).toBeNull()
})

test('region with NaN coordinate rejects the whole file', async () => {
  const review = validReview({
    annotations: [
      validAnnotation({
        pick: undefined,
        region: { x: NaN, y: 1, width: 10, height: 10, tool: 'freehand', pageUrl: 'https://example.com' }
      })
    ]
  })
  expect(await validatePersistedReview(review, { annotationsDir: ANNOTATIONS_DIR })).toBeNull()
})

test('region with negative coordinate rejects the whole file', async () => {
  const review = validReview({
    annotations: [
      validAnnotation({
        pick: undefined,
        region: { x: -1, y: 1, width: 10, height: 10, tool: 'freehand', pageUrl: 'https://example.com' }
      })
    ]
  })
  expect(await validatePersistedReview(review, { annotationsDir: ANNOTATIONS_DIR })).toBeNull()
})

test('region with invalid tool rejects the whole file', async () => {
  const review = validReview({
    annotations: [
      validAnnotation({
        pick: undefined,
        region: { x: 1, y: 1, width: 10, height: 10, tool: 'square', pageUrl: 'https://example.com' }
      })
    ]
  })
  expect(await validatePersistedReview(review, { annotationsDir: ANNOTATIONS_DIR })).toBeNull()
})

test('annotation count over the PICK_BUDGET cap rejects the whole file', async () => {
  const annotations = Array.from({ length: PICK_BUDGET.annotationsMaxPerPage + 1 }, (_, i) =>
    validAnnotation({ id: `a${i}` })
  )
  const review = validReview({ annotations })
  expect(await validatePersistedReview(review, { annotationsDir: ANNOTATIONS_DIR })).toBeNull()
})

// ----- screenshotPath containment (dropped, not rejected) -----

test('screenshotPath outside the annotations dir is dropped, the annotation is kept', () =>
  withDir(async (dir) => {
    const annotationsDir = join(dir, 'annotations')
    const outsideDir = join(dir, 'outside')
    mkdirSync(annotationsDir, { recursive: true })
    mkdirSync(outsideDir, { recursive: true })
    const outsidePath = join(outsideDir, 'shot.png')
    writeFileSync(outsidePath, Buffer.from('fake-png'))

    const review = validReview({
      annotations: [validAnnotation({ screenshotPath: outsidePath })]
    })
    const result = await validatePersistedReview(review, { annotationsDir })
    expect(result).not.toBeNull()
    expect(result!.annotations).toHaveLength(1)
    expect(result!.annotations[0]!.screenshotPath).toBeUndefined()
  }))

test('screenshotPath inside the dir but pointing at a missing file is dropped, the annotation is kept', () =>
  withDir(async (dir) => {
    const annotationsDir = join(dir, 'annotations')
    mkdirSync(annotationsDir, { recursive: true })
    const ghostPath = join(annotationsDir, 'ghost.png') // never created

    const review = validReview({
      annotations: [validAnnotation({ screenshotPath: ghostPath })]
    })
    const result = await validatePersistedReview(review, { annotationsDir })
    expect(result).not.toBeNull()
    expect(result!.annotations[0]!.screenshotPath).toBeUndefined()
  }))

// ----- pick-list coverage: unknown fields never survive (CLAUDE.md coverage rule) -----

test('unknown top-level and per-item fields are absent from the output', async () => {
  const review = {
    ...validReview({
      annotations: [{ ...validAnnotation(), futureItemField: 'smuggled' }]
    }),
    futureTopLevelField: 'smuggled'
  }
  const result = await validatePersistedReview(review, { annotationsDir: ANNOTATIONS_DIR })
  expect(result).not.toBeNull()
  expect(Object.keys(result!).sort()).toEqual(['annotations', 'pageUrl', 'version'])
  expect(Object.keys(result!.annotations[0]!).sort()).toEqual(['comment', 'id', 'intent', 'pick', 'priority'])
})

// ----- a valid pick is actually routed through sanitizePick -----

test('a valid pick is sanitized: an attribute outside the allowlist is stripped', async () => {
  const review = validReview()
  const result = await validatePersistedReview(review, { annotationsDir: ANNOTATIONS_DIR })
  expect(result).not.toBeNull()
  const pick = result!.annotations[0]!.pick!
  expect(pick.attributes?.title).toBe('Submit order')
  expect(pick.attributes && 'data-evil' in pick.attributes).toBe(false)
})

// ----- clearReviewState -----

test('clearReviewState removes the file and is a no-op when already absent', () =>
  withDir(async (dir) => {
    const file = join(dir, 'review-pending.json')
    await writeReviewState(file, validReview() as never)
    expect(existsSync(file)).toBe(true)
    await clearReviewState(file)
    expect(existsSync(file)).toBe(false)
    // Second call: file already gone, must not throw.
    await clearReviewState(file)
  }))
