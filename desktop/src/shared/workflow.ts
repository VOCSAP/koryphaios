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
 * Single source of truth for breaking a tie between two roadmap items: byte
 * compare on id, matching the broker's `ORDER BY queue, id` (SQLite BINARY
 * collation), NOT `localeCompare` (locale-aware, diverges from BINARY the
 * moment an id leaves lowercase hex). Every site that orders the queue --
 * here, dispatch.ts, and any renderer call site -- must import this instead
 * of re-deriving its own tiebreak: three independent copies is how the
 * queue order silently drifted across the broker, main and renderer before
 * this was consolidated (roadmap card 42edc88b phase 0).
 */
export function compareById(a: RoadmapItem, b: RoadmapItem): number {
  return a.id < b.id ? -1 : 1
}

/**
 * The dispatch queue only (no locked heads), ordered by queue position then
 * compareById. Single source of truth for "the current queue order": any
 * site that needs to read or rebuild the queue id array must call this,
 * not re-filter/re-sort `items` locally -- two independent derivations of
 * the same order is the bug class this closes (phase 0 of 42edc88b), not
 * merely a missing tiebreak. The comparator is what guarantees a stable
 * result on a tie; nothing here assumes queue positions are unique.
 */
export function queuedItems(items: RoadmapItem[]): RoadmapItem[] {
  return items
    .filter((i) => i.queue !== null && i.status !== 'done' && i.status !== 'archived')
    .sort((a, b) => a.queue! - b.queue! || compareById(a, b))
}

/**
 * Wave grouping of an ALREADY-ORDERED queued list (see queuedItems): a run of
 * consecutive items sharing the same non-null `queue` value is one wave.
 * Single source of truth for "the wave grouping a WRITE must preserve" --
 * mirrors queuedItems' earlier role for flat order (phase 0 of 42edc88b).
 * Any write that sends `ids` to roadmap:reorder without a `waves` argument
 * built from this (or an equivalent grouping) silently flattens every
 * existing tie into 1..N, because the broker's legacy no-waves branch stamps
 * sequential queue numbers -- phase 2's finding: 4 non-lane call sites
 * (saveDraft, queueItem desktop+mobile, stackItem) wrote ids-only and so
 * destroyed any tie the lane had just created the moment any of them ran.
 */
export function wavesOf(ordered: RoadmapItem[]): string[][] {
  const waves: string[][] = []
  let prevQueue: number | null | undefined
  for (const item of ordered) {
    if (waves.length > 0 && item.queue !== null && item.queue === prevQueue) {
      waves[waves.length - 1]!.push(item.id)
    } else {
      waves.push([item.id])
    }
    prevQueue = item.queue
  }
  return waves
}

/**
 * Items the lane displays: the dispatch queue plus the locked in_progress
 * heads (what the team is actively working on). Order = execution order:
 * locked heads first (oldest lock first), then the queue by position.
 */
export function laneItems(items: RoadmapItem[]): RoadmapItem[] {
  const heads = items.filter(isHead).sort((a, b) => {
    const la = a.locked_at ?? ''
    const lb = b.locked_at ?? ''
    return la !== lb ? (la < lb ? -1 : 1) : compareById(a, b)
  })
  return [...heads, ...queuedItems(items)]
}

export interface LanePos {
  x: number
  y: number
  /** 0-based execution rank (locked heads included). */
  rank: number
  /** Horizontal column: the WAVE index (see layoutLane). */
  col: number
  /** Vertical slot inside the column (0 = top): wave members stack. */
  row: number
}

/**
 * Derived placement, wave-first: the column is the WAVE index -- a run of
 * items the broker stamps at the SAME execution slot (roadmap card 42edc88b
 * phase 1's `waves` reorder param ties ids under one `queue` value). Distinct
 * queue values render as distinct columns via a DENSE rank over the values
 * actually PRESENT, not the raw value itself: `queue` numbers are not
 * guaranteed contiguous (a mid-queue removal, or an explicit `queue` write
 * via roadmap_add/roadmap_update, both leave gaps), so indexing by the raw
 * value would draw empty columns for the gaps.
 *
 * Locked in_progress heads all share column 0 instead of one column each:
 * heads are the one place the system has ACTUAL, observed concurrency
 * (several agents genuinely working right now), not a scheduling intent --
 * laying them out left to right like a queue would draw real parallelism as
 * sequential, in a view whose whole point in phase 2 is to show
 * parallelism. laneItems already orders heads oldest-locked-first, so row
 * order still reflects lock age; queued items stack by queue order
 * (queuedItems' compareById tiebreak keeps ties stable).
 */
export function layoutLane(ordered: RoadmapItem[]): Map<string, LanePos> {
  const pos = new Map<string, LanePos>()
  const rankOf = new Map(ordered.map((i, r) => [i.id, r]))

  const heads = ordered.filter(isHead)
  heads.forEach((item, row) => {
    pos.set(item.id, { x: 0, y: row * WF_PITCH_Y, rank: rankOf.get(item.id)!, col: 0, row })
  })

  const queued = ordered.filter((i) => !isHead(i))
  const distinctQueues = [...new Set(queued.map((i) => i.queue))].sort((a, b) => a! - b!)
  const colOffset = heads.length > 0 ? 1 : 0
  const queueCol = new Map(distinctQueues.map((q, i) => [q, i + colOffset]))
  const rows = new Map<number, number>() // per-column stack cursor
  queued.forEach((item) => {
    const col = queueCol.get(item.queue)!
    const row = rows.get(col) ?? 0
    rows.set(col, row + 1)
    pos.set(item.id, {
      x: col * WF_PITCH_X,
      y: row * WF_PITCH_Y,
      rank: rankOf.get(item.id)!,
      col,
      row
    })
  })

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
    // Deliberate: recursion does NOT stop at a done/archived node. If a done
    // item still has an unfinished dependency (a possible but inconsistent
    // state -- it should not have been marked done), the closure leans
    // toward including that unfinished dependency rather than trusting the
    // done flag to mean "and everything under it is settled too". Safe bias:
    // over-include a settled-looking branch rather than silently skip real
    // unfinished work. See enqueueClosure test "a done item with an
    // unfinished nested dependency still enqueues that dependency".
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
 * Only DIRECT depends_on links are checked (`drag.depends_on`/`i.depends_on`
 * membership, never a transitive closure): if A depends on B, B depends on
 * C, and a drop lands A and C in the same wave, that real violation is NOT
 * reported here. Catching it would need a full transitive closure computed
 * on every drag frame; treat this as a known limit of the check, not a
 * guarantee that any two co-located cards are conflict-free.
 *
 * When `join` is true the drop additionally TIES `drag`'s queue with the
 * wave landed on (see insertSlotAt's `join`): any OTHER member of that wave
 * directly linked to `drag` is then a conflict too, independent of
 * before/after order -- two items on either end of a direct dependency can
 * never share an execution slot, even when their relative position would
 * otherwise look fine. A wave made only of locked heads is never a join
 * target (heads are not queue-tied; see layoutLane).
 */
export function slotConflicts(
  ordered: RoadmapItem[],
  drag: RoadmapItem,
  slot: number,
  join = false
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
  if (join) {
    const anchor = without[idx] ?? without[idx - 1]
    if (anchor && !isHead(anchor)) {
      for (const i of without) {
        if (isHead(i) || i.queue !== anchor.queue || out.includes(i.id)) continue
        if (drag.depends_on.includes(i.id) || i.depends_on.includes(drag.id)) out.push(i.id)
      }
    }
  }
  return out
}

export interface SlotHit {
  /** Insertion index in the full lane order (see insertSlotAt). */
  index: number
  /**
   * True when `worldX` falls inside an existing (non-head) column's
   * WF_NODE_W-wide band: the drop TIES `drag` into that wave, rather than
   * starting a new one-item wave in the gap between two columns.
   */
  join: boolean
}

/**
 * Insertion slot (index in the full lane order) for a drop at world-space
 * `worldX`: the number of displayed cards whose column lies left of the drop.
 * With the wave layout several cards share a column, so a cut between two
 * columns inserts after every card of the columns left of it. `join` is
 * derived purely from `worldX` against the already-laid-out column x
 * positions in `pos` (never from queue equality directly), since that is
 * what the caret/hover math in the renderer actually has at hand; the heads
 * column never counts toward `join` (see layoutLane and slotConflicts).
 */
export function insertSlotAt(
  ordered: RoadmapItem[],
  pos: Map<string, LanePos>,
  worldX: number
): SlotHit {
  const index = ordered.filter((i) => pos.get(i.id)!.x + WF_NODE_W / 2 < worldX).length
  return { index, join: joinAnchorAt(ordered, pos, worldX) !== null }
}

/**
 * The id of a queued (non-head) item whose WAVE `worldX` lands inside (see
 * SlotHit.join) -- or null when the drop is in a gap between waves. All
 * members of a wave share layoutLane's x, so the FIRST match identifies the
 * wave: any of its members works as the key to look it up in a wavesOf(...)
 * grouping (card 42edc88b phase 2, commitDrop's join wiring).
 */
export function joinAnchorAt(
  ordered: RoadmapItem[],
  pos: Map<string, LanePos>,
  worldX: number
): string | null {
  for (const item of ordered) {
    if (isHead(item)) continue
    const x = pos.get(item.id)!.x
    if (Math.abs(x + WF_NODE_W / 2 - worldX) < WF_NODE_W / 2) return item.id
  }
  return null
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

/**
 * Splice `ids` into `waves` (see wavesOf) at flat index `at`, each as its OWN
 * singleton wave, in the order given -- never merged into a neighboring wave.
 * v1/conservative by design (roadmap card 42edc88b phase 2, team-lead
 * decision 2026-07-29): a newly-queued item (or an enqueueClosure batch
 * spliced ahead of it in topological order) has no existing tie to join, so
 * it starts alone. Grouping independent dependency-closure ids into a SHARED
 * wave (same dep-level = same slot) is a real future improvement, but belongs
 * with the future multi-dispatch work (roadmap 5852c074), not here: doing it
 * silently now would let one write invent a concurrency tie the operator
 * never asked for. Splicing into the MIDDLE of an existing wave correctly
 * breaks it into two independently-tied runs either side of the insertion --
 * inserting a foreign, order-only item between two tied members is exactly
 * what un-ties them positionally, and is unavoidable given a flat insertion
 * index.
 */
export function insertSoloWaves(waves: string[][], at: number, ids: string[]): string[][] {
  if (ids.length === 0) return waves
  const solo = ids.map((id) => [id])
  let count = 0
  for (let i = 0; i < waves.length; i++) {
    const wave = waves[i]!
    if (count + wave.length > at) {
      const cut = at - count
      const before = wave.slice(0, cut)
      const after = wave.slice(cut)
      const spliced = [
        ...(before.length > 0 ? [before] : []),
        ...solo,
        ...(after.length > 0 ? [after] : [])
      ]
      return [...waves.slice(0, i), ...spliced, ...waves.slice(i + 1)]
    }
    count += wave.length
  }
  return [...waves, ...solo]
}

// ----- reorder-id invariant (card 3b0fda5f) -----
//
// The filter/search UI (roadmap-data.ts) hands the two layouts a BOARD that
// is a subset of the true dispatch queue. Every reorder commit (save's
// lane-born draft, queueItem, stackItem, WorkflowLane's own drops) must
// still be computed against the WHOLE unfiltered list -- a reorder built
// from the filtered board would silently drop every hidden item out of the
// queue the moment it committed.
//
// Review round 2 (2026-08-10), MAJOR: an EARLIER version of this branded
// exactly `{ ...queue, all: board }` COMPILED against it -- object-literal
// spread copies a value's own keys (symbols included), so the resulting
// literal structurally matched the interface, escaping BOTH the type brand
// and tests/desktop-workflow-queue-source.test.ts's `queueSourceOf(` grep
// sweep in one motion, which is exactly the silent-unqueue this exists to
// forbid. A CLASS with a private field closes that hole: TypeScript only
// treats a value as assignable to a class type with a private member when
// the value's type is nominally that class (or a subtype) -- a fresh object
// literal, however many properties it copies at runtime, is never nominally
// `QueueSource`, so `{ ...queue, all: board }` no longer typechecks as one.
// `queueSourceOf` is kept as the public constructor function (unchanged call
// sites everywhere else); the class itself is private-constructed so it can
// only be minted here. What DOES still survive is a bare `as QueueSource`
// type assertion -- TypeScript's `as` is looser than plain assignment -- so
// that spelling is added to the discipline sweep by name, same file.
class QueueSourceImpl {
  private readonly brand = true
  private constructor(readonly all: RoadmapItem[]) {}
  static mint(unfiltered: RoadmapItem[]): QueueSourceImpl {
    return new QueueSourceImpl(unfiltered)
  }
  /** Runtime companion to the compile-time brand: actually reads `brand`, so
   * TS's noUnusedLocals does not flag a private field that exists only for
   * nominal typing. Also a genuine, if so-far-unused, escape hatch for a
   * caller that receives a `QueueSource` through an `unknown`/IPC boundary
   * and needs to check it at runtime rather than merely assert the type. */
  static isQueueSource(v: unknown): v is QueueSourceImpl {
    return v instanceof QueueSourceImpl && v.brand === true
  }
}

export type QueueSource = QueueSourceImpl

/** The one place a QueueSource may be minted: call with the UNFILTERED list. */
export function queueSourceOf(unfiltered: RoadmapItem[]): QueueSource {
  return QueueSourceImpl.mint(unfiltered)
}

export interface ReorderPayload {
  ids: string[]
  waves: string[][]
}

/**
 * Append `id` to the end of the queue, pulling its unmet, unqueued
 * dependency closure along with it (dependency-first, right before it) in
 * the same commit -- mirrors RoadmapView.queueItem / RoadmapList.queueItem,
 * both of which funnelled this same enqueueClosure composition by hand.
 */
export function buildAppendToQueue(src: QueueSource, id: string): ReorderPayload {
  const queued = queuedItems(src.all).filter((i) => i.id !== id)
  const queuedIds = queued.map((i) => i.id)
  const closure = enqueueClosure(src.all, id)
  const ids = [...queuedIds, ...closure, id]
  const waves = insertSoloWaves(wavesOf(queued), queuedIds.length, [...closure, id])
  return { ids, waves }
}

/**
 * Insert `id` at queue-flat index `at` (an index into the QUEUE order, not
 * the full lane) -- mirrors RoadmapView.save's lane-born-draft placement.
 * No dependency closure: the caller decides whether `id`'s deps need to ride
 * along (save() never has -- a brand-new draft's depends_on are set by the
 * upsert that created it, not by this placement step).
 */
export function buildInsertIntoQueue(src: QueueSource, id: string, at: number): ReorderPayload {
  const queued = queuedItems(src.all)
  const queuedIds = queued.map((i) => i.id)
  const ids = insertAt(queuedIds, id, at)
  const waves = insertSoloWaves(wavesOf(queued), ids.indexOf(id), [id])
  return { ids, waves }
}

/**
 * Place `dragId` as a parallel sibling of `targetId`: inserted right at the
 * boundary before ('before') or after ('after') the target's WHOLE wave --
 * never mid-wave, see stackTargetAt's caller-side wave-boundary rounding
 * this mirrors (RoadmapView.stackItem, team-lead-confirmed 2026-07-29
 * conservative v1). Dependency adoption (dragId adopting targetId's
 * depends_on) is the caller's job via roadmapUpsert, same as today --
 * this only computes the id/wave placement.
 */
export function buildStackIntoQueue(
  src: QueueSource,
  dragId: string,
  targetId: string,
  side: 'before' | 'after' = 'after'
): ReorderPayload {
  const queued = queuedItems(src.all)
  const queuedIds = queued.map((i) => i.id)
  const baseWaves = wavesOf(queued)
  const at = queuedIds.indexOf(targetId)
  const targetWave = at >= 0 ? baseWaves.findIndex((w) => w.includes(targetId)) : -1
  const boundary =
    targetWave >= 0
      ? side === 'after'
        ? baseWaves.slice(0, targetWave + 1).reduce((n, w) => n + w.length, 0)
        : baseWaves.slice(0, targetWave).reduce((n, w) => n + w.length, 0)
      : queuedIds.length
  const ids = insertAt(queuedIds, dragId, boundary)
  const waves = insertSoloWaves(baseWaves, ids.indexOf(dragId), [dragId])
  return { ids, waves }
}
