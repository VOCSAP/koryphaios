// Workflow lane pure helpers: derived selection/layout/violations (no persisted
// positions -- everything recomputes from queue + depends_on).

import { test, expect } from 'bun:test'
import type { RoadmapItem } from '../desktop/src/shared/types'
import {
  dependsRelated,
  dependsWouldCycle,
  insertAt,
  insertSlotAt,
  slotConflicts,
  laneEdges,
  laneItems,
  layoutLane,
  siblingDeps,
  stackTargetAt,
  unmetDeps,
  WF_NODE_H,
  WF_NODE_W,
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

test('layoutLane: a dependency-free queue renders as a flat left-to-right chain', () => {
  const ordered = laneItems([
    item('a', { queue: 1 }),
    item('b', { queue: 2 }),
    item('c', { queue: 3 }),
    item('d', { queue: 4 })
  ])
  const pos = layoutLane(ordered)
  expect(pos.get('a')).toEqual({ x: 0, y: 0, rank: 0, col: 0, row: 0 })
  expect(pos.get('b')!.col).toBe(1)
  expect(pos.get('c')!.col).toBe(2)
  expect(pos.get('d')!.col).toBe(3)
  expect([pos.get('b')!.y, pos.get('c')!.y, pos.get('d')!.y]).toEqual([0, 0, 0])
})

test('layoutLane: the diamond stacks parallel branches in the same column', () => {
  // A -> B, A -> C, B -> D, C -> D: B and C are parallel siblings.
  const ordered = laneItems([
    item('A', { queue: 1 }),
    item('B', { queue: 2, depends_on: ['A'] }),
    item('C', { queue: 3, depends_on: ['A'] }),
    item('D', { queue: 4, depends_on: ['B', 'C'] })
  ])
  const pos = layoutLane(ordered)
  expect(pos.get('A')!.col).toBe(0)
  expect(pos.get('B')!.col).toBe(1)
  expect(pos.get('C')!.col).toBe(1)
  expect(pos.get('B')!.y).toBe(0)
  expect(pos.get('C')!.y).toBe(WF_PITCH_Y) // stacked below B (queue order)
  expect(pos.get('D')!.col).toBe(2)
  expect(pos.get('D')!.x).toBe(2 * WF_PITCH_X)
})

test('layoutLane: unrelated components chain horizontally after each other', () => {
  const ordered = laneItems([
    item('a1', { queue: 1 }),
    item('a2', { queue: 2, depends_on: ['a1'] }),
    item('solo', { queue: 3 })
  ])
  const pos = layoutLane(ordered)
  // Component {a1, a2} spans columns 0-1; the isolated item continues at 2.
  expect(pos.get('a2')!.col).toBe(1)
  expect(pos.get('solo')!.col).toBe(2)
  expect(pos.get('solo')!.y).toBe(0)
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

test('insertSlotAt counts the cards left of the cut, parallel columns as one', () => {
  const ordered = laneItems([
    item('A', { queue: 1 }),
    item('B', { queue: 2, depends_on: ['A'] }),
    item('C', { queue: 3, depends_on: ['A'] }),
    item('D', { queue: 4, depends_on: ['B', 'C'] })
  ])
  const pos = layoutLane(ordered)
  expect(insertSlotAt(ordered, pos, -100)).toBe(0)
  // Between column 0 (A) and column 1 (B+C): after A only.
  expect(insertSlotAt(ordered, pos, WF_PITCH_X - 10)).toBe(1)
  // Between column 1 and column 2 (D): after A, B and C.
  expect(insertSlotAt(ordered, pos, 2 * WF_PITCH_X - 10)).toBe(3)
  expect(insertSlotAt(ordered, pos, 99 * WF_PITCH_X)).toBe(4)
})

test('stackTargetAt: above/below a column card reads as a parallel placement', () => {
  const ordered = laneItems([
    item('A', { queue: 1 }),
    item('B', { queue: 2, depends_on: ['A'] })
  ])
  const pos = layoutLane(ordered)
  const bPos = pos.get('B')!
  // Clearly below B, in B's column band: stack against B.
  const below = stackTargetAt(ordered, pos, bPos.x + WF_NODE_W / 2, bPos.y + WF_NODE_H * 2)
  expect(below?.targetId).toBe('B')
  expect(below?.x).toBe(bPos.x)
  expect(below?.y).toBe(bPos.y + WF_PITCH_Y)
  // Directly ON B: not a stack (stays an insertion).
  expect(stackTargetAt(ordered, pos, bPos.x + WF_NODE_W / 2, bPos.y + WF_NODE_H / 2)).toBeNull()
  // Far from any column band: nothing.
  expect(stackTargetAt(ordered, pos, 99 * WF_PITCH_X, 0)).toBeNull()
  // The dragged card never targets itself.
  const self = stackTargetAt(ordered, pos, bPos.x + WF_NODE_W / 2, bPos.y + WF_NODE_H * 2, 'B')
  expect(self?.targetId).not.toBe('B')
})

test('siblingDeps copies the target dependencies, sanitized', () => {
  const chain = [
    item('A'),
    item('B', { depends_on: ['A'] }),
    item('C', { depends_on: ['B'] })
  ]
  // Drag C next to B: C adopts B's deps ({A}), dropping its dep on B.
  expect(siblingDeps(chain, 'C', 'B')).toEqual(['A'])
  // Drag B next to C: C's only dep is B itself -- nothing shareable.
  expect(siblingDeps(chain, 'B', 'C')).toBeNull()
  // Target without dependencies: the gesture cannot express parallelism.
  expect(siblingDeps(chain, 'C', 'A')).toBeNull()
  // Cycle-inducing parents are filtered out.
  const tri = [item('X'), item('Y', { depends_on: ['X'] }), item('Z', { depends_on: ['Y', 'X'] })]
  expect(siblingDeps(tri, 'X', 'Z')).toBeNull() // Y and X both cycle back to X
  expect(siblingDeps(tri, 'Y', 'Z')).toEqual(['X']) // Y kept out (self), X fine
})

test('dependsRelated: any dependency path (either direction) forbids parallelism', () => {
  const chain = [
    item('A'),
    item('B', { depends_on: ['A'] }),
    item('C', { depends_on: ['B'] }),
    item('E')
  ]
  expect(dependsRelated(chain, 'B', 'C')).toBe(true) // direct
  expect(dependsRelated(chain, 'C', 'A')).toBe(true) // transitive, reversed args
  expect(dependsRelated(chain, 'B', 'E')).toBe(false) // unrelated
})

test('slotConflicts: flags deps landing after the cut and dependents before it', () => {
  const ordered = laneItems([
    item('A', { queue: 1 }),
    item('B', { queue: 2, depends_on: ['A'] }),
    item('C', { queue: 3, depends_on: ['B'] })
  ])
  const b = ordered.find((i) => i.id === 'B')!
  // Moving B to the front puts it before its dependency A.
  expect(slotConflicts(ordered, b, 0)).toEqual(['A'])
  // Moving B to the end puts it after its dependent C.
  expect(slotConflicts(ordered, b, 3)).toEqual(['C'])
  // Keeping B in the middle wrongs nobody.
  expect(slotConflicts(ordered, b, 1)).toEqual([])
})

test('insertAt moves an already-queued id and clamps the slot', () => {
  expect(insertAt(['a', 'b', 'c'], 'x', 1)).toEqual(['a', 'x', 'b', 'c'])
  expect(insertAt(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
  expect(insertAt(['a', 'b', 'c'], 'a', 99)).toEqual(['b', 'c', 'a'])
})
