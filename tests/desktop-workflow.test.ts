// Workflow lane pure helpers: derived selection/layout/violations (no persisted
// positions -- everything recomputes from queue + depends_on).

import { test, expect } from 'bun:test'
import type { RoadmapItem } from '../desktop/src/shared/types'
import {
  clampLaneHeight,
  compareById,
  dependsRelated,
  dependsWouldCycle,
  enqueueClosure,
  initialLaneHeight,
  insertAt,
  insertSlotAt,
  slotConflicts,
  laneEdges,
  laneItems,
  layoutLane,
  queuedItems,
  siblingDeps,
  stackTargetAt,
  unmetDeps,
  WF_LANE_H_DEFAULT,
  WF_LANE_H_MIN,
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

test('laneItems: two locked heads with the same locked_at are broken by id', () => {
  const items = [
    item('headZ', { status: 'in_progress', locked: true, locked_by: 'p', locked_at: '2026-01-01' }),
    item('headA', { status: 'in_progress', locked: true, locked_by: 'p', locked_at: '2026-01-01' })
  ]
  expect(laneItems(items).map((i) => i.id)).toEqual(['headA', 'headZ'])
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

test('layoutLane: items tied on the same queue value share a column (a wave)', () => {
  const ordered = laneItems([
    item('A', { queue: 1 }),
    item('B', { queue: 2 }),
    item('C', { queue: 2 }), // tied with B: same broker-stamped wave
    item('D', { queue: 3 })
  ])
  const pos = layoutLane(ordered)
  expect(pos.get('A')!.col).toBe(0)
  expect(pos.get('B')!.col).toBe(1)
  expect(pos.get('C')!.col).toBe(1)
  expect(pos.get('B')!.row).toBe(0)
  expect(pos.get('C')!.row).toBe(1)
  expect(pos.get('C')!.y).toBe(WF_PITCH_Y) // stacked below B
  expect(pos.get('D')!.col).toBe(2)
  expect(pos.get('D')!.x).toBe(2 * WF_PITCH_X)
})

test('layoutLane: a depends_on link does NOT pull items into the same column anymore', () => {
  // Unlike the old dependency-depth layout, a dependency chain with distinct
  // queue values now lands in distinct columns -- the wave is defined purely
  // by the tied queue value, not by the graph shape.
  const ordered = laneItems([
    item('a1', { queue: 1 }),
    item('a2', { queue: 2, depends_on: ['a1'] })
  ])
  const pos = layoutLane(ordered)
  expect(pos.get('a1')!.col).toBe(0)
  expect(pos.get('a2')!.col).toBe(1)
})

test('layoutLane: distinct queue values rank densely, a gap does not draw an empty column', () => {
  // Mirrors tests/broker-roadmap-queue.test.ts:50 (queue: 7 with nothing else
  // queued is reachable): the column must be the RANK of the distinct queue
  // values present, not the raw value itself.
  const ordered = laneItems([item('a', { queue: 1 }), item('b', { queue: 7 })])
  const pos = layoutLane(ordered)
  expect(pos.get('a')!.col).toBe(0)
  expect(pos.get('b')!.col).toBe(1)
  expect(pos.get('b')!.x).toBe(WF_PITCH_X)
})

test('layoutLane: locked heads share column 0 -- observed concurrency, not a queue', () => {
  const ordered = laneItems([
    item('headA', { status: 'in_progress', locked: true, locked_by: 'p', locked_at: '2026-01-01' }),
    item('headB', { status: 'in_progress', locked: true, locked_by: 'p', locked_at: '2026-01-02' }),
    item('q1', { queue: 1 })
  ])
  const pos = layoutLane(ordered)
  expect(pos.get('headA')).toEqual({ x: 0, y: 0, rank: 0, col: 0, row: 0 })
  expect(pos.get('headB')).toEqual({ x: 0, y: WF_PITCH_Y, rank: 1, col: 0, row: 1 })
  // Queue columns start after the shared heads column, not at 0.
  expect(pos.get('q1')!.col).toBe(1)
  expect(pos.get('q1')!.x).toBe(WF_PITCH_X)
})

test('layoutLane: with no locked heads, queue columns start at column 0', () => {
  const ordered = laneItems([item('q1', { queue: 5 })])
  const pos = layoutLane(ordered)
  expect(pos.get('q1')!.col).toBe(0)
  expect(pos.get('q1')!.x).toBe(0)
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

test('insertSlotAt: index counts the cards left of the cut, a wave counts as one column', () => {
  const ordered = laneItems([
    item('A', { queue: 1 }),
    item('B', { queue: 2 }),
    item('C', { queue: 2 }) // tied with B: a two-item wave in column 1
  ])
  const pos = layoutLane(ordered)
  expect(insertSlotAt(ordered, pos, -100).index).toBe(0)
  // Between column 0 (A) and column 1 (B+C): after A only.
  expect(insertSlotAt(ordered, pos, WF_PITCH_X - 10).index).toBe(1)
  expect(insertSlotAt(ordered, pos, 99 * WF_PITCH_X).index).toBe(3)
})

test('insertSlotAt: join is true inside an existing wave band, false in the gap or outside', () => {
  const ordered = laneItems([
    item('A', { queue: 1 }),
    item('B', { queue: 2 }),
    item('C', { queue: 2 }) // tied with B: column 1's band
  ])
  const pos = layoutLane(ordered)
  const bx = pos.get('B')!.x
  // Squarely inside column 1's band: joins that wave.
  expect(insertSlotAt(ordered, pos, bx + WF_NODE_W / 2)).toEqual({ index: 1, join: true })
  // In the gap between column 0 and column 1's bands: a cut, not a join.
  const gapMid = WF_PITCH_X - (WF_PITCH_X - WF_NODE_W) / 2
  expect(insertSlotAt(ordered, pos, gapMid)).toEqual({ index: 1, join: false })
  // Off the far end: neither inside a band nor a join.
  expect(insertSlotAt(ordered, pos, 99 * WF_PITCH_X)).toEqual({ index: 3, join: false })
})

test('insertSlotAt: the heads column never counts as a join target', () => {
  const ordered = laneItems([
    item('head', { status: 'in_progress', locked: true, locked_by: 'p', locked_at: '2026-01-01' }),
    item('q1', { queue: 1 })
  ])
  const pos = layoutLane(ordered)
  // Squarely on the heads column (x = 0): still not a join.
  expect(insertSlotAt(ordered, pos, WF_NODE_W / 2).join).toBe(false)
})

test('insertSlotAt: an empty lane never throws and reports no join', () => {
  const pos = layoutLane([])
  expect(insertSlotAt([], pos, 0)).toEqual({ index: 0, join: false })
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

test('enqueueClosure: diamond dependencies close once, dependency-first', () => {
  // D depends on B and C, both depend on A: A must appear exactly once,
  // before B and C, and D itself is excluded (the caller places it).
  const items = [
    item('A'),
    item('B', { depends_on: ['A'] }),
    item('C', { depends_on: ['A'] }),
    item('D', { depends_on: ['B', 'C'] })
  ]
  const closure = enqueueClosure(items, 'D')
  expect(closure).toEqual(['A', 'B', 'C'])
})

test('enqueueClosure: an already-queued dependency is not re-added', () => {
  const items = [
    item('A', { queue: 1 }),
    item('B', { depends_on: ['A'] })
  ]
  expect(enqueueClosure(items, 'B')).toEqual([])
})

test('enqueueClosure: a done dependency is settled, not re-queued', () => {
  const items = [item('A', { status: 'done' }), item('B', { depends_on: ['A'] })]
  expect(enqueueClosure(items, 'B')).toEqual([])
})

test('enqueueClosure: an archived dependency is settled, not re-queued', () => {
  const items = [item('A', { status: 'archived' }), item('B', { depends_on: ['A'] })]
  expect(enqueueClosure(items, 'B')).toEqual([])
})

test('enqueueClosure: a locked in_progress head is active work, not re-queued', () => {
  const items = [
    item('A', { status: 'in_progress', locked: true, locked_by: 'p', locked_at: '2026-01-01' }),
    item('B', { depends_on: ['A'] })
  ]
  expect(enqueueClosure(items, 'B')).toEqual([])
})

test('enqueueClosure: a dangling dependency id (deleted/absent item) is ignored', () => {
  const items = [item('B', { depends_on: ['ghost', 'A'] }), item('A')]
  expect(enqueueClosure(items, 'B')).toEqual(['A'])
})

test('enqueueClosure: terminates and de-duplicates on a dependency cycle', () => {
  // A <-> B is a malformed cycle (depends_on should be a DAG, but the data
  // can still contain one); the closure must terminate, not loop forever.
  const items = [item('A', { depends_on: ['B'] }), item('B', { depends_on: ['A'] })]
  expect(enqueueClosure(items, 'A')).toEqual(['B'])
})

test('enqueueClosure: a done item with an unfinished nested dependency still enqueues that dependency', () => {
  // C depends on B (done), B depends on A (planned, not queued). This is an
  // inconsistent state -- B should not have been marked done while its own
  // dependency A is unfinished -- but the closure does not trust the done
  // flag to mean "and everything under it is settled too": it still walks
  // into B's dependencies and surfaces A. Deliberate safe bias, see the
  // comment in enqueueClosure (shared/workflow.ts).
  const items = [
    item('A'),
    item('B', { status: 'done', depends_on: ['A'] }),
    item('C', { depends_on: ['B'] })
  ]
  expect(enqueueClosure(items, 'C')).toEqual(['A'])
})

test('compareById: byte compare, single source of truth for id tiebreaks', () => {
  expect(compareById(item('a'), item('b'))).toBe(-1)
  expect(compareById(item('b'), item('a'))).toBe(1)
})

test('queuedItems: orders by queue position, skips done/archived/unqueued/heads', () => {
  const items = [
    item('b', { queue: 2 }),
    item('a', { queue: 1 }),
    item('c', { queue: null }),
    item('d', { queue: 3, status: 'done' }),
    item('e', { queue: 4, status: 'archived' }),
    item('f', { queue: null, status: 'in_progress', locked: true, locked_at: '2026-01-01' })
  ]
  expect(queuedItems(items).map((i) => i.id)).toEqual(['a', 'b'])
})

test('queuedItems: a queue tie is broken by id, not by the input array order', () => {
  // Load-bearing regression: the broker's list endpoint returns items
  // ordered by created_at, id -- NOT by queue. If queuedItems relied on
  // Array.prototype.sort's stability instead of a real id tiebreak, a tie
  // on `queue` would silently resolve to created_at order and only LOOK
  // correct because created_at happens to agree with id today. Build the
  // input already in created_at order (oldest first) but with created_at
  // deliberately in the REVERSE order of id, so a missing/wrong tiebreak
  // and the correct byte-compare tiebreak produce different, observable
  // results. This must fail if compareById is removed from queuedItems.
  const items = [
    item('z', { queue: 5, created_at: '2026-01-01' }), // oldest, highest id
    item('a', { queue: 5, created_at: '2026-01-02' }) // newest, lowest id
  ]
  expect(queuedItems(items).map((i) => i.id)).toEqual(['a', 'z'])
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
  // join omitted (defaults false): identical to the calls above.
  expect(slotConflicts(ordered, b, 0, false)).toEqual(['A'])
})

test('slotConflicts: join=true additionally flags a direct dependency link inside the joined wave', () => {
  const ordered = laneItems([
    item('A', { queue: 1 }),
    item('B', { queue: 2 }),
    item('C', { queue: 2, depends_on: ['A'] }) // tied with B, but depends on A
  ])
  const a = ordered.find((i) => i.id === 'A')!
  // Dropping A to join B/C's wave: the plain before/after check does not
  // flag C (A lands ahead of C in that slot), but A and C are directly
  // linked, so join=true must still catch it.
  expect(slotConflicts(ordered, a, 1, true)).toContain('C')
  expect(slotConflicts(ordered, a, 1, false)).toEqual([])
})

test('slotConflicts: join=true against a heads-only column never adds a conflict', () => {
  const ordered = laneItems([
    item('head', { status: 'in_progress', locked: true, locked_by: 'p', locked_at: '2026-01-01' }),
    item('q', { queue: 1 })
  ])
  const q = ordered.find((i) => i.id === 'q')!
  // Dropping q at slot 0 (the heads column): join=true must not treat the
  // head as a wave partner -- heads are never queue-tied.
  expect(slotConflicts(ordered, q, 0, true)).toEqual([])
})

test('slotConflicts: an empty lane or a drag id absent from it never throws', () => {
  expect(slotConflicts([], item('stray'), 0)).toEqual([])
  expect(slotConflicts([], item('stray'), 0, true)).toEqual([])
})

test('insertAt moves an already-queued id and clamps the slot', () => {
  expect(insertAt(['a', 'b', 'c'], 'x', 1)).toEqual(['a', 'x', 'b', 'c'])
  expect(insertAt(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
  expect(insertAt(['a', 'b', 'c'], 'a', 99)).toEqual(['b', 'c', 'a'])
})

test('clampLaneHeight: floors at WF_LANE_H_MIN regardless of viewport', () => {
  expect(clampLaneHeight(10, 1080)).toBe(WF_LANE_H_MIN)
  expect(clampLaneHeight(-500, 200)).toBe(WF_LANE_H_MIN)
})

test('clampLaneHeight: ceils at 60% of the viewport height', () => {
  expect(clampLaneHeight(9999, 1000)).toBe(600)
  expect(clampLaneHeight(500, 1000)).toBe(500)
})

test('clampLaneHeight: a tiny viewport still leaves the floor as the ceiling', () => {
  // 60vh of a 200px-tall viewport (120) is below the floor -- the floor wins,
  // never a ceiling smaller than the minimum usable height.
  expect(clampLaneHeight(9999, 200)).toBe(WF_LANE_H_MIN)
})

test('clampLaneHeight: a non-finite input floors instead of propagating NaN', () => {
  // NaN and +/-Infinity are all non-finite: none may reach Math.max/min and
  // propagate into `height: NaN` (or an unusable infinite height) downstream.
  expect(clampLaneHeight(NaN, 1080)).toBe(WF_LANE_H_MIN)
  expect(clampLaneHeight(Infinity, 1080)).toBe(WF_LANE_H_MIN)
  expect(clampLaneHeight(-Infinity, 1080)).toBe(WF_LANE_H_MIN)
})

test('initialLaneHeight: restore/seed path clamps a persisted value against the CURRENT viewport', () => {
  // Valid on the 1440px-tall screen it was saved from (60vh = 864)...
  expect(initialLaneHeight(800, 1440)).toBe(800)
  // ...but must clamp on restore into a smaller window/screen (60vh = 460.8),
  // not overflow the lane and push the resize handle off-screen.
  expect(initialLaneHeight(800, 768)).toBe(461)
})

test('initialLaneHeight: absent or corrupt config value falls back to the default, then clamps', () => {
  expect(initialLaneHeight(undefined, 1080)).toBe(WF_LANE_H_DEFAULT)
  expect(initialLaneHeight(NaN, 1080)).toBe(WF_LANE_H_MIN)
})
