// Workflow lane (roadmap view, bottom pane): pure selection/layout/validation
// helpers for the graphical dispatch queue. Positions are DERIVED from the
// queue order and the depends_on graph on every render -- nothing here is
// persisted, so the lane can never drift from the shared roadmap. No
// electron/node imports: the renderer draws with it and bun tests it.

import type { RoadmapItem } from './types'

export const WF_NODE_W = 200
export const WF_NODE_H = 84
/** Pitch between card origins: X follows the queue rank, Y the stream row. */
export const WF_PITCH_X = 250
export const WF_PITCH_Y = 116
export const WF_ZOOM_MIN = 0.4
export const WF_ZOOM_MAX = 1.5
/** Auto-fit stops shrinking below this zoom; the lane scrolls instead. */
export const WF_FIT_FLOOR = 0.55

/** Canvas height (px): default/floor, plus the ceiling as a viewport fraction. */
export const WF_LANE_H_DEFAULT = 240
export const WF_LANE_H_MIN = 140
export const WF_LANE_H_MAX_VH = 0.6

/** Clamp a candidate lane height to [WF_LANE_H_MIN, WF_LANE_H_MAX_VH * viewportH]. */
export function clampLaneHeight(px: number, viewportH: number): number {
  // A corrupted/NaN input (bad config, bad viewport read) must floor, not
  // propagate: Math.max(min, NaN) is NaN, which would flow into `height: NaN`.
  const safePx = Number.isFinite(px) ? px : WF_LANE_H_MIN
  const max = Math.max(WF_LANE_H_MIN, viewportH * WF_LANE_H_MAX_VH)
  return Math.round(Math.min(max, Math.max(WF_LANE_H_MIN, safePx)))
}

/**
 * The height to seed the lane's `useState` from: the persisted config value
 * (clamped to the CURRENT viewport) or the default when absent/corrupt. A
 * value valid on the viewport it was saved from can exceed the ceiling of a
 * smaller one on restore (different window size, different PC) -- this must
 * clamp on seed, not only on live drag, or the handle itself can end up
 * pushed off-screen and unrecoverable via the gesture.
 */
export function initialLaneHeight(configHeight: number | undefined, viewportH: number): number {
  return clampLaneHeight(configHeight ?? WF_LANE_H_DEFAULT, viewportH)
}

/** A locked in_progress item with no queue slot: active work outside the queue. */
export function isHead(i: RoadmapItem): boolean {
  return i.locked && i.status === 'in_progress' && i.queue === null
}

/**
 * Items the lane displays: the dispatch queue plus the locked in_progress
 * heads (what the team is actively working on). Order = execution order:
 * locked heads first (oldest lock first), then the queue by position.
 */
export function laneItems(items: RoadmapItem[]): RoadmapItem[] {
  const shown = items.filter(
    (i) =>
      isHead(i) || (i.queue !== null && i.status !== 'done' && i.status !== 'archived')
  )
  return shown.sort((a, b) => {
    const ha = isHead(a) ? 0 : 1
    const hb = isHead(b) ? 0 : 1
    if (ha !== hb) return ha - hb
    if (ha === 0) {
      const la = a.locked_at ?? ''
      const lb = b.locked_at ?? ''
      if (la !== lb) return la < lb ? -1 : 1
      return a.id < b.id ? -1 : 1
    }
    return a.queue! - b.queue! || (a.id < b.id ? -1 : 1)
  })
}

export interface LanePos {
  x: number
  y: number
  /** 0-based execution rank (locked heads included). */
  rank: number
  /** Horizontal column: dependency depth, components chained left to right. */
  col: number
  /** Vertical slot inside the column (0 = top): parallel siblings stack. */
  row: number
}

/**
 * Derived placement, hierarchy-first: inside a connected component of the
 * depends_on graph, the column is the dependency DEPTH (longest path from the
 * component's roots) -- so N:1 / 1:N fan-ins and fan-outs stack their
 * parallel branches vertically in the same column, like the graph view's
 * layout transposed. Unrelated items (distinct components) keep the queue
 * reading: components are chained left to right by their first execution
 * rank, so a dependency-free queue still renders as the familiar flat chain.
 * Inside a column, siblings stack top-down by execution rank.
 */
export function layoutLane(ordered: RoadmapItem[]): Map<string, LanePos> {
  const shown = new Set(ordered.map((i) => i.id))
  const byId = new Map(ordered.map((i) => [i.id, i]))

  // Union-find over displayed items, edges = displayed depends_on pairs.
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)!
    let c = x
    while (parent.get(c) !== c) {
      const n = parent.get(c)!
      parent.set(c, r)
      c = n
    }
    return r
  }
  for (const i of ordered) parent.set(i.id, i.id)
  for (const i of ordered) {
    for (const dep of i.depends_on) {
      if (shown.has(dep)) parent.set(find(dep), find(i.id))
    }
  }

  // Dependency depth (longest path over displayed deps; pre-marked cycles safe).
  const depths = new Map<string, number>()
  const depthOf = (id: string): number => {
    const cached = depths.get(id)
    if (cached !== undefined) return cached
    depths.set(id, 0)
    const item = byId.get(id)!
    const d = item.depends_on.reduce(
      (max, dep) => (shown.has(dep) ? Math.max(max, depthOf(dep) + 1) : max),
      0
    )
    depths.set(id, d)
    return d
  }
  for (const i of ordered) depthOf(i.id)

  // Components in first-rank order, each starting after the previous one.
  const componentOrder: string[] = []
  const members = new Map<string, RoadmapItem[]>()
  ordered.forEach((i) => {
    const root = find(i.id)
    const list = members.get(root)
    if (list) list.push(i)
    else {
      members.set(root, [i])
      componentOrder.push(root)
    }
  })

  const rank = new Map(ordered.map((i, r) => [i.id, r]))
  const pos = new Map<string, LanePos>()
  let colOffset = 0
  for (const root of componentOrder) {
    const items = members.get(root)!
    const rows = new Map<number, number>() // per-column stack cursor
    let maxDepth = 0
    // Members arrive in rank order, so per-column stacking follows the queue.
    for (const i of items) {
      const depth = depths.get(i.id)!
      maxDepth = Math.max(maxDepth, depth)
      const col = colOffset + depth
      const row = rows.get(depth) ?? 0
      rows.set(depth, row + 1)
      pos.set(i.id, {
        x: col * WF_PITCH_X,
        y: row * WF_PITCH_Y,
        rank: rank.get(i.id)!,
        col,
        row
      })
    }
    colOffset += maxDepth + 1
  }
  return pos
}

/**
 * Dependencies `dragId` should adopt to become a parallel sibling of
 * `targetId` (the stack-below/above drop gesture): a sanitized copy of the
 * target's depends_on (self and cycle-inducing ids removed). Returns null
 * when the gesture cannot express parallelism -- the target has no usable
 * dependency to share (draw links, or drag the other card instead).
 */
export function siblingDeps(
  items: RoadmapItem[],
  dragId: string,
  targetId: string
): string[] | null {
  const target = items.find((i) => i.id === targetId)
  if (!target || dragId === targetId) return null
  const deps = target.depends_on.filter(
    (d) => d !== dragId && !dependsWouldCycle(items, dragId, d)
  )
  return deps.length > 0 ? deps : null
}

export interface LaneEdge {
  /** The dependency (upstream, must be done first). */
  from: string
  /** The dependent (downstream). */
  to: string
  /** True when the queue schedules the dependent BEFORE its dependency. */
  violated: boolean
}

/** depends_on links between displayed items, flagged when the order breaks them. */
export function laneEdges(ordered: RoadmapItem[]): LaneEdge[] {
  const rank = new Map(ordered.map((i, r) => [i.id, r]))
  const edges: LaneEdge[] = []
  for (const item of ordered) {
    for (const dep of item.depends_on) {
      const depRank = rank.get(dep)
      if (depRank === undefined) continue
      edges.push({ from: dep, to: item.id, violated: depRank > rank.get(item.id)! })
    }
  }
  return edges
}

/**
 * Dependencies of a displayed item that the lane does NOT show and that are
 * not done: the item is scheduled while its prerequisite is neither finished
 * nor planned before it (an archived dependency is flagged too -- it will
 * never complete). Dangling ids (dependency deleted broker-side) are skipped.
 */
export function unmetDeps(
  item: RoadmapItem,
  all: RoadmapItem[],
  shownIds: Set<string>
): RoadmapItem[] {
  const byId = new Map(all.map((i) => [i.id, i]))
  const out: RoadmapItem[] = []
  for (const dep of item.depends_on) {
    if (shownIds.has(dep)) continue
    const d = byId.get(dep)
    if (d && d.status !== 'done') out.push(d)
  }
  return out
}

/** Does `fromId` transitively depend on `toId` (walking depends_on)? */
function reachesDep(items: RoadmapItem[], fromId: string, toId: string): boolean {
  const byId = new Map(items.map((i) => [i.id, i]))
  const seen = new Set<string>()
  const queue = [fromId]
  while (queue.length > 0) {
    const cur = queue.shift()!
    if (seen.has(cur)) continue
    seen.add(cur)
    if (cur === toId) return true
    const item = byId.get(cur)
    if (item) queue.push(...item.depends_on)
  }
  return false
}

/**
 * Would making `childId` depend on `parentId` create a cycle? True when the
 * candidate parent already (transitively) depends on the child. Mirrors
 * graph.ts wouldCreateCycle but walks depends_on arrays.
 */
export function dependsWouldCycle(
  items: RoadmapItem[],
  childId: string,
  parentId: string
): boolean {
  return childId === parentId || reachesDep(items, parentId, childId)
}

/**
 * Are two items ordered by a dependency path (either direction)? Related
 * items cannot be parallel siblings: the stack gesture must not offer them,
 * the card slides sideways instead.
 */
export function dependsRelated(items: RoadmapItem[], aId: string, bId: string): boolean {
  return reachesDep(items, aId, bId) || reachesDep(items, bId, aId)
}

/**
 * Transitive dependency closure to enqueue alongside `id`: walks `id`'s
 * depends_on graph and returns, in dependency-first (topological) order, the
 * ids that must join the queue with it. Filters out items already settled
 * (done/archived), already queued, locked in_progress heads (active work
 * outside the queue -- see isHead), and dangling ids (referenced in
 * depends_on but absent from `items`). `id` itself is never included: the
 * caller splices this result immediately before `id`'s own slot.
 */
export function enqueueClosure(items: RoadmapItem[], id: string): string[] {
  const byId = new Map(items.map((i) => [i.id, i]))
  const visited = new Set<string>()
  const order: string[] = []

  function visit(curId: string): void {
    if (visited.has(curId)) return
    visited.add(curId)
    const cur = byId.get(curId)
    if (!cur) return // dangling: referenced in depends_on, absent from items
    for (const depId of cur.depends_on) visit(depId)
    if (curId === id) return // the dropped/queued item itself: caller places it
    if (cur.status === 'done' || cur.status === 'archived') return
    if (cur.queue !== null) return // already queued: nothing to do
    if (isHead(cur)) return // locked in_progress head: active work, not queueable
    order.push(curId)
  }

  visit(id)
  return order
}

/**
 * Displayed items a drop of `drag` at full-lane `slot` would put on the wrong
 * side of one of its DIRECT dependency links: a dependency scheduled at/after
 * the insertion point, or a dependent scheduled before it. The renderer turns
 * these cards' borders and the connecting links red while the drag hovers.
 */
export function slotConflicts(
  ordered: RoadmapItem[],
  drag: RoadmapItem,
  slot: number
): string[] {
  const without = ordered.filter((i) => i.id !== drag.id)
  const rank = ordered.findIndex((i) => i.id === drag.id)
  const adj = rank >= 0 && slot > rank ? slot - 1 : slot
  const idx = Math.min(without.length, Math.max(0, adj))
  const out: string[] = []
  without.forEach((i, j) => {
    if (drag.depends_on.includes(i.id) && j >= idx) out.push(i.id)
    if (i.depends_on.includes(drag.id) && j < idx) out.push(i.id)
  })
  return out
}

/**
 * Insertion slot (index in the full lane order) for a drop at world-space
 * `worldX`: the number of displayed cards whose column lies left of the drop.
 * With a hierarchy layout several cards share a column, so a cut between two
 * columns inserts after every card of the columns left of it.
 */
export function insertSlotAt(
  ordered: RoadmapItem[],
  pos: Map<string, LanePos>,
  worldX: number
): number {
  return ordered.filter((i) => pos.get(i.id)!.x + WF_NODE_W / 2 < worldX).length
}

/** World X of the insertion caret for a cut at `worldX` (between columns). */
export function caretXAt(
  ordered: RoadmapItem[],
  pos: Map<string, LanePos>,
  worldX: number
): number {
  const xs = [...new Set(ordered.map((i) => pos.get(i.id)!.x))].sort((a, b) => a - b)
  if (xs.length === 0) return 0
  const left = xs.filter((x) => x + WF_NODE_W / 2 < worldX)
  const right = xs.filter((x) => x + WF_NODE_W / 2 >= worldX)
  const leftEdge = left.length > 0 ? left[left.length - 1]! + WF_NODE_W : right[0]! - WF_PITCH_X + WF_NODE_W
  const rightEdge = right.length > 0 ? right[0]! : leftEdge + (WF_PITCH_X - WF_NODE_W)
  return (leftEdge + rightEdge) / 2 - 1.5
}

export interface StackHit {
  /** The card the drop stacks against (nearest in the hovered column). */
  targetId: string
  /** World coords of the ghost slot shown above/below the target. */
  x: number
  y: number
}

/**
 * Stack-drop detection: a drop inside a column's horizontal band but clearly
 * above/below a card reads as "make it a parallel sibling of that card"
 * (grid-assisted placement). A drop ON a card (or outside any column band)
 * returns null and stays an insertion.
 */
export function stackTargetAt(
  ordered: RoadmapItem[],
  pos: Map<string, LanePos>,
  worldX: number,
  worldY: number,
  excludeId?: string
): StackHit | null {
  const band = ordered.filter(
    (i) =>
      i.id !== excludeId &&
      Math.abs(pos.get(i.id)!.x + WF_NODE_W / 2 - worldX) < WF_PITCH_X / 2
  )
  if (band.length === 0) return null
  let best = band[0]!
  let bestDist = Infinity
  for (const i of band) {
    const d = Math.abs(pos.get(i.id)!.y + WF_NODE_H / 2 - worldY)
    if (d < bestDist) {
      bestDist = d
      best = i
    }
  }
  const p = pos.get(best.id)!
  const cy = p.y + WF_NODE_H / 2
  if (Math.abs(worldY - cy) < WF_NODE_H * 0.6) return null
  return {
    targetId: best.id,
    x: p.x,
    y: worldY < cy ? p.y - WF_PITCH_Y : p.y + WF_PITCH_Y
  }
}

/**
 * New queue id list after dropping `id` at `index` (an index in the list
 * WITHOUT `id`, i.e. the caret slot shown to the operator). Returns a new
 * array; `id` is removed first when it was already queued.
 */
export function insertAt(ids: string[], id: string, index: number): string[] {
  const next = ids.filter((x) => x !== id)
  next.splice(Math.min(next.length, Math.max(0, index)), 0, id)
  return next
}
