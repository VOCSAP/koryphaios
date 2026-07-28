// Graph chat data model + pure DAG operations (EXPLORATION-graph-chat C23).
//
// The graph is the source of truth (decision D1): every assistant node is the
// output of ONE stateless headless invocation whose context is recompiled from
// its ancestors at inference time. No CLI session state is referenced here.
//
// Pure module shared by main and renderer: no node/electron imports, fully
// unit-testable under bun.

export type GraphNodeType = 'user' | 'assistant' | 'judge'

/**
 * How an assistant node is produced: one of the headless CLIs, or 'local' —
 * a direct HTTP call to an OpenAI-compatible endpoint configured in Settings
 * (Ollama, LiteLLM… — C29).
 */
export type GraphCli = 'claude' | 'codex' | 'gemini' | 'antigravity' | 'local'
export const GRAPH_CLIS: GraphCli[] = ['claude', 'codex', 'gemini', 'antigravity', 'local']

/** One inference target of a fan-out. model '' = the CLI's default model. */
export interface ModelTarget {
  cli: GraphCli
  model: string
  /** cli 'local' only: which configured local provider runs it (C29). */
  providerId?: string
}

export interface GraphNode {
  /** Short random id, unique within the doc. */
  id: string
  type: GraphNodeType
  /** Parent node ids ([] for a root). N>1 = a cross/merge node (DAG). */
  parents: string[]
  /** Prompt text (user) or model answer (assistant/judge). */
  text: string
  /** Canvas position (manual layout, like the demo). */
  x: number
  y: number
  /** Card size (a0f2e983): operator-resized, in canvas units. Undefined = GRAPH_NODE_W/H. */
  w?: number
  h?: number
  createdAt: number
  /** assistant/judge only. */
  cli?: GraphCli
  model?: string
  /** cli 'local' only: the configured provider that produced it (C29). */
  providerId?: string
  status?: 'ok' | 'error'
  error?: string
  durationMs?: number
}

export interface GraphDoc {
  id: string
  name: string
  nodes: GraphNode[]
  createdAt: number
  updatedAt: number
}

/** Short collision-safe-enough id for nodes/docs (crypto not needed). */
export function graphId(): string {
  return (
    Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 8)
  )
}

export function nodeMap(nodes: GraphNode[]): Map<string, GraphNode> {
  return new Map(nodes.map((n) => [n.id, n]))
}

/**
 * All ancestor ids of `id`, INCLUDING `id` itself (upward BFS). Unknown
 * parent ids are ignored defensively (a hand-edited file must not crash).
 */
export function ancestorsOf(nodes: GraphNode[], id: string): Set<string> {
  const byId = nodeMap(nodes)
  const seen = new Set<string>()
  const queue = [id]
  while (queue.length > 0) {
    const cur = queue.shift()!
    if (seen.has(cur)) continue
    const node = byId.get(cur)
    if (!node) continue
    seen.add(cur)
    queue.push(...node.parents)
  }
  return seen
}

/**
 * Would connecting `parentId` as a parent of `nodeId` create a cycle?
 * True when the candidate parent is the node itself or one of its
 * descendants (i.e. the node is among the candidate's ancestors).
 */
export function wouldCreateCycle(nodes: GraphNode[], nodeId: string, parentId: string): boolean {
  if (nodeId === parentId) return true
  return ancestorsOf(nodes, parentId).has(nodeId)
}

/**
 * Deterministic topological order of a set of node ids: parents always come
 * before children, ties broken chronologically (createdAt, then id). This is
 * the transcript order of a compiled context.
 */
export function linearize(nodes: GraphNode[], ids: Set<string>): GraphNode[] {
  const byId = nodeMap(nodes)
  const picked = [...ids]
    .map((id) => byId.get(id))
    .filter((n): n is GraphNode => !!n)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
  const done = new Set<string>()
  const out: GraphNode[] = []
  const visit = (n: GraphNode): void => {
    if (done.has(n.id)) return
    done.add(n.id) // pre-mark: a (corrupt) cycle must not recurse forever
    for (const pid of n.parents) {
      const p = byId.get(pid)
      if (p && ids.has(pid)) visit(p)
    }
    out.push(n)
  }
  for (const n of picked) visit(n)
  return out
}

export interface MergePartition {
  /** Shared ancestry of ALL heads, linearized (may be empty). */
  trunk: GraphNode[]
  /** Per-head exclusive ancestry (head included), linearized. */
  branches: { head: GraphNode; nodes: GraphNode[] }[]
}

/**
 * Three-way-style partition for a merge/cross inference (decision D3): the
 * common trunk (intersection of the heads' ancestor sets) is rendered once,
 * then each branch's exclusive delta becomes a labeled section. Heads listed
 * in the given order; a head id that does not resolve is skipped.
 */
export function mergePartition(nodes: GraphNode[], headIds: string[]): MergePartition {
  const byId = nodeMap(nodes)
  const heads = headIds.map((id) => byId.get(id)).filter((n): n is GraphNode => !!n)
  const sets = heads.map((h) => ancestorsOf(nodes, h.id))
  let common = new Set<string>()
  if (sets.length > 0) {
    common = new Set(sets[0]!)
    for (const s of sets.slice(1)) for (const id of [...common]) if (!s.has(id)) common.delete(id)
  }
  return {
    trunk: linearize(nodes, common),
    branches: heads.map((head, i) => {
      const delta = new Set([...sets[i]!].filter((id) => !common.has(id)))
      return { head, nodes: linearize(nodes, delta) }
    })
  }
}

/** Children ids of a node (to guard leaf-only deletion in the UI/IPC). */
export function childrenOf(nodes: GraphNode[], id: string): GraphNode[] {
  return nodes.filter((n) => n.parents.includes(id))
}

// ---------------------------------------------------------------------------
// Canvas grid + hierarchical layout. Pure helpers shared by the renderer
// (GraphView) and the engine so every automatic placement lands on the same
// grid: node size and pitches are the single source of truth here.

export const GRAPH_GRID = 20
export const GRAPH_NODE_W = 260
export const GRAPH_NODE_H = 130
/** Horizontal/vertical pitch between card origins in automatic placements (grid multiples). */
export const GRAPH_PITCH_X = 340
export const GRAPH_PITCH_Y = 180

// Resize bounds (a0f2e983): a card must stay legible (min) and never eat the
// whole canvas (max). Both ends are grid multiples so a resized card still
// lands on the dot grid like everything else.
export const GRAPH_NODE_MIN_W = 180
export const GRAPH_NODE_MIN_H = 90
export const GRAPH_NODE_MAX_W = 640
export const GRAPH_NODE_MAX_H = 480

export function snapToGrid(v: number): number {
  return Math.round(v / GRAPH_GRID) * GRAPH_GRID
}

/**
 * Snap + clamp a card size to [MIN, MAX]. Single choke point for the resize
 * drag (renderer) AND parseGraphDoc (main-side persist) so a hostile or
 * hand-edited doc can never carry a zero/negative/absurd node size.
 */
export function clampNodeSize(w: number, h: number): { w: number; h: number } {
  return {
    w: Math.min(GRAPH_NODE_MAX_W, Math.max(GRAPH_NODE_MIN_W, snapToGrid(w))),
    h: Math.min(GRAPH_NODE_MAX_H, Math.max(GRAPH_NODE_MIN_H, snapToGrid(h)))
  }
}

/**
 * Snap (x, y) to the grid, then scan RIGHT (same hierarchy level) until the
 * card no longer overlaps an existing node. Keeps siblings created one by one
 * on the same horizontal line instead of stacking them.
 */
export function findFreeSpot(
  nodes: GraphNode[],
  x: number,
  y: number,
  ignoreIds: string[] = []
): { x: number; y: number } {
  let sx = snapToGrid(x)
  const sy = snapToGrid(y)
  const ignore = new Set(ignoreIds)
  const overlaps = (): boolean =>
    nodes.some(
      (n) =>
        !ignore.has(n.id) &&
        Math.abs(n.x - sx) < GRAPH_NODE_W + GRAPH_GRID &&
        Math.abs(n.y - sy) < GRAPH_NODE_H + GRAPH_GRID
    )
  for (let i = 0; i < 500 && overlaps(); i++) sx += GRAPH_GRID * 2
  return { x: sx, y: sy }
}

/**
 * Visual/semantic kind of a node, for the outline timeline and canvas
 * accents: 'prompt' (plain user text / continuation), 'whatif' (a user node
 * branching off a parent that has several children), 'merge' (judge node, or
 * a user node crossing several parents), 'answer' (assistant output).
 */
export type GraphNodeKind = 'prompt' | 'whatif' | 'merge' | 'answer'

export function graphNodeKind(nodes: GraphNode[], node: GraphNode): GraphNodeKind {
  if (node.type === 'judge') return 'merge'
  if (node.type === 'assistant') return 'answer'
  if (node.parents.length >= 2) return 'merge'
  const parent = node.parents[0]
  // Judge children are wiring, not conversation: they never make a sibling a branch.
  if (parent && childrenOf(nodes, parent).filter((c) => c.type !== 'judge').length >= 2) {
    return 'whatif'
  }
  return 'prompt'
}

export interface OutlineRow {
  node: GraphNode
  /** DFS depth (0 = root). A multi-parent node appears once, under the first parent reached. */
  depth: number
}

/**
 * Outline order for the timeline panel: depth-first from the roots (roots by
 * createdAt, children left-to-right by canvas x then createdAt), each node
 * listed exactly once. Orphans of a hand-edited doc are appended defensively.
 */
export function outlineOrder(nodes: GraphNode[]): OutlineRow[] {
  const ids = new Set(nodes.map((n) => n.id))
  const out: OutlineRow[] = []
  const seen = new Set<string>()
  const byCreation = (a: GraphNode, b: GraphNode): number =>
    a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)
  const visit = (n: GraphNode, depth: number): void => {
    if (seen.has(n.id)) return
    seen.add(n.id)
    out.push({ node: n, depth })
    const children = nodes
      .filter((c) => c.parents.includes(n.id))
      .sort((a, b) => a.x - b.x || byCreation(a, b))
    for (const c of children) visit(c, depth + 1)
  }
  const roots = nodes.filter((n) => !n.parents.some((p) => ids.has(p))).sort(byCreation)
  for (const r of roots) visit(r, 0)
  for (const n of [...nodes].sort(byCreation)) visit(n, 0)
  return out
}

/**
 * Recompute every node position as a clean hierarchical layout on the grid:
 * depth (longest path from a root) becomes the row, siblings sit on the same
 * horizontal line, each row is ordered by the mean x of its parents
 * (barycenter pass, keeps edges roughly vertical) and centered around x=0.
 * Returns a NEW node array; manual positions are overwritten by design.
 */
export function layoutGraph(nodes: GraphNode[]): GraphNode[] {
  const byId = nodeMap(nodes)
  const depths = new Map<string, number>()
  const depthOf = (n: GraphNode): number => {
    const cached = depths.get(n.id)
    if (cached !== undefined) return cached
    depths.set(n.id, 0) // pre-mark: a corrupt cycle must not recurse forever
    const d = n.parents.reduce((max, pid) => {
      const p = byId.get(pid)
      return p ? Math.max(max, depthOf(p) + 1) : max
    }, 0)
    depths.set(n.id, d)
    return d
  }
  for (const n of nodes) depthOf(n)

  const levels = new Map<number, GraphNode[]>()
  for (const n of nodes) {
    const d = depths.get(n.id) ?? 0
    const row = levels.get(d)
    if (row) row.push(n)
    else levels.set(d, [n])
  }

  const pos = new Map<string, { x: number; y: number }>()
  const byCreation = (a: GraphNode, b: GraphNode): number =>
    a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)
  for (const d of [...levels.keys()].sort((a, b) => a - b)) {
    const row = levels.get(d)!
    const keyOf = (n: GraphNode): number => {
      const xs = n.parents.map((p) => pos.get(p)?.x).filter((x): x is number => x !== undefined)
      return xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : 0
    }
    row.sort((a, b) => keyOf(a) - keyOf(b) || byCreation(a, b))
    row.forEach((n, i) => {
      pos.set(n.id, {
        x: snapToGrid((i - (row.length - 1) / 2) * GRAPH_PITCH_X),
        y: snapToGrid(d * GRAPH_PITCH_Y)
      })
    })
  }
  return nodes.map((n) => ({ ...n, ...pos.get(n.id)! }))
}

// ---------------------------------------------------------------------------
// Shape validation (graph:save receives a whole doc from the renderer; a
// corrupted payload must not be persisted). Mirrors parseTemplate's spirit:
// returns a normalized doc or null.

const NODE_TYPES: GraphNodeType[] = ['user', 'assistant', 'judge']
const MAX_NODE_TEXT = 512 * 1024
const MAX_NODES = 2000

function str(v: unknown, max = 512): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

export function parseGraphDoc(raw: unknown): GraphDoc | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  const id = str(d.id, 64)
  if (!id) return null
  const rawNodes = Array.isArray(d.nodes) ? d.nodes.slice(0, MAX_NODES) : []
  const nodes: GraphNode[] = []
  const ids = new Set<string>()
  for (const rn of rawNodes) {
    if (!rn || typeof rn !== 'object') continue
    const n = rn as Record<string, unknown>
    const nid = str(n.id, 64)
    const type = str(n.type, 16) as GraphNodeType
    if (!nid || ids.has(nid) || !NODE_TYPES.includes(type)) continue
    ids.add(nid)
    const node: GraphNode = {
      id: nid,
      type,
      parents: Array.isArray(n.parents) ? n.parents.map((p) => str(p, 64)).filter(Boolean) : [],
      text: str(n.text, MAX_NODE_TEXT),
      x: num(n.x),
      y: num(n.y),
      createdAt: num(n.createdAt, Date.now())
    }
    const cli = str(n.cli, 16) as GraphCli
    if (GRAPH_CLIS.includes(cli)) node.cli = cli
    if (typeof n.model === 'string') node.model = str(n.model, 128)
    if (typeof n.providerId === 'string' && n.providerId) node.providerId = str(n.providerId, 64)
    if (n.status === 'ok' || n.status === 'error') node.status = n.status
    if (typeof n.error === 'string') node.error = str(n.error, 2000)
    if (typeof n.durationMs === 'number') node.durationMs = num(n.durationMs)
    // Resize (a0f2e983): optional-field/defaults-are-constants, same as the
    // rest of this loop -- absent or non-finite stays undefined (renderer
    // falls back to GRAPH_NODE_W/H), present gets clamped so a hostile or
    // hand-edited doc can never carry a zero/negative/absurd node size.
    if (typeof n.w === 'number' && Number.isFinite(n.w) && typeof n.h === 'number' && Number.isFinite(n.h)) {
      const size = clampNodeSize(n.w, n.h)
      node.w = size.w
      node.h = size.h
    }
    nodes.push(node)
  }
  // Drop dangling parent references, then reject docs where a cycle survived
  // (ancestorsOf pre-marks so it terminates, but a cyclic doc is corrupt).
  for (const n of nodes) n.parents = n.parents.filter((p) => ids.has(p) && p !== n.id)
  for (const n of nodes) {
    for (const p of n.parents) {
      if (ancestorsOf(nodes, p).has(n.id)) return null
    }
  }
  return {
    id,
    name: str(d.name, 200) || 'graph',
    nodes,
    createdAt: num(d.createdAt, Date.now()),
    updatedAt: num(d.updatedAt, Date.now())
  }
}
