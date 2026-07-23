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

/**
 * Items the lane displays: the dispatch queue plus the locked in_progress
 * heads (what the team is actively working on). Order = execution order:
 * locked heads first (oldest lock first), then the queue by position.
 */
export function laneItems(items: RoadmapItem[]): RoadmapItem[] {
  const isHead = (i: RoadmapItem): boolean =>
    i.locked && i.status === 'in_progress' && i.queue === null
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
  /** Stream row: items whose depends_on chains touch share a row. */
  row: number
}

/**
 * Derived placement: X advances with the execution rank, Y groups the
 * connected components of the depends_on graph (restricted to the displayed
 * items) into parallel stream rows -- independent chains stack vertically,
 * which is the "parallel work streams" reading the team-lead uses.
 * Rows are ordered by the first rank that appears in the component.
 */
export function layoutLane(ordered: RoadmapItem[]): Map<string, LanePos> {
  const shown = new Set(ordered.map((i) => i.id))
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
  const rowOf = new Map<string, number>()
  let nextRow = 0
  const pos = new Map<string, LanePos>()
  ordered.forEach((i, rank) => {
    const root = find(i.id)
    let row = rowOf.get(root)
    if (row === undefined) {
      row = nextRow++
      rowOf.set(root, row)
    }
    pos.set(i.id, { x: rank * WF_PITCH_X, y: row * WF_PITCH_Y, rank, row })
  })
  return pos
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
  if (childId === parentId) return true
  const byId = new Map(items.map((i) => [i.id, i]))
  const seen = new Set<string>()
  const queue = [parentId]
  while (queue.length > 0) {
    const cur = queue.shift()!
    if (seen.has(cur)) continue
    seen.add(cur)
    if (cur === childId) return true
    const item = byId.get(cur)
    if (item) queue.push(...item.depends_on)
  }
  return false
}

/**
 * Insertion slot for a drop at world-space `worldX` among `count` displayed
 * cards: 0 = before the first card, count = after the last. A drop on a
 * card's origin inserts before it.
 */
export function insertIndexAt(worldX: number, count: number): number {
  return Math.min(count, Math.max(0, Math.round(worldX / WF_PITCH_X)))
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
