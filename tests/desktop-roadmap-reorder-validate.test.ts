// Roadmap card 42edc88b phase 1: main-side re-validation of the optional
// `waves` IPC argument to roadmap:reorder, before it ever reaches the broker.

import { test, expect } from 'bun:test'
import { validateReorderWaves } from '../desktop/src/main/roadmap-reorder-validate.ts'

test('accepts waves that flatten to exactly ids, in order', () => {
  const res = validateReorderWaves(['a', 'b', 'c'], [['a'], ['b', 'c']])
  expect(res).toEqual({ ok: true, waves: [['a'], ['b', 'c']] })
})

test('rejects a non-array waves argument', () => {
  const res = validateReorderWaves(['a'], 'nope')
  expect(res.ok).toBe(false)
})

test('rejects a wave that is not itself an array', () => {
  const res = validateReorderWaves(['a', 'b'], [['a'], 'b'])
  expect(res.ok).toBe(false)
})

test('rejects an empty wave', () => {
  const res = validateReorderWaves(['a', 'b'], [[], ['a', 'b']])
  expect(res.ok).toBe(false)
})

test('rejects an id appearing twice across two different waves', () => {
  // Runs on the RAW un-deduped waves argument, before ids itself is even
  // consulted -- this is the check the broker's own ids-duplicate guard does
  // not reach, because it only ever sees the (already flattened) ids array.
  const res = validateReorderWaves(['a', 'b'], [['a'], ['a', 'b']])
  expect(res.ok).toBe(false)
})

test('rejects waves that flatten to the right set but the wrong order', () => {
  const res = validateReorderWaves(['a', 'b'], [['b'], ['a']])
  expect(res.ok).toBe(false)
})

test('rejects waves whose flattened length or content diverges from ids', () => {
  expect(validateReorderWaves(['a', 'b'], [['a']]).ok).toBe(false)
  expect(validateReorderWaves(['a', 'b'], [['a'], ['c']]).ok).toBe(false)
})

test('accepts an empty waves array alongside an empty ids array', () => {
  const res = validateReorderWaves([], [])
  expect(res).toEqual({ ok: true, waves: [] })
})

test('trims wave ids the same way the broker trims ids', () => {
  const res = validateReorderWaves(['a', 'b'], [[' a '], ['b']])
  expect(res).toEqual({ ok: true, waves: [['a'], ['b']] })
})

test('rejects a non-string id inside a wave', () => {
  const res = validateReorderWaves(['a'], [[1 as unknown as string]])
  expect(res.ok).toBe(false)
})

test('enforces the wave-count cap', () => {
  const ids = Array.from({ length: 3 }, (_, i) => `id-${i}`)
  const waves = ids.map((id) => [id])
  const res = validateReorderWaves(ids, waves, { maxWaves: 2 })
  expect(res.ok).toBe(false)
})

test('enforces the per-wave size cap', () => {
  const ids = ['a', 'b', 'c']
  const res = validateReorderWaves(ids, [['a', 'b', 'c']], { maxWaveSize: 2 })
  expect(res.ok).toBe(false)
})
