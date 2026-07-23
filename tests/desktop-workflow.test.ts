// Workflow lane pure helpers: derived selection/layout/violations (no persisted
// positions -- everything recomputes from queue + depends_on).

import { test, expect } from 'bun:test'
import type { RoadmapItem } from '../desktop/src/shared/types'
import {
  dependsWouldCycle,
  insertAt,
  insertIndexAt,
  laneEdges,
  laneItems,
  layoutLane,
  unmetDeps,
  WF_PITCH_X,
  WF_PITCH_Y
} from '../desktop/src/shared/workflow'

function item(id: string, over: Partial<RoadmapItem> = {}): RoadmapItem {
  return {
    id,
    project_key: 'k',
    kind: 'feature',
    title: id,
    description: '',
    rationale: '',
    context: '',
    priority: 'could',
    value: 'medium',
    effort: 'medium',
    status: 'planned',
    tags: [],
    depends_on: [],
    created_by: 'deck',
    updated_by: 'deck',
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    deleted_at: null,
    queue: null,
    locked: false,
    locked_by: null,
    locked_at: null,
    ...over
  }
}

test('laneItems: queue order, locked in_progress heads first, closed items out', () => {
  const items = [
    item('q2', { queue: 2 }),
    item('q1', { queue: 1 }),
    item('done', { queue: 3, status: 'done' }),
    item('idle'),
    item('headB', { status: 'in_progress', locked: true, locked_by: 'p', locked_at: '2026-02-02' }),
    item('headA', { status: 'in_progress', locked: true, locked_by: 'p', locked_at: '2026-01-02' }),
    // in_progress but NOT locked and not queued: submitted, nobody works on it.
    item('limbo', { status: 'in_progress' })
  ]
  expect(laneItems(items).map((i) => i.id)).toEqual(['headA', 'headB', 'q1', 'q2'])
})

test('layoutLane: x follows rank, depends_on components share a stream row', () => {
  // Two independent chains interleaved in the queue: a1 -> a2 and b1 -> b2.
  const ordered = laneItems([
    item('a1', { queue: 1 }),
    item('b1', { queue: 2 }),
    item('a2', { queue: 3, depends_on: ['a1'] }),
    item('b2', { queue: 4, depends_on: ['b1'] })
  ])
  const pos = layoutLane(ordered)
  expect(pos.get('a1')).toEqual({ x: 0, y: 0, rank: 0, row: 0 })
  expect(pos.get('b1')).toEqual({ x: WF_PITCH_X, y: WF_PITCH_Y, rank: 1, row: 1 })
  expect(pos.get('a2')!.row).toBe(0)
  expect(pos.get('a2')!.x).toBe(2 * WF_PITCH_X)
  expect(pos.get('b2')!.row).toBe(1)
})

test('layoutLane: a shared dependency merges streams into one row', () => {
  const ordered = laneItems([
    item('base', { queue: 1 }),
    item('left', { queue: 2, depends_on: ['base'] }),
    item('right', { queue: 3, depends_on: ['base'] })
  ])
  const pos = layoutLane(ordered)
  expect(pos.get('left')!.row).toBe(0)
  expect(pos.get('right')!.row).toBe(0)
})

test('laneEdges: flags a dependency queued after its dependent', () => {
  const ordered = laneItems([
    item('early', { queue: 1, depends_on: ['late'] }),
    item('late', { queue: 2 }),
    item('after', { queue: 3, depends_on: ['late'] })
  ])
  const edges = laneEdges(ordered)
  expect(edges).toContainEqual({ from: 'late', to: 'early', violated: true })
  expect(edges).toContainEqual({ from: 'late', to: 'after', violated: false })
})

test('unmetDeps: reports off-lane unfinished dependencies, skips done and dangling', () => {
  const all = [
    item('shown', { queue: 1, depends_on: ['off', 'finished', 'ghost', 'gone'] }),
    item('off'),
    item('finished', { status: 'done' }),
    item('gone', { status: 'archived' })
  ]
  const shown = new Set(['shown'])
  const unmet = unmetDeps(all[0]!, all, shown)
  expect(unmet.map((i) => i.id).sort()).toEqual(['gone', 'off'])
})

test('dependsWouldCycle walks depends_on transitively', () => {
  const items = [
    item('a', { depends_on: ['b'] }),
    item('b', { depends_on: ['c'] }),
    item('c')
  ]
  // c -> depends on a? a already (transitively) depends on c: cycle.
  expect(dependsWouldCycle(items, 'c', 'a')).toBe(true)
  expect(dependsWouldCycle(items, 'a', 'a')).toBe(true)
  expect(dependsWouldCycle(items, 'a', 'c')).toBe(false)
})

test('insertIndexAt rounds to the nearest slot and clamps', () => {
  expect(insertIndexAt(-500, 3)).toBe(0)
  expect(insertIndexAt(0, 3)).toBe(0)
  expect(insertIndexAt(WF_PITCH_X * 0.6, 3)).toBe(1)
  expect(insertIndexAt(WF_PITCH_X * 10, 3)).toBe(3)
})

test('insertAt moves an already-queued id and clamps the slot', () => {
  expect(insertAt(['a', 'b', 'c'], 'x', 1)).toEqual(['a', 'x', 'b', 'c'])
  expect(insertAt(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
  expect(insertAt(['a', 'b', 'c'], 'a', 99)).toEqual(['b', 'c', 'a'])
})
