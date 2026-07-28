import { useCallback, useEffect, useRef, useState } from 'react'
import type { GraphCli, GraphDoc, GraphNode, ModelTarget } from '@shared/graph'
import {
  childrenOf,
  clampNodeSize,
  findFreeSpot,
  graphId,
  graphNodeKind,
  GRAPH_GRID,
  GRAPH_NODE_H,
  GRAPH_NODE_W,
  GRAPH_PITCH_Y,
  layoutGraph,
  nodeH,
  nodeW,
  outlineOrder,
  snapToGrid,
  wouldCreateCycle
} from '@shared/graph'
import type { ProviderCatalog } from '@shared/models'
import { useT } from '../i18n'
import { GLYPH_ACTIONS, GLYPH_BADGES } from './icons'
import { useDeck } from '../store'
import { ConfirmDialog } from './ConfirmDialog'
import { ModelPicker } from './ModelPicker'

// Graph chat view (EXPLORATION-graph-chat C26): a canvas where every exchange
// is a node — branch a "what if" anywhere, cross N nodes into a fresh prompt
// node, fan a prompt out to several CLIs, and (C27) let a judge node merge a
// battle. Rendering is dependency-free on purpose (SVG edges + positioned
// divs, manual layout like the demo): consistent with the rest of the app.
// Placement lives on a shared grid (GRAPH_GRID): drag snaps, automatic
// placements respect the hierarchy, and layoutGraph re-tidies on demand.

const NODE_W = GRAPH_NODE_W
const NODE_H = GRAPH_NODE_H
const ZOOM_MIN = 0.25
const ZOOM_MAX = 2
/** Timeline outline: chars kept per row before the ellipsis. */
const OUTLINE_CHARS = 46

// A resized card carries its own w/h (a0f2e983); an untouched one still
// falls back to the fixed constants. nodeW/nodeH now live in shared/graph.ts
// (single choke point, also used by findFreeSpot's overlap test) --
// re-exported here under the same names so every existing call site is
// unchanged.

// Provider sigils stay typographic characters (abstract, monochrome — already
// in the glyph tone, and they also live inside string labels).
const CLI_ICONS: Record<GraphCli, string> = {
  claude: '✴',
  codex: '◆',
  gemini: '✦',
  antigravity: '△',
  local: '⌂'
}

/** Default fan-out selection before the operator picks anything. */
const DEFAULT_TARGET_KEY = 'anthropic:sonnet'
const DEFAULT_TARGETS: Record<string, ModelTarget> = {
  [DEFAULT_TARGET_KEY]: { cli: 'claude', model: 'sonnet' }
}
/** Default battle judge (mirrors graph-engine's DEFAULT_JUDGE). */
const DEFAULT_JUDGE_KEY = DEFAULT_TARGET_KEY
const DEFAULT_JUDGE_TARGET: ModelTarget = { cli: 'claude', model: 'sonnet' }

type Camera = { x: number; y: number; zoom: number }

function nodeIcon(node: GraphNode): React.ReactNode {
  if (node.type === 'user') return GLYPH_BADGES.profile
  if (node.type === 'judge') return GLYPH_BADGES.scales
  return CLI_ICONS[node.cli ?? 'claude'] ?? '◇'
}

function nodeTitle(node: GraphNode, t: (k: string) => string): string {
  if (node.type === 'user') return t('graph.nodeUser')
  const model = node.model ? `/${node.model}` : ''
  return `${node.cli ?? '?'}${model}`
}

export function GraphView(): React.JSX.Element {
  const t = useT()
  const [graphs, setGraphs] = useState<GraphDoc[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [selection, setSelection] = useState<string[]>([])
  const [camera, setCamera] = useState<Camera>({ x: 60, y: 40, zoom: 1 })
  const [draftText, setDraftText] = useState('')
  const [connectMode, setConnectMode] = useState(false)
  const [running, setRunning] = useState<string | null>(null) // nodeId being inferred
  const [inspector, setInspector] = useState<{ system: string; prompt: string } | null>(null)
  const [confirmDeleteGraph, setConfirmDeleteGraph] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // Fan-out selection (C29): favorite-style keys -> ModelTarget, driven by the
  // unified ModelPicker (providers gated on CLI detection, locals discovered).
  const [catalogs, setCatalogs] = useState<ProviderCatalog[]>([])
  const [targetKeys, setTargetKeys] = useState<string[]>([DEFAULT_TARGET_KEY])
  const [targetMap, setTargetMap] = useState<Record<string, ModelTarget>>(DEFAULT_TARGETS)
  const [battle, setBattle] = useState(false)
  // Judge target (C27, multi-provider since lot A): one catalog model.
  const [judgeKey, setJudgeKey] = useState(DEFAULT_JUDGE_KEY)
  const [judgeTarget, setJudgeTarget] = useState<ModelTarget>(DEFAULT_JUDGE_TARGET)
  const [showTimeline, setShowTimeline] = useState(false)

  const canvasRef = useRef<HTMLDivElement>(null)
  // Single state machine for every canvas drag: panning the camera, moving a
  // node, resizing a node (a0f2e983) and drawing a wire to connect two nodes
  // (cdbf310c). origW/origH are only used by 'resize'.
  const drag = useRef<{
    kind: 'pan' | 'node' | 'resize' | 'wire'
    id?: string
    startX: number
    startY: number
    origX: number
    origY: number
    origW?: number
    origH?: number
    moved: boolean
  } | null>(null)
  // Live endpoint of an in-progress wire drag, in world (graph) coordinates —
  // drives the preview path only; the persisted link is created on drop.
  const [wireDrag, setWireDrag] = useState<{ from: string; x: number; y: number } | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Set by addNode(parents, at) right after it selects the freshly created
  // node; consumed by the effect below once the right-panel textarea for
  // that node has actually mounted, so the operator can type immediately
  // (cdbf310c review: "select + focus", not just select).
  const focusDraftPending = useRef(false)
  const draftRef = useRef<HTMLTextAreaElement>(null)

  const doc = graphs.find((g) => g.id === activeId) ?? null
  const selectedNodes = doc ? selection.map((id) => doc.nodes.find((n) => n.id === id)).filter((n): n is GraphNode => !!n) : []
  const single = selectedNodes.length === 1 ? selectedNodes[0] : null

  const refresh = useCallback(async () => {
    try {
      const list = await window.api.graphList()
      setGraphs(list)
      setActiveId((cur) => (cur && list.some((g) => g.id === cur) ? cur : (list[0]?.id ?? null)))
    } catch (e) {
      window.api.reportError('graph', `list failed: ${String(e)}`)
    }
  }, [])

  useEffect(() => {
    void refresh()
    void window.api.modelCatalogs().then(setCatalogs)
  }, [refresh])

  // Navigation request from outside (an opened graph draft): re-list so the
  // freshly created doc is present, then activate it and select its
  // pre-filled node. Two effects because the list update is asynchronous.
  const graphFocus = useDeck((s) => s.graphFocus)
  const clearGraphFocus = useDeck((s) => s.clearGraphFocus)
  useEffect(() => {
    if (graphFocus) void refresh()
  }, [graphFocus, refresh])
  useEffect(() => {
    if (!graphFocus) return
    const target = graphs.find((g) => g.id === graphFocus.docId)
    if (!target) return // list not refreshed yet; next graphs update retries
    setActiveId(target.id)
    const node = target.nodes.find((n) => n.id === graphFocus.nodeId)
    setSelection(node ? [node.id] : [])
    if (node?.type === 'user') setDraftText(node.text)
    setCamera({ x: 60, y: 40, zoom: 1 })
    clearGraphFocus()
  }, [graphFocus, graphs, clearGraphFocus])

  useEffect(() => {
    if (!notice) return
    const id = setTimeout(() => setNotice(null), 2500)
    return () => clearTimeout(id)
  }, [notice])

  // Consume the "focus the draft textarea" request set by addNode(parents,
  // at) once the newly selected node's panel has actually re-rendered.
  useEffect(() => {
    if (focusDraftPending.current && single) {
      focusDraftPending.current = false
      draftRef.current?.focus()
    }
  }, [single])

  /** Replace the active doc in local state and persist it (optionally debounced). */
  const mutateDoc = useCallback(
    (next: GraphDoc, debounce = false): void => {
      setGraphs((gs) => gs.map((g) => (g.id === next.id ? next : g)))
      if (saveTimer.current) clearTimeout(saveTimer.current)
      // A rejected save is silent data loss (O6): surface it in the in-view
      // notice + main.log instead of an unhandled rejection.
      const persist = (): void => {
        window.api.graphSave(next).catch((e) => {
          window.api.reportError('graph', `save failed: ${String(e)}`)
          setNotice(t('graph.saveFailed'))
        })
      }
      if (debounce) {
        saveTimer.current = setTimeout(persist, 400)
      } else {
        persist()
      }
    },
    [t]
  )

  // ----- graph CRUD -----

  const createGraph = async (): Promise<void> => {
    try {
      const created = await window.api.graphCreate(t('graph.defaultName'))
      await refresh()
      setActiveId(created.id)
      setSelection([])
    } catch (e) {
      window.api.reportError('graph', `create failed: ${String(e)}`)
      setNotice(t('graph.saveFailed'))
    }
  }

  const renameGraph = (g: GraphDoc, name: string): void => {
    mutateDoc({ ...g, name }, true)
  }

  const deleteGraphConfirmed = async (): Promise<void> => {
    if (!confirmDeleteGraph) return
    try {
      await window.api.graphDelete(confirmDeleteGraph)
    } catch (e) {
      window.api.reportError('graph', `delete failed: ${String(e)}`)
      setNotice(t('graph.saveFailed'))
    }
    setConfirmDeleteGraph(null)
    setSelection([])
    await refresh()
  }

  // ----- node operations -----

  const viewportCenter = (): { x: number; y: number } => {
    const el = canvasRef.current
    const w = el?.clientWidth ?? 800
    const h = el?.clientHeight ?? 600
    return {
      x: (w / 2 - camera.x) / camera.zoom - NODE_W / 2,
      y: (h / 2 - camera.y) / camera.zoom - NODE_H / 2
    }
  }

  /**
   * `at`, when given, is an explicit world-coordinate placement that
   * short-circuits the hierarchy-based one below -- used by the wire-drag
   * drop-on-empty-canvas flow (cdbf310c review) where the new node belongs
   * right under the cursor, not centered under its parent. It still goes
   * through findFreeSpot so it never lands on top of an existing card.
   */
  const addNode = (parents: string[], at?: { x: number; y: number }): void => {
    if (!doc) return
    // Hierarchy-aware placement: one parent -> the row right below it (a
    // reply/what-if hangs under its parent); several parents (a cross) ->
    // centered under them; no parent -> viewport center. findFreeSpot snaps
    // to the grid and slides right along the row if the slot is taken.
    const parentNodes = parents
      .map((id) => doc.nodes.find((n) => n.id === id))
      .filter((n): n is GraphNode => !!n)
    const want =
      at ??
      (parentNodes.length > 0
        ? {
            x: parentNodes.reduce((s, p) => s + p.x, 0) / parentNodes.length,
            y: Math.max(...parentNodes.map((p) => p.y)) + GRAPH_PITCH_Y
          }
        : viewportCenter())
    const pos = findFreeSpot(doc.nodes, want.x, want.y)
    const node: GraphNode = {
      id: graphId(),
      type: 'user',
      parents,
      text: '',
      x: pos.x,
      y: pos.y,
      createdAt: Date.now()
    }
    mutateDoc({ ...doc, nodes: [...doc.nodes, node] })
    setSelection([node.id])
    setDraftText('')
    if (at) focusDraftPending.current = true
  }

  const updateNodeText = (id: string, text: string): void => {
    if (!doc) return
    setDraftText(text)
    mutateDoc(
      { ...doc, nodes: doc.nodes.map((n) => (n.id === id ? { ...n, text } : n)) },
      true
    )
  }

  const deleteNode = (id: string): void => {
    if (!doc) return
    if (childrenOf(doc.nodes, id).length > 0) {
      setNotice(t('graph.leafOnly'))
      return
    }
    mutateDoc({ ...doc, nodes: doc.nodes.filter((n) => n.id !== id) })
    setSelection((s) => s.filter((x) => x !== id))
  }

  const connectParent = (childId: string, parentId: string): void => {
    if (!doc) return
    const child = doc.nodes.find((n) => n.id === childId)
    if (!child || child.parents.includes(parentId)) return
    if (wouldCreateCycle(doc.nodes, childId, parentId)) {
      setNotice(t('graph.cycleRefused'))
      return
    }
    mutateDoc({
      ...doc,
      nodes: doc.nodes.map((n) =>
        n.id === childId ? { ...n, parents: [...n.parents, parentId] } : n
      )
    })
  }

  // ----- inference (C25/C27) -----

  const activeTargets = (): ModelTarget[] =>
    targetKeys.map((k) => targetMap[k]).filter((x): x is ModelTarget => !!x)

  /** Picker click: toggle the model in the fan-out selection. */
  const toggleTarget = (key: string, target: ModelTarget): void => {
    setTargetMap((m) => ({ ...m, [key]: target }))
    setTargetKeys((ks) => (ks.includes(key) ? ks.filter((k) => k !== key) : [...ks, key]))
  }

  const infer = async (): Promise<void> => {
    if (!doc || !single || single.type !== 'user' || running) return
    const list = activeTargets()
    if (list.length === 0 || !single.text.trim()) return
    setRunning(single.id)
    try {
      const updated = await window.api.graphInfer(doc.id, {
        nodeId: single.id,
        targets: list,
        battle: battle && list.length >= 2,
        judge: judgeTarget
      })
      setGraphs((gs) => gs.map((g) => (g.id === updated.id ? updated : g)))
    } catch (err) {
      setNotice(String(err instanceof Error ? err.message : err).slice(0, 200))
    } finally {
      setRunning(null)
    }
  }

  const inspect = async (): Promise<void> => {
    if (!doc || !single) return
    try {
      setInspector(await window.api.graphCompile(doc.id, single.id))
    } catch (err) {
      setNotice(String(err instanceof Error ? err.message : err).slice(0, 200))
    }
  }

  // ----- canvas interactions -----

  const onNodeMouseDown = (e: React.MouseEvent, node: GraphNode): void => {
    e.stopPropagation()
    drag.current = {
      kind: 'node',
      id: node.id,
      startX: e.clientX,
      startY: e.clientY,
      origX: node.x,
      origY: node.y,
      moved: false
    }
  }

  /** Bottom-right corner handle (a0f2e983): starts a size drag. */
  const onResizeMouseDown = (e: React.MouseEvent, node: GraphNode): void => {
    e.stopPropagation()
    drag.current = {
      kind: 'resize',
      id: node.id,
      startX: e.clientX,
      startY: e.clientY,
      origX: node.x,
      origY: node.y,
      origW: nodeW(node),
      origH: nodeH(node),
      moved: false
    }
  }

  /**
   * Bottom-center port (cdbf310c): starts a wire drag. The port lives on the
   * PARENT side — same anchor the edge SVG already draws from — so dropping
   * on another node makes THAT node the child (connectParent(target, this)).
   */
  const onWirePortMouseDown = (e: React.MouseEvent, node: GraphNode): void => {
    e.stopPropagation()
    drag.current = {
      kind: 'wire',
      id: node.id,
      startX: e.clientX,
      startY: e.clientY,
      origX: node.x,
      origY: node.y,
      moved: false
    }
    setWireDrag({ from: node.id, x: node.x + nodeW(node) / 2, y: node.y + nodeH(node) })
  }

  const onCanvasMouseDown = (e: React.MouseEvent): void => {
    drag.current = {
      kind: 'pan',
      startX: e.clientX,
      startY: e.clientY,
      origX: camera.x,
      origY: camera.y,
      moved: false
    }
  }

  const onMouseMove = (e: React.MouseEvent): void => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
    if (d.kind === 'pan') {
      setCamera((c) => ({ ...c, x: d.origX + dx, y: d.origY + dy }))
    } else if (d.kind === 'node' && d.id && doc) {
      const nx = snapToGrid(d.origX + dx / camera.zoom)
      const ny = snapToGrid(d.origY + dy / camera.zoom)
      mutateDoc(
        { ...doc, nodes: doc.nodes.map((n) => (n.id === d.id ? { ...n, x: nx, y: ny } : n)) },
        true
      )
    } else if (d.kind === 'resize' && d.id && doc) {
      const { w, h } = clampNodeSize(
        (d.origW ?? NODE_W) + dx / camera.zoom,
        (d.origH ?? NODE_H) + dy / camera.zoom
      )
      mutateDoc(
        { ...doc, nodes: doc.nodes.map((n) => (n.id === d.id ? { ...n, w, h } : n)) },
        true
      )
    } else if (d.kind === 'wire' && d.id) {
      const el = canvasRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      setWireDrag({
        from: d.id,
        x: (e.clientX - rect.left - camera.x) / camera.zoom,
        y: (e.clientY - rect.top - camera.y) / camera.zoom
      })
    }
  }

  const onMouseUp = (e: React.MouseEvent): void => {
    const d = drag.current
    if (d?.kind === 'wire' && d.id) {
      // Resolve the drop target from the DOM instead of tracking hover state
      // through every node: cheap (one lookup, on release only) and immune to
      // stale state if nodes re-render mid-drag.
      const dropEl = document.elementFromPoint(e.clientX, e.clientY)
      const targetId = dropEl?.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId
      if (targetId && targetId !== d.id) {
        connectParent(targetId, d.id)
      } else if (
        e.type === 'mouseup' &&
        wireDrag &&
        !dropEl?.closest('.graph-toolbar, .graph-zoomctl, .graph-timeline')
      ) {
        // Dropped on empty canvas -- not on a node, and this is a real
        // release inside the canvas (not the onMouseLeave fallback that
        // also calls this handler when the drag wanders off the canvas
        // edge): spin up a fresh child node right there, selected and
        // focused (cdbf310c review point 2). wireDrag.{x,y} already carry
        // the same world-space conversion onMouseMove used for the preview
        // line -- reuse it rather than recompute it a second way.
        addNode([d.id], { x: wireDrag.x, y: wireDrag.y })
      }
      setWireDrag(null)
    }
    drag.current = null
  }

  const onNodeClick = (e: React.MouseEvent, node: GraphNode): void => {
    e.stopPropagation()
    if (drag.current?.moved) return
    if (connectMode && single && single.id !== node.id) {
      connectParent(single.id, node.id)
      setConnectMode(false)
      return
    }
    setConnectMode(false)
    if (e.shiftKey) {
      setSelection((s) => (s.includes(node.id) ? s.filter((x) => x !== node.id) : [...s, node.id]))
    } else {
      setSelection([node.id])
      setDraftText(node.text)
    }
  }

  const onCanvasClick = (): void => {
    if (drag.current?.moved) return
    setSelection([])
    setConnectMode(false)
  }

  /** Button zoom: same math as the wheel, anchored on the viewport center. */
  const zoomBy = (factor: number): void => {
    const el = canvasRef.current
    if (!el) return
    const cx = el.clientWidth / 2
    const cy = el.clientHeight / 2
    setCamera((c) => {
      const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, c.zoom * factor))
      const gx = (cx - c.x) / c.zoom
      const gy = (cy - c.y) / c.zoom
      return { zoom, x: cx - gx * zoom, y: cy - gy * zoom }
    })
  }

  /** Fit the whole graph in the viewport (nodes override for post-arrange). */
  const fitView = (nodes?: GraphNode[]): void => {
    const el = canvasRef.current
    const list = nodes ?? doc?.nodes
    if (!el || !list || list.length === 0) return
    const pad = 60
    const minX = Math.min(...list.map((n) => n.x)) - pad
    const minY = Math.min(...list.map((n) => n.y)) - pad
    const maxX = Math.max(...list.map((n) => n.x + nodeW(n))) + pad
    const maxY = Math.max(...list.map((n) => n.y + nodeH(n))) + pad
    const zoom = Math.min(
      ZOOM_MAX,
      Math.max(ZOOM_MIN, Math.min(el.clientWidth / (maxX - minX), el.clientHeight / (maxY - minY), 1))
    )
    setCamera({
      zoom,
      x: (el.clientWidth - (minX + maxX) * zoom) / 2,
      y: (el.clientHeight - (minY + maxY) * zoom) / 2
    })
  }

  /** Re-tidy every node on the grid by hierarchy level, then re-frame. */
  const arrange = (): void => {
    if (!doc) return
    const nodes = layoutGraph(doc.nodes)
    mutateDoc({ ...doc, nodes })
    fitView(nodes)
  }

  /** Timeline click: select the node and pan the camera onto it. */
  const navigateTo = (node: GraphNode): void => {
    const el = canvasRef.current
    if (!el) return
    setSelection([node.id])
    if (node.type === 'user') setDraftText(node.text)
    setCamera((c) => ({
      ...c,
      x: el.clientWidth / 2 - (node.x + nodeW(node) / 2) * c.zoom,
      y: el.clientHeight / 2 - (node.y + nodeH(node) / 2) * c.zoom
    }))
  }

  const onWheel = (e: React.WheelEvent): void => {
    const el = canvasRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    setCamera((c) => {
      const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, c.zoom * (e.deltaY < 0 ? 1.1 : 0.9)))
      // Keep the point under the cursor fixed while zooming.
      const gx = (mx - c.x) / c.zoom
      const gy = (my - c.y) / c.zoom
      return { zoom, x: mx - gx * zoom, y: my - gy * zoom }
    })
  }

  // ----- rendering -----

  const edges: { from: GraphNode; to: GraphNode }[] = []
  if (doc) {
    const byId = new Map(doc.nodes.map((n) => [n.id, n]))
    for (const n of doc.nodes) {
      for (const pid of n.parents) {
        const p = byId.get(pid)
        if (p) edges.push({ from: p, to: n })
      }
    }
  }

  const canInfer =
    !!single && single.type === 'user' && !!single.text.trim() && activeTargets().length > 0 && !running

  return (
    <div className="graph-view">
      {/* left column: graphs of the project */}
      <aside className="graph-list">
        <div className="graph-list-head">
          <span className="graph-list-title">{t('graph.title')}</span>
          <button className="btn" onClick={() => void createGraph()}>
            {t('graph.newGraph')}
          </button>
        </div>
        {graphs.length === 0 && <div className="graph-empty">{t('graph.empty')}</div>}
        {graphs.map((g) => (
          <div
            key={g.id}
            className={`graph-list-item${g.id === activeId ? ' is-active' : ''}`}
            onClick={() => {
              setActiveId(g.id)
              setSelection([])
            }}
          >
            <input
              className="graph-name-input"
              value={g.name}
              onChange={(e) => renameGraph(g, e.target.value)}
              onClick={(e) => e.stopPropagation()}
            />
            <span className="graph-node-count">{g.nodes.length}</span>
            <button
              className="icon-btn"
              title={t('common.delete')}
              onClick={(e) => {
                e.stopPropagation()
                setConfirmDeleteGraph(g.id)
              }}
            >
              {GLYPH_ACTIONS.trash}
            </button>
          </div>
        ))}
      </aside>

      {/* canvas */}
      <div
        ref={canvasRef}
        className={`graph-canvas${connectMode ? ' is-connecting' : ''}`}
        style={{
          // Dot grid glued to the world: one dot every 2 grid steps, panned
          // and zoomed with the camera so snapping reads on screen.
          backgroundSize: `${GRAPH_GRID * 2 * camera.zoom}px ${GRAPH_GRID * 2 * camera.zoom}px`,
          backgroundPosition: `${camera.x}px ${camera.y}px`
        }}
        onMouseDown={onCanvasMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onClick={onCanvasClick}
        onWheel={onWheel}
      >
        {doc && (
          <div
            className="graph-world"
            style={{
              transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`
            }}
          >
            <svg className="graph-edges">
              {edges.map((e, i) => {
                const x1 = e.from.x + nodeW(e.from) / 2
                const y1 = e.from.y + nodeH(e.from)
                const x2 = e.to.x + nodeW(e.to) / 2
                const y2 = e.to.y
                const my = (y1 + y2) / 2
                // Same color code as the timeline bullets: a link takes the
                // kind of the node it leads to.
                return (
                  <path
                    key={i}
                    d={`M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`}
                    className={`graph-edge k-${graphNodeKind(doc.nodes, e.to)}${
                      e.to.type === 'judge' ? ' is-judge' : ''
                    }`}
                  />
                )
              })}
              {wireDrag &&
                (() => {
                  const src = doc.nodes.find((n) => n.id === wireDrag.from)
                  if (!src) return null
                  const x1 = src.x + nodeW(src) / 2
                  const y1 = src.y + nodeH(src)
                  return (
                    <path
                      className="graph-wire-preview"
                      d={`M ${x1} ${y1} L ${wireDrag.x} ${wireDrag.y}`}
                    />
                  )
                })()}
            </svg>
            {doc.nodes.map((n) => (
              <div
                key={n.id}
                data-node-id={n.id}
                className={[
                  'graph-node',
                  `is-${n.type}`,
                  `k-${graphNodeKind(doc.nodes, n)}`,
                  selection.includes(n.id) ? 'is-selected' : '',
                  n.status === 'error' ? 'is-error' : '',
                  running === n.id ? 'is-running' : ''
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{ left: n.x, top: n.y, width: nodeW(n), height: nodeH(n) }}
                onMouseDown={(e) => onNodeMouseDown(e, n)}
                onClick={(e) => onNodeClick(e, n)}
              >
                <div className="graph-node-head">
                  <span>{nodeIcon(n)}</span>
                  <span className="graph-node-title">{nodeTitle(n, t)}</span>
                  <span className="graph-node-id">{n.id.slice(0, 6)}</span>
                </div>
                <div className="graph-node-body">
                  {n.status === 'error' ? `⚠ ${n.error ?? t('graph.error')}` : n.text}
                </div>
                {running === n.id && <div className="graph-node-spinner">{t('graph.running')}</div>}
                {/* Bottom-right handle: drag to resize (a0f2e983). */}
                <div
                  className="graph-node-resize-handle"
                  title={t('graph.resize')}
                  onMouseDown={(e) => onResizeMouseDown(e, n)}
                  onClick={(e) => e.stopPropagation()}
                />
                {/* Bottom-center port: drag onto another node to link them
                    (cdbf310c) — same anchor the edge SVG draws a link from. */}
                <div
                  className="graph-node-wire-port"
                  title={t('graph.wireConnect')}
                  onMouseDown={(e) => onWirePortMouseDown(e, n)}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            ))}
          </div>
        )}
        {doc && (
          <div className="graph-toolbar">
            <button className="btn" onClick={() => addNode([])}>
              {t('graph.newRoot')}
            </button>
            <span className="graph-zoom">{Math.round(camera.zoom * 100)}%</span>
          </div>
        )}
        {doc && (
          <div
            className="graph-zoomctl"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <button className="icon-btn" title={t('graph.zoomIn')} onClick={() => zoomBy(1.2)}>
              {GLYPH_ACTIONS.plus}
            </button>
            <button className="icon-btn" title={t('graph.zoomOut')} onClick={() => zoomBy(1 / 1.2)}>
              {GLYPH_ACTIONS.minus}
            </button>
            <button className="icon-btn" title={t('graph.fitView')} onClick={() => fitView()}>
              {GLYPH_ACTIONS.fit}
            </button>
            <span className="graph-zoomctl-sep" />
            <button className="icon-btn" title={t('graph.arrange')} onClick={arrange}>
              {GLYPH_ACTIONS.grid}
            </button>
            <button
              className={`icon-btn${showTimeline ? ' is-active' : ''}`}
              title={t('graph.timeline')}
              onClick={() => setShowTimeline((v) => !v)}
            >
              {GLYPH_ACTIONS.menu}
            </button>
          </div>
        )}
        {doc && showTimeline && (
          <aside
            className="graph-timeline"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
          >
            <div className="graph-timeline-title">{t('graph.timeline')}</div>
            {doc.nodes.length === 0 && (
              <div className="graph-timeline-empty">{t('graph.timelineEmpty')}</div>
            )}
            {outlineOrder(doc.nodes).map(({ node, depth }) => {
              const kind = graphNodeKind(doc.nodes, node)
              const raw = (node.status === 'error' ? `⚠ ${node.error ?? ''}` : node.text)
                .replace(/\s+/g, ' ')
                .trim()
              const label = raw.slice(0, OUTLINE_CHARS) || nodeTitle(node, t)
              return (
                <button
                  key={node.id}
                  className={[
                    'graph-timeline-row',
                    `k-${kind}`,
                    selection.includes(node.id) ? 'is-active' : ''
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{ paddingLeft: 10 + depth * 12 }}
                  title={`${nodeTitle(node, t)} — ${raw.slice(0, 200)}`}
                  onClick={() => navigateTo(node)}
                >
                  <span className="graph-timeline-bullet" />
                  <span className="graph-timeline-text">
                    {label}
                    {raw.length > OUTLINE_CHARS ? '…' : ''}
                  </span>
                </button>
              )
            })}
          </aside>
        )}
        {notice && <div className="graph-notice">{notice}</div>}
        {connectMode && <div className="graph-connect-hint">{t('graph.connectHint')}</div>}
      </div>

      {/* right panel: selection + inference controls */}
      <aside className="graph-panel">
        {!single && selectedNodes.length === 0 && (
          <div className="graph-panel-hint">{t('graph.selectHint')}</div>
        )}

        {selectedNodes.length > 1 && (
          <div className="graph-panel-block">
            <div className="graph-panel-title">
              {t('graph.multiSelected', { count: selectedNodes.length })}
            </div>
            <button className="btn" onClick={() => addNode(selectedNodes.map((n) => n.id))}>
              {t('graph.fromSelection')}
            </button>
            <div className="graph-panel-note">{t('graph.fromSelectionHint')}</div>
          </div>
        )}

        {single && (
          <div className="graph-panel-block">
            <div className="graph-panel-title">
              {nodeIcon(single)} {nodeTitle(single, t)}{' '}
              <span className="graph-node-id">{single.id.slice(0, 6)}</span>
            </div>
            {single.type === 'user' ? (
              <textarea
                ref={draftRef}
                className="graph-text"
                rows={6}
                placeholder={t('graph.promptPlaceholder')}
                value={draftText}
                onChange={(e) => updateNodeText(single.id, e.target.value)}
              />
            ) : (
              <div className="graph-answer">{single.text || `⚠ ${single.error ?? ''}`}</div>
            )}
            {single.durationMs !== undefined && (
              <div className="graph-panel-note">{(single.durationMs / 1000).toFixed(1)} s</div>
            )}

            <div className="graph-actions">
              <button className="btn" onClick={() => addNode([single.id])}>
                {t('graph.reply')}
              </button>
              <button
                className={`btn${connectMode ? ' is-active' : ''}`}
                onClick={() => setConnectMode((v) => !v)}
              >
                {t('graph.connect')}
              </button>
              <button className="btn" onClick={() => void inspect()}>
                {t('graph.inspect')}
              </button>
              <button className="btn danger" onClick={() => deleteNode(single.id)}>
                {t('common.delete')}
              </button>
            </div>

            {single.type === 'user' && (
              <div className="graph-infer-block">
                <div className="graph-panel-title">{t('graph.targets')}</div>
                {targetKeys.length > 0 && (
                  <div className="graph-target-chips">
                    {targetKeys.map((k) => {
                      const tg = targetMap[k]
                      if (!tg) return null
                      return (
                        <span key={k} className="graph-target-chip">
                          {CLI_ICONS[tg.cli]} {tg.model || tg.cli}
                          <button
                            className="graph-chip-x"
                            onClick={() => setTargetKeys((ks) => ks.filter((x) => x !== k))}
                          >
                            {GLYPH_ACTIONS.close}
                          </button>
                        </span>
                      )
                    })}
                  </div>
                )}
                <ModelPicker
                  catalogs={catalogs}
                  selected={targetKeys}
                  multi
                  onPick={toggleTarget}
                />
                <label className="graph-battle-row" title={t('graph.battleHint')}>
                  <input
                    type="checkbox"
                    checked={battle}
                    onChange={(e) => setBattle(e.target.checked)}
                  />
                  {GLYPH_BADGES.swords} {t('graph.battle')}
                </label>
                {battle && (
                  <div className="graph-target-row">
                    <span>{GLYPH_BADGES.scales} {t('graph.judge')}</span>
                    <ModelPicker
                      catalogs={catalogs}
                      selected={[judgeKey]}
                      multi={false}
                      onPick={(key, target) => {
                        setJudgeKey(key)
                        setJudgeTarget(target)
                      }}
                    />
                  </div>
                )}
                <button className="btn primary graph-infer-btn" disabled={!canInfer} onClick={() => void infer()}>
                  {running ? t('graph.running') : t('graph.infer')}
                </button>
              </div>
            )}
          </div>
        )}
      </aside>

      {inspector && (
        <div className="graph-inspector-overlay" onClick={() => setInspector(null)}>
          <div className="graph-inspector" onClick={(e) => e.stopPropagation()}>
            <div className="graph-panel-title">{t('graph.inspectorTitle')}</div>
            <pre className="graph-inspector-pre">{inspector.system}</pre>
            <div className="graph-panel-title">{t('graph.inspectorPrompt')}</div>
            <pre className="graph-inspector-pre is-prompt">{inspector.prompt}</pre>
            <button className="btn" onClick={() => setInspector(null)}>
              {t('common.close')}
            </button>
          </div>
        </div>
      )}

      {confirmDeleteGraph && (
        <ConfirmDialog
          title={t('graph.confirmDeleteTitle')}
          message={t('graph.confirmDeleteMessage')}
          confirmLabel={t('common.delete')}
          onCancel={() => setConfirmDeleteGraph(null)}
          onConfirm={() => void deleteGraphConfirmed()}
        />
      )}
    </div>
  )
}
