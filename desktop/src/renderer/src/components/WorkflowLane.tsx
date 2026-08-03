import { useEffect, useRef, useState } from 'react'
import type { RoadmapItem } from '@shared/types'
import {
  caretXAt,
  clampLaneHeight,
  dependsRelated,
  dependsWouldCycle,
  enqueueClosure,
  initialLaneHeight,
  insertSlotAt,
  insertSoloWaves,
  isHead,
  joinAnchorAt,
  laneEdges,
  laneItems,
  layoutLane,
  queuedItems,
  siblingDeps,
  slotConflicts,
  stackTargetAt,
  unmetDeps,
  wavesOf,
  WF_FIT_FLOOR,
  WF_NODE_H,
  WF_NODE_W,
  WF_ZOOM_MAX,
  WF_ZOOM_MIN,
  type StackHit
} from '@shared/workflow'
import { GLYPH_ACTIONS, GLYPH_BADGES } from './icons'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { ConfirmDialog } from './ConfirmDialog'
import { ContextMenu } from './ContextMenu'
import { KIND_ICONS } from './RoadmapItemModal'

// Workflow lane (bottom half of the roadmap view): the dispatch queue drawn as
// a left-to-right chain of cards, GraphView-style (manual camera, SVG edges,
// positioned divs — no library). Every position is DERIVED from the queue
// order and lock state (shared/workflow.ts): the column is the WAVE — a run
// of items tied for the same execution slot, either by a shared persisted
// `queue` value (queued items) or, for locked in_progress heads, a single
// shared column 0 (heads are ACTUAL observed concurrency, not a scheduling
// intent, so they never lay out as a sequence) — and nothing visual is
// persisted, the lane and the kanban always agree. Dropping a card INSIDE an
// existing wave's column band ties it into that wave (same queue number as
// its new wave-mates); dropping it in the gap between two waves starts a new,
// one-item wave. Reordering commits through ONE atomic roadmap:reorder call
// carrying both the flat id order and this wave grouping; dropping a card
// above/below another makes it a parallel sibling instead (it adopts the
// target's dependencies); depends_on edges are red when the queue order
// breaks them (click an edge for the why).

/** Extra padding around the content when framing the camera. */
const FIT_PAD = 24

type Camera = { x: number; y: number; zoom: number }

interface WorkflowLaneProps {
  /** Full item list of the view (the lane derives its own subset). */
  items: RoadmapItem[]
  hasLead: boolean
  /** Rendered inside the fullscreen modal (no collapse, canvas fills). */
  fullscreen?: boolean
  onToggleFull: () => void
  onDispatch: () => void
  onOpen: (id: string) => void
  onMenu: (item: RoadmapItem, x: number, y: number) => void
  /**
   * Commit a full new queue order (id list of queued items), plus an
   * optional wave grouping (see shared/workflow.ts SlotHit/layoutLane):
   * `waves` must flatten to exactly `ids`, in order. Omitted entirely on a
   * plain reorder that has no wave opinion (e.g. clearing the queue).
   */
  onReorder: (ids: string[], waves?: string[][]) => void
  /** Open the create form for a new item inserted at this queue slot. */
  onCreateAt: (queueIndex: number, dependsOn: string[]) => void
  onAddDep: (childId: string, parentId: string) => void
  onRemoveDep: (childId: string, parentId: string) => void
  /** Stack gesture: `dragId` becomes a parallel sibling of `targetId`. */
  onStack: (dragId: string, targetId: string, dependsOn: string[]) => void
}

export function WorkflowLane({
  items,
  hasLead,
  fullscreen = false,
  onToggleFull,
  onDispatch,
  onOpen,
  onMenu,
  onReorder,
  onCreateAt,
  onAddDep,
  onRemoveDep,
  onStack
}: WorkflowLaneProps): React.JSX.Element {
  const t = useT()
  const showToast = useDeck((s) => s.showToast)
  const config = useDeck((s) => s.config)
  const updateConfig = useDeck((s) => s.updateConfig)
  const [collapsed, setCollapsed] = useState(false)
  // Canvas height (px): seeded from the persisted config, live-dragged via the
  // top-edge handle, committed back to config on pointer-up.
  const [laneHeight, setLaneHeight] = useState(() =>
    initialLaneHeight(config?.wfLaneHeight, window.innerHeight)
  )
  const [camera, setCamera] = useState<Camera>({ x: FIT_PAD, y: FIT_PAD, zoom: 1 })
  // Insertion caret shown during a drag (full-lane slot + world x), or null.
  const [caret, setCaret] = useState<{ slot: number; x: number } | null>(null)
  // Stack-drop ghost slot (parallel-sibling placement), exclusive with caret.
  const [stack, setStack] = useState<StackHit | null>(null)
  // Cards the hovered insertion would wrong-side (dep after / dependent
  // before): their borders and the links to the dragged card turn red.
  const [conflicts, setConflicts] = useState<string[]>([])
  // Internal card drag ghost (world coords) — the card follows the cursor.
  const [ghost, setGhost] = useState<{ id: string; x: number; y: number } | null>(null)
  // Dependency-link drag ghost: source card + cursor tip (world coords).
  const [link, setLink] = useState<{ fromId: string; x: number; y: number } | null>(null)
  // Clicked edge: explanation overlay anchored in lane coords.
  const [edgeInfo, setEdgeInfo] = useState<{
    from: string
    to: string
    violated: boolean
    x: number
    y: number
  } | null>(null)
  const [canvasMenu, setCanvasMenu] = useState<{ x: number; y: number; slot: number } | null>(null)
  // "Clear" confirmation: empties the queue only (roadmap items untouched).
  const [confirmClear, setConfirmClear] = useState(false)
  // Force one re-render post-mount so scrollbar math sees the canvas size.
  const [, setMounted] = useState(false)

  const canvasRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{
    kind: 'pan' | 'node' | 'link'
    id?: string
    startX: number
    startY: number
    origX: number
    origY: number
    moved: boolean
  } | null>(null)
  // Auto-framing follows content changes until the operator takes the camera.
  const autoFrame = useRef(true)
  // A drag's trailing click must not open the detail modal.
  const suppressClick = useRef(false)
  const scrollDrag = useRef<{ startX: number; camX: number; ratio: number } | null>(null)
  const resizeDrag = useRef<{ startY: number; startH: number } | null>(null)

  const lane = laneItems(items)
  const laneIds = lane.map((i) => i.id)
  const pos = layoutLane(lane)
  const edges = laneEdges(lane)
  const shownIds = new Set(laneIds)
  const headCount = lane.filter(isHead).length
  const queuedIds = laneIds.slice(headCount)
  const byId = new Map(items.map((i) => [i.id, i]))
  const showCanvas = fullscreen || !collapsed

  useEffect(() => setMounted(true), [])

  // ----- camera -----

  const bbox = (): { minX: number; minY: number; maxX: number; maxY: number } | null => {
    if (lane.length === 0) return null
    const ps = lane.map((i) => pos.get(i.id)!)
    return {
      minX: Math.min(...ps.map((p) => p.x)),
      minY: Math.min(...ps.map((p) => p.y)),
      maxX: Math.max(...ps.map((p) => p.x + WF_NODE_W)),
      maxY: Math.max(...ps.map((p) => p.y + WF_NODE_H))
    }
  }

  /**
   * Frame the whole chain: shrink to fit down to WF_FIT_FLOOR, then stop —
   * past that point the lane overflows and the scrollbar takes over. The
   * chain is left-anchored when it overflows (the head is what matters).
   */
  const frame = (): void => {
    const el = canvasRef.current
    const b = bbox()
    if (!el || !b) return
    const w = b.maxX - b.minX + 2 * FIT_PAD
    const h = b.maxY - b.minY + 2 * FIT_PAD
    const zoom = Math.min(
      WF_ZOOM_MAX,
      Math.max(WF_FIT_FLOOR, Math.min(el.clientWidth / w, el.clientHeight / h, 1))
    )
    const overflowX = w * zoom > el.clientWidth
    setCamera({
      zoom,
      x: overflowX ? FIT_PAD - b.minX * zoom : (el.clientWidth - (b.minX + b.maxX) * zoom) / 2,
      y: Math.max(
        FIT_PAD - b.minY * zoom,
        (el.clientHeight - (b.minY + b.maxY) * zoom) / 2
      )
    })
  }

  // Re-frame when the chain composition changes, while auto-framing is on.
  const laneKey = laneIds.join(',')
  useEffect(() => {
    if (showCanvas && autoFrame.current) frame()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- frame() reads freshly derived state
  }, [laneKey, showCanvas])

  const toWorld = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return {
      x: (clientX - rect.left - camera.x) / camera.zoom,
      y: (clientY - rect.top - camera.y) / camera.zoom
    }
  }

  const zoomBy = (factor: number): void => {
    const el = canvasRef.current
    if (!el) return
    autoFrame.current = false
    const cx = el.clientWidth / 2
    const cy = el.clientHeight / 2
    setCamera((c) => {
      const zoom = Math.min(WF_ZOOM_MAX, Math.max(WF_ZOOM_MIN, c.zoom * factor))
      const gx = (cx - c.x) / c.zoom
      const gy = (cy - c.y) / c.zoom
      return { zoom, x: cx - gx * zoom, y: cy - gy * zoom }
    })
  }

  const onWheel = (e: React.WheelEvent): void => {
    const el = canvasRef.current
    if (!el) return
    autoFrame.current = false
    const rect = el.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    setCamera((c) => {
      const zoom = Math.min(WF_ZOOM_MAX, Math.max(WF_ZOOM_MIN, c.zoom * (e.deltaY < 0 ? 1.1 : 0.9)))
      const gx = (mx - c.x) / c.zoom
      const gy = (my - c.y) / c.zoom
      return { zoom, x: mx - gx * zoom, y: my - gy * zoom }
    })
  }

  // ----- reorder / stack commits -----

  /** New queue after dropping `id` at full-lane slot `slot`; null = no-op. */
  const queueAfterDrop = (id: string, slot: number): string[] | null => {
    const without = laneIds.filter((x) => x !== id)
    const rank = laneIds.indexOf(id)
    const adj = rank >= 0 && slot > rank ? slot - 1 : slot
    const idx = Math.min(without.length, Math.max(headCount, adj))
    const nextLane = [...without.slice(0, idx), id, ...without.slice(idx)]
    const next = nextLane.filter((x) => {
      const it = byId.get(x)
      return !(it && isHead(it))
    })
    const current = queuedIds.includes(id) ? queuedIds : null
    if (current && next.length === current.length && next.every((x, i) => x === current[i])) {
      return null
    }
    return next
  }

  const droppable = (id: string): RoadmapItem | null => {
    const item = byId.get(id)
    if (!item || (item.locked && item.status === 'in_progress')) return null
    if (item.status === 'done' || item.status === 'archived') return null
    return item
  }

  /**
   * `joinAnchorId` (from shared/workflow.ts SlotHit.join, resolved to a wave
   * member via joinAnchorAt) ties `id` into that member's existing wave instead of
   * giving it its own. Null when the drop lands in a gap (new wave) --
   * that is also the default for every non-drag caller (commitStack's
   * degrade path), which has no join position to honor.
   */
  const commitDrop = (id: string, slot: number, joinAnchorId: string | null = null): void => {
    if (!droppable(id)) return
    const next = queueAfterDrop(id, slot)
    if (!next) return
    // Enqueue id's unmet, unqueued dependencies alongside it -- in the same
    // reorder commit, spliced dependency-first right before id's own slot
    // (AUDIT-graph-view-2026-07-28.md §7). Covers both entry points that
    // funnel through commitDrop: the kanban-to-lane drop and lane-internal
    // reorders.
    const closure = enqueueClosure(items, id)
    const idx = next.indexOf(id)
    const withClosure =
      closure.length === 0
        ? next
        : idx === -1
          ? [...closure, ...next]
          : [...next.slice(0, idx), ...closure, ...next.slice(idx)]

    // Wave grouping: start from the existing ties among the items that are
    // NOT moving (everything but id and its closure -- their relative order
    // is unaffected by this drop), then splice id (+closure) in. A closure
    // splice always lands as singleton waves even when join was requested --
    // joining an existing wave while also inserting brand-new prerequisite
    // cards immediately before id would either break that wave's required
    // contiguity (validateReorderWaves) or silently drop the join; v1 keeps
    // the two mutually exclusive (card 42edc88b phase 2, dev2 design note,
    // mirrors the team-lead's conservative call on the non-lane insertion
    // paths in shared/workflow.ts's insertSoloWaves).
    const rest = queuedItems(items).filter((i) => i.id !== id && !closure.includes(i.id))
    const baseWaves = wavesOf(rest)
    const at = withClosure.findIndex((x) => x === id || closure.includes(x))
    const anchorWave =
      closure.length === 0 && joinAnchorId
        ? baseWaves.findIndex((w) => w.includes(joinAnchorId))
        : -1
    const waves =
      anchorWave === -1
        ? insertSoloWaves(baseWaves, at, [...closure, id])
        : (() => {
            const waveStart = baseWaves.slice(0, anchorWave).reduce((n, w) => n + w.length, 0)
            const merged =
              at <= waveStart
                ? [id, ...baseWaves[anchorWave]!]
                : [...baseWaves[anchorWave]!, id]
            return [...baseWaves.slice(0, anchorWave), merged, ...baseWaves.slice(anchorWave + 1)]
          })()
    onReorder(withClosure, waves)
  }

  /** Parallel-sibling drop: `id` adopts the target's dependencies. */
  const commitStack = (id: string, targetId: string): void => {
    const item = droppable(id)
    if (!item) return
    const deps = siblingDeps(items, id, targetId)
    if (!deps) {
      // Target has no dependencies to share, so there is nothing to stack
      // against -- degrade to a plain insertion right after the target
      // instead of refusing the gesture, mirroring where the sibling path
      // lands a newly-queued card (RoadmapView.stackItem inserts at `at + 1`).
      const targetSlot = laneIds.indexOf(targetId)
      if (targetSlot >= 0) {
        commitDrop(id, targetSlot + 1)
      } else {
        // targetId always comes from stackTargetAt(lane, ...), so this
        // should be unreachable; trace it instead of dropping the gesture
        // silently if that invariant ever breaks.
        window.api.reportError('roadmap', `commitStack: target ${targetId} not in lane`)
      }
      return
    }
    const same =
      deps.length === item.depends_on.length && deps.every((d) => item.depends_on.includes(d))
    if (!same || !queuedIds.includes(id)) onStack(id, targetId, deps)
  }

  // ----- mouse interactions (GraphView pattern) -----

  const onCanvasMouseDown = (e: React.MouseEvent): void => {
    setEdgeInfo(null)
    drag.current = {
      kind: 'pan',
      startX: e.clientX,
      startY: e.clientY,
      origX: camera.x,
      origY: camera.y,
      moved: false
    }
  }

  const onNodeMouseDown = (e: React.MouseEvent, item: RoadmapItem): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    setEdgeInfo(null)
    const locked = item.locked && item.status === 'in_progress'
    if (locked) return // work-locked: not movable (K2)
    const p = pos.get(item.id)!
    drag.current = {
      kind: 'node',
      id: item.id,
      startX: e.clientX,
      startY: e.clientY,
      origX: p.x,
      origY: p.y,
      moved: false
    }
  }

  const onPortMouseDown = (e: React.MouseEvent, item: RoadmapItem): void => {
    e.stopPropagation()
    setEdgeInfo(null)
    const p = pos.get(item.id)!
    drag.current = {
      kind: 'link',
      id: item.id,
      startX: e.clientX,
      startY: e.clientY,
      origX: p.x + WF_NODE_W,
      origY: p.y + WF_NODE_H / 2,
      moved: false
    }
    setLink({ fromId: item.id, x: p.x + WF_NODE_W, y: p.y + WF_NODE_H / 2 })
  }

  const onMouseMove = (e: React.MouseEvent): void => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
    if (d.kind === 'pan') {
      autoFrame.current = autoFrame.current && !d.moved
      setCamera((c) => ({ ...c, x: d.origX + dx, y: d.origY + dy }))
    } else if (d.kind === 'node' && d.id) {
      const gx = d.origX + dx / camera.zoom
      const gy = d.origY + dy / camera.zoom
      setGhost({ id: d.id, x: gx, y: gy })
      const cx = gx + WF_NODE_W / 2
      const cy = gy + WF_NODE_H / 2
      // Dependency-related cards can never be parallel: no stack slot there,
      // the card slides sideways and the wronged links/borders turn red.
      const hit0 = stackTargetAt(lane, pos, cx, cy, d.id)
      const hit = hit0 && !dependsRelated(items, d.id, hit0.targetId) ? hit0 : null
      setStack(hit)
      if (hit) {
        setCaret(null)
        setConflicts([])
      } else {
        const { index: slot, join } = insertSlotAt(lane, pos, cx)
        setCaret({ slot, x: caretXAt(lane, pos, cx) })
        const dragItem = byId.get(d.id)
        setConflicts(dragItem ? slotConflicts(lane, dragItem, slot, join) : [])
      }
    } else if (d.kind === 'link' && d.id) {
      const w = toWorld(e.clientX, e.clientY)
      setLink({ fromId: d.id, x: w.x, y: w.y })
    }
  }

  const endDrag = (): (typeof drag)['current'] => {
    const d = drag.current
    if (d?.moved) suppressClick.current = true
    drag.current = null
    setGhost(null)
    setCaret(null)
    setStack(null)
    setConflicts([])
    setLink(null)
    return d
  }

  const onCanvasMouseUp = (e: React.MouseEvent): void => {
    const d = endDrag()
    if (!d || !d.moved) return
    if (d.kind === 'node' && d.id) {
      const cx = d.origX + (e.clientX - d.startX) / camera.zoom + WF_NODE_W / 2
      const cy = d.origY + (e.clientY - d.startY) / camera.zoom + WF_NODE_H / 2
      const hit0 = stackTargetAt(lane, pos, cx, cy, d.id)
      const hit = hit0 && !dependsRelated(items, d.id, hit0.targetId) ? hit0 : null
      if (hit) commitStack(d.id, hit.targetId)
      else {
        const { index, join } = insertSlotAt(lane, pos, cx)
        commitDrop(d.id, index, join ? joinAnchorAt(lane, pos, cx) : null)
      }
    } else if (d.kind === 'link' && d.id) {
      // Released over empty canvas: create a new item depending on the source,
      // inserted where the cursor points. Cancelling the form creates nothing.
      const w = toWorld(e.clientX, e.clientY)
      const slot = Math.max(headCount, insertSlotAt(lane, pos, w.x).index)
      onCreateAt(slot - headCount, [d.id])
    }
  }

  const onNodeMouseUp = (e: React.MouseEvent, item: RoadmapItem): void => {
    const d = drag.current
    if (!d || d.kind !== 'link' || !d.id) return
    e.stopPropagation()
    endDrag()
    if (d.id === item.id) return
    // Direction: the flow goes left to right, so the drop target DEPENDS ON
    // the drag source (the source must be done first).
    if (item.depends_on.includes(d.id)) return
    if (dependsWouldCycle(items, item.id, d.id)) {
      showToast('graph.cycleRefused', 'info')
      return
    }
    onAddDep(item.id, d.id)
  }

  const onNodeClick = (e: React.MouseEvent, item: RoadmapItem): void => {
    e.stopPropagation()
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }
    onOpen(item.id)
  }

  // ----- HTML5 drop target (cards dragged from the kanban) -----

  const onDragOver = (e: React.DragEvent): void => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const w = toWorld(e.clientX, e.clientY)
    // The dragged id is unreadable during dragover (DnD protocol), so the
    // stack preview cannot exclude the card itself — the drop recomputes.
    const hit = stackTargetAt(lane, pos, w.x, w.y)
    setStack(hit)
    setCaret(hit ? null : { slot: insertSlotAt(lane, pos, w.x).index, x: caretXAt(lane, pos, w.x) })
  }

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setCaret(null)
    setStack(null)
    const id = e.dataTransfer.getData('text/plain')
    if (!id) return
    const w = toWorld(e.clientX, e.clientY)
    const hit0 = stackTargetAt(lane, pos, w.x, w.y, id)
    const hit = hit0 && !dependsRelated(items, id, hit0.targetId) ? hit0 : null
    if (hit) commitStack(id, hit.targetId)
    else {
      const { index, join } = insertSlotAt(lane, pos, w.x)
      commitDrop(id, index, join ? joinAnchorAt(lane, pos, w.x) : null)
    }
  }

  // ----- scrollbar (visible when the chain overflows at the zoom floor) -----

  const el = canvasRef.current
  const b = bbox()
  const contentW = b ? (b.maxX - b.minX + 2 * FIT_PAD) * camera.zoom : 0
  const viewW = el?.clientWidth ?? 0
  const overflow = showCanvas && b !== null && contentW > viewW + 1
  // camera.x bounds: content left at FIT_PAD (max) .. right edge flush (min).
  const camMax = b ? FIT_PAD - b.minX * camera.zoom : 0
  const camMin = b ? viewW - FIT_PAD - b.maxX * camera.zoom : 0
  const scrollFrac = overflow ? Math.min(1, Math.max(0, (camMax - camera.x) / (camMax - camMin))) : 0
  const thumbFrac = overflow ? Math.max(0.08, viewW / contentW) : 1

  const onThumbPointerDown = (e: React.PointerEvent): void => {
    e.stopPropagation()
    autoFrame.current = false
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const trackW = viewW * (1 - thumbFrac)
    scrollDrag.current = {
      startX: e.clientX,
      camX: camera.x,
      ratio: trackW > 0 ? (camMax - camMin) / trackW : 0
    }
  }
  const onThumbPointerMove = (e: React.PointerEvent): void => {
    const s = scrollDrag.current
    if (!s) return
    const next = s.camX - (e.clientX - s.startX) * s.ratio
    setCamera((c) => ({ ...c, x: Math.min(camMax, Math.max(camMin, next)) }))
  }
  const onThumbPointerUp = (): void => {
    scrollDrag.current = null
  }

  // Top-edge handle: dragging it down shrinks the canvas, up grows it.
  const onResizePointerDown = (e: React.PointerEvent): void => {
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    resizeDrag.current = { startY: e.clientY, startH: laneHeight }
  }
  const onResizePointerMove = (e: React.PointerEvent): void => {
    const s = resizeDrag.current
    if (!s) return
    setLaneHeight(clampLaneHeight(s.startH - (e.clientY - s.startY), window.innerHeight))
  }
  const onResizePointerUp = (): void => {
    if (!resizeDrag.current) return
    resizeDrag.current = null
    void updateConfig({ wfLaneHeight: laneHeight })
  }

  // ----- rendering -----

  const conflictSet = new Set(conflicts)
  /** Edge anchor: the dragged card's edges follow its ghost, live. */
  const nodeXY = (id: string): { x: number; y: number } =>
    ghost && ghost.id === id ? { x: ghost.x, y: ghost.y } : pos.get(id)!

  const edgeTitle = (from: string, to: string, violated: boolean): string =>
    violated
      ? t('roadmap.wf.violationOrder', {
          item: byId.get(to)?.title ?? to,
          dep: byId.get(from)?.title ?? from
        })
      : t('roadmap.wf.depLabel', {
          item: byId.get(to)?.title ?? to,
          dep: byId.get(from)?.title ?? from
        })

  return (
    <section
      className={`wf-lane${collapsed && !fullscreen ? ' is-collapsed' : ''}${fullscreen ? ' is-full' : ''}`}
    >
      <h3 className="rm-section-head wf-head">
        {GLYPH_BADGES.clepsydra} {t('roadmap.wf.title')}
        <span className="rm-count">{lane.length}</span>
        <span className="roadmap-spacer" />
        <button
          className="btn btn-sm"
          disabled={queuedIds.length === 0}
          title={t('roadmap.wf.clearQueue')}
          onClick={() => setConfirmClear(true)}
        >
          {GLYPH_ACTIONS.erase} {t('roadmap.wf.clearQueue')}
        </button>
        <button
          className="primary rm-dispatch-btn"
          disabled={!hasLead || queuedIds.length === 0}
          title={hasLead ? undefined : t('roadmap.dispatchNoLeadHint')}
          onClick={onDispatch}
        >
          {GLYPH_ACTIONS.forward} {t('roadmap.dispatchFirst')}
        </button>
        <button
          className="icon-btn"
          title={fullscreen ? t('roadmap.wf.exitFullscreen') : t('roadmap.wf.fullscreen')}
          onClick={onToggleFull}
        >
          {fullscreen ? GLYPH_ACTIONS.close : GLYPH_ACTIONS.expand}
        </button>
        {!fullscreen && (
          <button
            className="icon-btn"
            title={collapsed ? t('roadmap.wf.expand') : t('roadmap.wf.collapse')}
            onClick={() => setCollapsed((v) => !v)}
          >
            {collapsed ? GLYPH_ACTIONS.plus : GLYPH_ACTIONS.minus}
          </button>
        )}
      </h3>

      {showCanvas && !fullscreen && (
        <div
          className="wf-resize"
          title={t('roadmap.wf.resizeTitle')}
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerUp}
        />
      )}

      {showCanvas && (
        <div
          ref={canvasRef}
          className={`wf-canvas${link ? ' is-linking' : ''}`}
          style={{
            ...(fullscreen ? {} : { height: laneHeight }),
            backgroundSize: `${26 * camera.zoom}px ${26 * camera.zoom}px`,
            backgroundPosition: `${camera.x}px ${camera.y}px`
          }}
          onMouseDown={onCanvasMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onCanvasMouseUp}
          onMouseLeave={() => endDrag()}
          onWheel={onWheel}
          onDragOver={onDragOver}
          onDragLeave={() => {
            setCaret(null)
            setStack(null)
          }}
          onDrop={onDrop}
          onContextMenu={(e) => {
            e.preventDefault()
            const w = toWorld(e.clientX, e.clientY)
            const slot = Math.max(headCount, insertSlotAt(lane, pos, w.x).index)
            setCanvasMenu({ x: e.clientX, y: e.clientY, slot: slot - headCount })
          }}
        >
          <div
            className="wf-world"
            style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}
          >
            <svg className="wf-edges">
              {edges.map((edge) => {
                const from = nodeXY(edge.from)
                const to = nodeXY(edge.to)
                const x1 = from.x + WF_NODE_W
                const y1 = from.y + WF_NODE_H / 2
                const x2 = to.x
                const y2 = to.y + WF_NODE_H / 2
                const mx = (x1 + x2) / 2
                const d = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`
                const key = `${edge.from}-${edge.to}`
                // Live preview: a link the hovered insertion would wrong-side
                // turns red while the drag is still in flight.
                const liveViolated =
                  ghost !== null &&
                  ((edge.to === ghost.id && conflictSet.has(edge.from)) ||
                    (edge.from === ghost.id && conflictSet.has(edge.to)))
                return (
                  <g key={key}>
                    <path
                      d={d}
                      className={`wf-edge${edge.violated || liveViolated ? ' is-violated' : ''}`}
                    />
                    <path
                      d={d}
                      className="wf-edge-hit"
                      onClick={(e) => {
                        e.stopPropagation()
                        const rect = canvasRef.current!.getBoundingClientRect()
                        setEdgeInfo({
                          ...edge,
                          x: e.clientX - rect.left,
                          y: e.clientY - rect.top
                        })
                      }}
                    >
                      <title>{edgeTitle(edge.from, edge.to, edge.violated)}</title>
                    </path>
                  </g>
                )
              })}
              {link && (
                <path
                  className="wf-edge is-ghost"
                  d={(() => {
                    const from = pos.get(link.fromId)!
                    const x1 = from.x + WF_NODE_W
                    const y1 = from.y + WF_NODE_H / 2
                    const mx = (x1 + link.x) / 2
                    return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${link.y}, ${link.x} ${link.y}`
                  })()}
                />
              )}
            </svg>

            {caret !== null && (
              <div
                className="wf-caret"
                style={{
                  left: caret.x,
                  top: (b?.minY ?? 0) - 12,
                  height: b ? b.maxY - b.minY + 24 : WF_NODE_H + 24
                }}
              />
            )}

            {stack !== null && (
              <div
                className="wf-stack-slot"
                style={{ left: stack.x, top: stack.y, width: WF_NODE_W, height: WF_NODE_H }}
              />
            )}

            {lane.map((item) => {
              const p = pos.get(item.id)!
              const dragged = ghost?.id === item.id
              const x = dragged ? ghost.x : p.x
              const y = dragged ? ghost.y : p.y
              const locked = item.locked && item.status === 'in_progress'
              const unmet = unmetDeps(item, items, shownIds)
              const directive = item.kind === 'directive'
              return (
                <div
                  key={item.id}
                  className={[
                    'wf-node',
                    locked ? 'is-locked' : '',
                    directive ? 'is-directive' : '',
                    dragged ? 'is-dragging' : '',
                    conflictSet.has(item.id) || (dragged && conflicts.length > 0)
                      ? 'is-conflict'
                      : ''
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{ left: x, top: y, width: WF_NODE_W, height: WF_NODE_H }}
                  onMouseDown={(e) => onNodeMouseDown(e, item)}
                  onMouseUp={(e) => onNodeMouseUp(e, item)}
                  onClick={(e) => onNodeClick(e, item)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onMenu(item, e.clientX, e.clientY)
                  }}
                  title={locked ? t('roadmap.lockedHint') : undefined}
                >
                  <div className="wf-node-head">
                    {!directive && (
                      <span className={`rm-prio-chip rm-prio-${item.priority}`}>
                        <span className="rm-prio-dot" />
                      </span>
                    )}
                    <span className="rm-kind">{KIND_ICONS[item.kind]}</span>
                    <span className="wf-node-title">{item.title}</span>
                  </div>
                  <div className="wf-node-badges">
                    {directive ? (
                      <>
                        <span className="rm-badge rm-badge-directive">
                          {t(`roadmap.directive.${item.directive ?? 'clear'}`)}
                        </span>
                        <span className="rm-badge rm-badge-queue">
                          {GLYPH_BADGES.profile} {item.target_peer_ids.length}
                        </span>
                      </>
                    ) : locked ? (
                      <span className="rm-badge rm-badge-locked">
                        {GLYPH_BADGES.lock} {item.locked_by}
                      </span>
                    ) : (
                      <span className="rm-badge rm-badge-queue">#{p.rank + 1}</span>
                    )}
                    {unmet.length > 0 && (
                      <span
                        className="rm-badge wf-badge-warn"
                        title={t('roadmap.wf.violationMissing', {
                          list: unmet.map((d) => d.title).join(', ')
                        })}
                      >
                        {GLYPH_BADGES.warning}
                      </span>
                    )}
                  </div>
                  {!locked && (
                    <span
                      className="wf-port"
                      title={t('roadmap.wf.linkHint')}
                      onMouseDown={(e) => onPortMouseDown(e, item)}
                    />
                  )}
                </div>
              )
            })}
          </div>

          {lane.length === 0 && <p className="wf-empty">{t('roadmap.wf.hint')}</p>}
          {link && <div className="wf-link-hint">{t('roadmap.wf.linkHint')}</div>}

          <div
            className="wf-zoomctl"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <button className="icon-btn" title={t('graph.zoomIn')} onClick={() => zoomBy(1.2)}>
              {GLYPH_ACTIONS.plus}
            </button>
            <button className="icon-btn" title={t('graph.zoomOut')} onClick={() => zoomBy(1 / 1.2)}>
              {GLYPH_ACTIONS.minus}
            </button>
            <button
              className="icon-btn"
              title={t('graph.fitView')}
              onClick={() => {
                autoFrame.current = true
                frame()
              }}
            >
              {GLYPH_ACTIONS.fit}
            </button>
            <span className="wf-zoom-label">{Math.round(camera.zoom * 100)}%</span>
          </div>

          {edgeInfo && (
            <div
              className="wf-edge-panel"
              style={{
                left: Math.min(edgeInfo.x, (el?.clientWidth ?? 300) - 280),
                top: Math.min(edgeInfo.y, (el?.clientHeight ?? 200) - 90)
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <p className={`wf-edge-text${edgeInfo.violated ? ' is-violated' : ''}`}>
                {edgeInfo.violated && GLYPH_BADGES.warning}{' '}
                {edgeTitle(edgeInfo.from, edgeInfo.to, edgeInfo.violated)}
              </p>
              <div className="wf-edge-actions">
                <button
                  className="btn btn-sm danger"
                  onClick={() => {
                    onRemoveDep(edgeInfo.to, edgeInfo.from)
                    setEdgeInfo(null)
                  }}
                >
                  {t('roadmap.wf.removeDep')}
                </button>
                <button className="btn btn-sm" onClick={() => setEdgeInfo(null)}>
                  {t('common.close')}
                </button>
              </div>
            </div>
          )}

          {overflow && (
            <div className="wf-scrollbar">
              <div
                className="wf-scrollbar-thumb"
                style={{
                  width: `${thumbFrac * 100}%`,
                  left: `${scrollFrac * (1 - thumbFrac) * 100}%`
                }}
                onPointerDown={onThumbPointerDown}
                onPointerMove={onThumbPointerMove}
                onPointerUp={onThumbPointerUp}
              />
            </div>
          )}
        </div>
      )}

      {canvasMenu && (
        <ContextMenu
          x={canvasMenu.x}
          y={canvasMenu.y}
          items={[
            {
              label: t('roadmap.wf.createHere'),
              onSelect: () => onCreateAt(canvasMenu.slot, [])
            }
          ]}
          onClose={() => setCanvasMenu(null)}
        />
      )}

      {confirmClear && (
        <ConfirmDialog
          title={t('roadmap.wf.clearQueueTitle')}
          message={t('roadmap.wf.clearQueueMessage')}
          confirmLabel={t('roadmap.wf.clearQueueConfirm')}
          tone="neutral"
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => {
            setConfirmClear(false)
            onReorder([])
          }}
        />
      )}
    </section>
  )
}
