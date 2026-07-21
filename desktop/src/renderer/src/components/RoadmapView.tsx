import { useCallback, useEffect, useState } from 'react'
import type {
  RoadmapItem,
  RoadmapKind,
  RoadmapLevel,
  RoadmapPriority,
  RoadmapStatus,
  StopResult
} from '@shared/types'
import { useDeck } from '../store'
import { useT, type TFn } from '../i18n'
import { ConfirmDialog } from './ConfirmDialog'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { CreateMenu } from './CreateMenu'
import { KIND_ICONS, RoadmapItemModal } from './RoadmapItemModal'

// Roadmap view (PLAN C3-M3, reworked as a kanban board in PLAN K1): one column
// per status, native HTML5 drag & drop between columns, MoSCoW priority as a
// colored chip + sort inside each column. Data lives in the broker (roadmap:*
// IPC); agents write to the same table through their MCP tools, so the view
// polls while visible to pick up their changes.
//
// Movement rules (K1/K2): dropping on "done" asks for confirmation (the item
// will no longer be picked up); a locked in_progress card (an agent actively
// works on it) is greyed out and not draggable -- the operator goes through the
// ⏹ Stop button (K3) to reclaim it.

const KINDS: RoadmapKind[] = ['feature', 'bug', 'debt', 'idea', 'chore']
const PRIORITIES: RoadmapPriority[] = ['must', 'should', 'could', 'wont']
const LEVELS: RoadmapLevel[] = ['low', 'medium', 'high']
const STATUSES: RoadmapStatus[] = ['idea', 'planned', 'in_progress', 'done']
/** Column order of the board; 'archived' joins only when the toggle is on. */
const BOARD_COLUMNS: RoadmapStatus[] = ['idea', 'planned', 'in_progress', 'done']
const PRIORITY_RANK: Record<RoadmapPriority, number> = { must: 0, should: 1, could: 2, wont: 3 }
const POLL_MS = 5000

/** Editable subset of an item, buffered in the form. */
interface Draft {
  id?: string
  title: string
  kind: RoadmapKind
  priority: RoadmapPriority
  value: RoadmapLevel
  effort: RoadmapLevel
  status: RoadmapStatus | 'archived'
  description: string
  rationale: string
  context: string
  tags: string
}

const EMPTY_DRAFT: Draft = {
  title: '',
  kind: 'feature',
  priority: 'could',
  value: 'medium',
  effort: 'medium',
  status: 'idea',
  description: '',
  rationale: '',
  context: '',
  tags: ''
}

function toDraft(i: RoadmapItem): Draft {
  return {
    id: i.id,
    title: i.title,
    kind: i.kind,
    priority: i.priority,
    value: i.value,
    effort: i.effort,
    status: i.status,
    description: i.description,
    rationale: i.rationale,
    context: i.context,
    tags: i.tags.join(', ')
  }
}

/** True when the card is frozen by an agent's work-lock (PLAN K2). */
function isLocked(item: RoadmapItem): boolean {
  return item.locked && item.status === 'in_progress'
}

function BoardCard({
  item,
  onOpen,
  onMenu,
  onPrio,
  onDragStart,
  onDragEnd,
  t
}: {
  item: RoadmapItem
  onOpen: () => void
  onMenu: (x: number, y: number) => void
  onPrio: (x: number, y: number) => void
  onDragStart: (e: React.DragEvent) => void
  onDragEnd: () => void
  t: TFn
}): React.JSX.Element {
  const locked = isLocked(item)
  const draggable = !locked && item.status !== 'archived'
  return (
    <button
      className={`rm-card${locked ? ' rm-card-locked' : ''}${item.status === 'archived' ? ' rm-card-archived' : ''}`}
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onMenu(e.clientX, e.clientY)
      }}
      title={locked ? t('roadmap.lockedHint') : undefined}
    >
      <span className="rm-card-head">
        {/* Priority quick-switch (K7): the chip opens a styled dropdown, no
            detail view needed. A span, not a button (nested buttons are
            invalid inside the card button). */}
        <span
          className={`rm-prio-chip rm-prio-${item.priority}`}
          role="button"
          title={`${t(`roadmap.priority.${item.priority}`)} — ${t('roadmap.prioPick')}`}
          onClick={(e) => {
            e.stopPropagation()
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            onPrio(r.left, r.bottom + 4)
          }}
        >
          <span className="rm-prio-dot" />
        </span>
        <span className="rm-kind" title={t(`roadmap.kind.${item.kind}`)}>
          {KIND_ICONS[item.kind]}
        </span>
        <span className="rm-title">{item.title}</span>
      </span>
      <span className="rm-badges">
        <span className={`rm-badge rm-badge-value-${item.value}`}>
          {t('roadmap.value')}: {t(`roadmap.level.${item.value}`)}
        </span>
        <span className={`rm-badge rm-badge-effort-${item.effort}`}>
          {t('roadmap.effort')}: {t(`roadmap.level.${item.effort}`)}
        </span>
        {item.queue !== null && (
          <span className="rm-badge rm-badge-queue" title={t('roadmap.queueSection')}>
            ⏳ #{item.queue}
          </span>
        )}
        {locked && (
          <span className="rm-badge rm-badge-locked" title={t('roadmap.lockedHint')}>
            🔒 {item.locked_by}
          </span>
        )}
        {item.tags.map((tag) => (
          <span key={tag} className="rm-badge rm-badge-tag">
            #{tag}
          </span>
        ))}
      </span>
    </button>
  )
}

/**
 * The prompt handed to an agent spawned on an item (PLAN C3-M4). English, like
 * the MCP instructions the agent already reads; it closes the loop by asking
 * the agent to keep the item's status current through its roadmap tools.
 */
function composeItemPrompt(item: RoadmapItem): string {
  const lines = [
    `Take on this roadmap item (id ${item.id.slice(0, 8)}):`,
    '',
    `Title: ${item.title}`,
    `Kind: ${item.kind} | Priority: ${item.priority} | Value: ${item.value} | Effort: ${item.effort}`,
    item.description ? `Description: ${item.description}` : '',
    item.rationale ? `Rationale: ${item.rationale}` : '',
    item.context ? `Context (operator briefing): ${item.context}` : '',
    '',
    'Use roadmap_get for full context. Set the item to in_progress with roadmap_update when you actually start (this locks it under your peer_id so no other session takes it), then to done when the work is complete -- or back to planned if you stop without finishing (this releases the lock). Add follow-up items if you discover more.'
  ].filter((l) => l !== '')
  return lines.join('\n')
}

export function RoadmapView(): React.JSX.Element {
  const t = useT()
  const showToast = useDeck((s) => s.showToast)
  const setView = useDeck((s) => s.setView)
  const sessions = useDeck((s) => s.sessions)
  // Dispatch needs a live team-lead (PLAN C15); the button greys out otherwise.
  const hasLead = sessions.some((s) => s.lead && !s.supervisor && s.status !== 'exited')

  const [items, setItems] = useState<RoadmapItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [kindFilter, setKindFilter] = useState<'' | RoadmapKind>('')
  const [showArchived, setShowArchived] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Form state: null = closed; a Draft without id = create; with id = edit.
  const [draft, setDraft] = useState<Draft | null>(null)
  const [confirmArchive, setConfirmArchive] = useState<RoadmapItem | null>(null)
  // Drag & drop: the dragged item id + the column currently hovered (K1).
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropCol, setDropCol] = useState<RoadmapStatus | null>(null)
  // Drop on "done" awaits an explicit confirmation before it applies (K1).
  const [confirmDone, setConfirmDone] = useState<RoadmapItem | null>(null)
  // Operator stop on a locked item (K3), confirmed before the announce.
  const [confirmStop, setConfirmStop] = useState<RoadmapItem | null>(null)
  // Right-click context menu on a card (K6): viewport anchor + target item.
  const [menu, setMenu] = useState<{ x: number; y: number; item: RoadmapItem } | null>(null)
  // Priority quick-switch dropdown anchored under a card's chip (K7).
  const [prioMenu, setPrioMenu] = useState<{ x: number; y: number; item: RoadmapItem } | null>(null)
  // "Process now" (K6): pick a live agent (targeted announce) or spawn one.
  const [assignItem, setAssignItem] = useState<RoadmapItem | null>(null)
  // Item the "launch an agent" flow is spawning for (advanced create pre-filled).
  const [launchItem, setLaunchItem] = useState<RoadmapItem | null>(null)
  // Context wand (PLAN C21): one in-flight generation at a time.
  const [wandBusy, setWandBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.roadmapList({
        kind: kindFilter || undefined,
        include_archived: showArchived
      })
      setItems(next)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoaded(true)
    }
  }, [kindFilter, showArchived])

  // Initial load + poll while the view is visible (agents may write any time).
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  // Files-view seed (PLAN GX8): open the create form prefilled with the code
  // selection. Saving stays an explicit operator action (wand-style contract).
  const roadmapSeed = useDeck((s) => s.roadmapSeed)
  const clearRoadmapSeed = useDeck((s) => s.clearRoadmapSeed)
  useEffect(() => {
    if (!roadmapSeed) return
    setDraft({
      ...EMPTY_DRAFT,
      status: 'planned',
      priority: 'should',
      ...roadmapSeed
    })
    clearRoadmapSeed()
  }, [roadmapSeed, clearRoadmapSeed])

  const selected = items.find((i) => i.id === selectedId) ?? null

  const save = async (): Promise<void> => {
    if (!draft || !draft.title.trim()) return
    const tags = draft.tags
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    try {
      const saved = await window.api.roadmapUpsert({
        id: draft.id,
        title: draft.title.trim(),
        kind: draft.kind,
        priority: draft.priority,
        value: draft.value,
        effort: draft.effort,
        // 'archived' is only reachable through the Archive button, not the form.
        status: draft.status === 'archived' ? undefined : draft.status,
        description: draft.description,
        rationale: draft.rationale,
        context: draft.context,
        tags
      })
      setDraft(null)
      setSelectedId(saved.id)
      showToast('toast.roadmapSaved')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const archive = async (item: RoadmapItem): Promise<void> => {
    try {
      await window.api.roadmapArchive(item.id)
      showToast('toast.roadmapArchived', 'info')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const restore = async (item: RoadmapItem): Promise<void> => {
    try {
      await window.api.roadmapUpsert({ id: item.id, status: 'planned' })
      showToast('toast.roadmapSaved')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // Dispatch queue (PLAN C15): operator-ordered subset, rendered on top.
  const queued = items
    .filter((i) => i.queue !== null && i.status !== 'done' && i.status !== 'archived')
    .sort((a, b) => a.queue! - b.queue!)

  const setQueue = async (item: RoadmapItem, queue: number | null): Promise<void> => {
    try {
      await window.api.roadmapUpsert({ id: item.id, queue })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const queueItem = (item: RoadmapItem): Promise<void> =>
    setQueue(item, Math.max(0, ...items.map((i) => i.queue ?? 0)) + 1)

  // Context wand (PLAN C21): a read-only haiku pass drafts the briefing from
  // the item + the project files. It only fills the textarea (still editable);
  // nothing is saved until the operator hits Save.
  const wand = async (): Promise<void> => {
    if (!draft || wandBusy) return
    setWandBusy(true)
    try {
      const proposed = await window.api.roadmapWand({
        title: draft.title,
        kind: draft.kind,
        description: draft.description,
        rationale: draft.rationale,
        context: draft.context
      })
      // The draft may have been closed while the wand ran: drop the result.
      setDraft((d) => (d ? { ...d, context: proposed } : d))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setWandBusy(false)
    }
  }

  const dispatch = async (): Promise<void> => {
    const r = await window.api.roadmapDispatch()
    if (r.sent) showToast('toast.dispatched')
    else showToast(r.reason === 'no-lead' ? 'toast.dispatchNoLead' : 'toast.dispatchFailed', 'info')
    await refresh()
  }

  // ----- kanban moves (K1) -----

  const applyMove = async (item: RoadmapItem, status: RoadmapStatus): Promise<void> => {
    try {
      await window.api.roadmapUpsert({ id: item.id, status })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const moveItem = (item: RoadmapItem, status: RoadmapStatus): void => {
    if (item.status === status || isLocked(item)) return
    if (status === 'done') setConfirmDone(item)
    else void applyMove(item, status)
  }

  const dropOn = (status: RoadmapStatus): void => {
    const item = items.find((i) => i.id === dragId) ?? null
    setDragId(null)
    setDropCol(null)
    if (item) moveItem(item, status)
  }

  // ----- operator stop (K3) -----

  const stop = async (item: RoadmapItem): Promise<void> => {
    try {
      const r: StopResult = await window.api.roadmapStop(item.id)
      if (!r.stopped) showToast('toast.stopFailed', 'info')
      else if (r.via === 'supervisor') showToast('toast.stopSupervisor')
      else if (r.via === 'broadcast') showToast('toast.stopBroadcast')
      else showToast('toast.stopNoPeers', 'info')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // Priority quick-switch (K7): metadata write, allowed even on locked items
  // (the broker guard only protects status / lock claims).
  const setPriority = async (item: RoadmapItem, priority: RoadmapPriority): Promise<void> => {
    setPrioMenu(null)
    if (item.priority === priority) return
    try {
      await window.api.roadmapUpsert({ id: item.id, priority })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // ----- direct assignment (K6) -----

  // Live, addressable agents: peer_id resolved, not the supervisor.
  const liveAgents = sessions.filter((s) => !s.supervisor && s.status !== 'exited' && s.peerId)

  const assign = async (item: RoadmapItem, peerId: string): Promise<void> => {
    setAssignItem(null)
    try {
      const r = await window.api.roadmapAssign(item.id, peerId)
      showToast(r.sent ? 'toast.assignSent' : 'toast.assignFailed', r.sent ? 'success' : 'info')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // ----- card context menu (K6) -----

  const menuItems = (item: RoadmapItem): ContextMenuItem[] => {
    const locked = isLocked(item)
    const closed = item.status === 'done' || item.status === 'archived'
    return [
      {
        label: t('roadmap.menuEdit'),
        disabled: locked,
        onSelect: () => setDraft(toDraft(item))
      },
      {
        label: t('roadmap.menuQueue'),
        disabled: locked || closed || item.queue !== null,
        onSelect: () => void queueItem(item)
      },
      {
        label: t('roadmap.menuAssign'),
        disabled: locked || closed,
        onSelect: () => setAssignItem(item)
      },
      {
        label: t('roadmap.menuDelete'),
        danger: true,
        disabled: locked || item.status === 'archived',
        onSelect: () => setConfirmArchive(item)
      }
    ]
  }

  const columns: RoadmapStatus[] = showArchived ? [...BOARD_COLUMNS, 'archived'] : BOARD_COLUMNS
  const columnItems = (status: RoadmapStatus): RoadmapItem[] =>
    items
      .filter((i) => i.status === status)
      .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])

  return (
    <div className="roadmap-view">
      <header className="roadmap-head">
        <h2>{t('roadmap.title')}</h2>
        <select
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value as '' | RoadmapKind)}
          title={t('roadmap.filterKind')}
        >
          <option value="">{t('roadmap.allKinds')}</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_ICONS[k]} {t(`roadmap.kind.${k}`)}
            </option>
          ))}
        </select>
        <label className="roadmap-archived-toggle">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          <span>{t('roadmap.showArchived')}</span>
        </label>
        <span className="roadmap-spacer" />
        <button
          className="btn"
          onClick={() => {
            void window.api.importPlan().then((spawned) => {
              if (spawned) {
                showToast('toast.planImportStarted')
                setView('agents')
              }
            })
          }}
        >
          {t('roadmap.importPlan')}
        </button>
        <button className="primary" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
          {t('roadmap.add')}
        </button>
      </header>

      {error && <div className="roadmap-error">{t('roadmap.error', { error })}</div>}

      {queued.length > 0 && (
        <section className="rm-section rm-section-queue">
          <h3 className="rm-section-head rm-queue-head">
            ⏳ {t('roadmap.queueSection')}
            <span className="rm-count">{queued.length}</span>
            <span className="roadmap-spacer" />
            <button
              className="primary rm-dispatch-btn"
              disabled={!hasLead}
              title={hasLead ? undefined : t('roadmap.dispatchNoLeadHint')}
              onClick={() => void dispatch()}
            >
              {t('roadmap.dispatchFirst')}
            </button>
          </h3>
          {!hasLead && <p className="rm-queue-hint">{t('roadmap.dispatchNoLeadHint')}</p>}
          {queued.map((item) => (
            <div key={item.id} className="rm-queue-row">
              <span className="rm-queue-pos">#{item.queue}</span>
              <button className="rm-queue-title" onClick={() => setSelectedId(item.id)}>
                {KIND_ICONS[item.kind]} {item.title}
              </button>
              <button
                className="row-btn"
                title={t('roadmap.queueRemove')}
                onClick={() => void setQueue(item, null)}
              >
                ✕
              </button>
            </div>
          ))}
        </section>
      )}

      {loaded && items.length === 0 && !error && (
        <p className="roadmap-empty">{t('roadmap.empty')}</p>
      )}

      <div className="rm-board">
        {columns.map((status) => {
          const rows = columnItems(status)
          const droppable = status !== 'archived'
          return (
            <section
              key={status}
              className={`rm-col rm-col-${status}${dropCol === status && dragId ? ' rm-col-over' : ''}`}
              onDragOver={
                droppable
                  ? (e) => {
                      e.preventDefault()
                      setDropCol(status)
                    }
                  : undefined
              }
              onDragLeave={droppable ? () => setDropCol((c) => (c === status ? null : c)) : undefined}
              onDrop={droppable ? () => dropOn(status) : undefined}
            >
              <h3 className={`rm-col-head rm-col-head-${status}`}>
                {t(`roadmap.status.${status}`)}
                <span className="rm-count">{rows.length}</span>
              </h3>
              <div className="rm-col-body">
                {rows.map((item) => (
                  <BoardCard
                    key={item.id}
                    item={item}
                    onOpen={() => setSelectedId(item.id)}
                    onMenu={(x, y) => setMenu({ x, y, item })}
                    onPrio={(x, y) => setPrioMenu({ x, y, item })}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', item.id)
                      e.dataTransfer.effectAllowed = 'move'
                      setDragId(item.id)
                    }}
                    onDragEnd={() => {
                      setDragId(null)
                      setDropCol(null)
                    }}
                    t={t}
                  />
                ))}
              </div>
            </section>
          )
        })}
      </div>

      {selected && !draft && (
        <RoadmapItemModal
          item={selected}
          onClose={() => setSelectedId(null)}
          onEdit={() => setDraft(toDraft(selected))}
          onLaunch={() => setLaunchItem(selected)}
          onStop={() => setConfirmStop(selected)}
          onQueue={() => void queueItem(selected)}
          onUnqueue={() => void setQueue(selected, null)}
          onArchive={() => setConfirmArchive(selected)}
          onRestore={() => void restore(selected)}
        />
      )}

      {draft && (
        <div className="modal-backdrop" onMouseDown={() => setDraft(null)}>
          <aside className="modal rm-modal rm-modal-form" onMouseDown={(e) => e.stopPropagation()}>
            <header className="rm-detail-head">
              <h3>{draft.id ? t('roadmap.editTitle') : t('roadmap.createTitle')}</h3>
              <button className="icon-btn" title={t('common.close')} onClick={() => setDraft(null)}>
                ✕
              </button>
            </header>
            <label className="field">
              <span>{t('roadmap.fieldTitle')}</span>
              <input
                value={draft.title}
                autoFocus
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </label>
            <div className="field-grid">
              <label className="field">
                <span>{t('roadmap.fieldKind')}</span>
                <select
                  value={draft.kind}
                  onChange={(e) => setDraft({ ...draft, kind: e.target.value as RoadmapKind })}
                >
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {KIND_ICONS[k]} {t(`roadmap.kind.${k}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t('roadmap.fieldPriority')}</span>
                <select
                  value={draft.priority}
                  onChange={(e) =>
                    setDraft({ ...draft, priority: e.target.value as RoadmapPriority })
                  }
                >
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {t(`roadmap.priority.${p}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t('roadmap.value')}</span>
                <select
                  value={draft.value}
                  onChange={(e) => setDraft({ ...draft, value: e.target.value as RoadmapLevel })}
                >
                  {LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {t(`roadmap.level.${l}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t('roadmap.effort')}</span>
                <select
                  value={draft.effort}
                  onChange={(e) => setDraft({ ...draft, effort: e.target.value as RoadmapLevel })}
                >
                  {LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {t(`roadmap.level.${l}`)}
                    </option>
                  ))}
                </select>
              </label>
              {draft.status !== 'archived' && (
                <label className="field">
                  <span>{t('roadmap.fieldStatus')}</span>
                  <select
                    value={draft.status}
                    onChange={(e) => setDraft({ ...draft, status: e.target.value as RoadmapStatus })}
                  >
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {t(`roadmap.status.${s}`)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <label className="field">
              <span>{t('roadmap.fieldDescription')}</span>
              <textarea
                rows={3}
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </label>
            <label className="field">
              <span>{t('roadmap.fieldRationale')}</span>
              <textarea
                rows={2}
                value={draft.rationale}
                onChange={(e) => setDraft({ ...draft, rationale: e.target.value })}
              />
            </label>
            <label className="field rm-context-field">
              <span className="rm-context-label">
                {t('roadmap.fieldContext')}
                <button
                  type="button"
                  className="icon-btn rm-wand-btn"
                  title={t('roadmap.wandTitle')}
                  disabled={wandBusy || !draft.title.trim()}
                  onClick={() => void wand()}
                >
                  {wandBusy ? '⏳' : '🪄'}
                </button>
              </span>
              <textarea
                rows={6}
                value={draft.context}
                placeholder={t('roadmap.fieldContextPlaceholder')}
                disabled={wandBusy}
                onChange={(e) => setDraft({ ...draft, context: e.target.value })}
              />
              {wandBusy && <span className="rm-wand-hint">{t('roadmap.wandBusy')}</span>}
            </label>
            <label className="field">
              <span>{t('roadmap.fieldTags')}</span>
              <input
                value={draft.tags}
                placeholder={t('roadmap.fieldTagsPlaceholder')}
                onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
              />
            </label>
            <div className="modal-actions">
              <button onClick={() => setDraft(null)}>{t('common.cancel')}</button>
              <button className="primary" disabled={!draft.title.trim()} onClick={() => void save()}>
                {draft.id ? t('roadmap.save') : t('roadmap.create')}
              </button>
            </div>
          </aside>
        </div>
      )}

      {launchItem && (
        <CreateMenu
          onClose={() => setLaunchItem(null)}
          initial={{
            prompt: composeItemPrompt(launchItem),
            announce: t('roadmap.launchAnnounce', { title: launchItem.title })
          }}
          onCreate={() => {
            // Immediate feedback: flag the item in_progress (the agent locks it
            // and keeps it current afterwards via its roadmap tools).
            void window.api
              .roadmapUpsert({ id: launchItem.id, status: 'in_progress' })
              .then(() => refresh())
              .catch(() => undefined)
            setView('agents')
          }}
        />
      )}

      {confirmDone && (
        <ConfirmDialog
          title={t('roadmap.confirmDoneTitle')}
          message={t('roadmap.confirmDoneMessage', { title: confirmDone.title })}
          confirmLabel={t('roadmap.confirmDone')}
          onCancel={() => setConfirmDone(null)}
          onConfirm={() => {
            const item = confirmDone
            setConfirmDone(null)
            void applyMove(item, 'done')
          }}
        />
      )}

      {confirmStop && (
        <ConfirmDialog
          title={t('roadmap.confirmStopTitle')}
          message={t('roadmap.confirmStopMessage', { title: confirmStop.title })}
          confirmLabel={t('roadmap.stop')}
          onCancel={() => setConfirmStop(null)}
          onConfirm={() => {
            const item = confirmStop
            setConfirmStop(null)
            void stop(item)
          }}
        />
      )}

      {confirmArchive && (
        <ConfirmDialog
          title={t('roadmap.confirmArchiveTitle')}
          message={t('roadmap.confirmArchiveMessage', { title: confirmArchive.title })}
          confirmLabel={t('roadmap.archive')}
          onCancel={() => setConfirmArchive(null)}
          onConfirm={() => {
            const item = confirmArchive
            setConfirmArchive(null)
            void archive(item)
          }}
        />
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.item)}
          onClose={() => setMenu(null)}
        />
      )}

      {prioMenu && (
        <div
          className="context-menu-backdrop"
          onMouseDown={(e) => {
            e.stopPropagation()
            setPrioMenu(null)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setPrioMenu(null)
          }}
        >
          <ul
            className="context-menu rm-prio-menu"
            style={{ left: prioMenu.x, top: prioMenu.y }}
            role="menu"
            onMouseDown={(e) => e.stopPropagation()}
          >
            {PRIORITIES.map((p) => (
              <li key={p} role="none">
                <button
                  type="button"
                  role="menuitem"
                  className={`context-menu-item rm-prio-option rm-prio-${p}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    void setPriority(prioMenu.item, p)
                  }}
                >
                  <span className="rm-prio-dot" />
                  <span className="rm-prio-option-label">{t(`roadmap.priority.${p}`)}</span>
                  {p === prioMenu.item.priority && <span className="rm-prio-check">✓</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {assignItem && (
        <div className="modal-backdrop" onMouseDown={() => setAssignItem(null)}>
          <div className="modal rm-assign-modal" onMouseDown={(e) => e.stopPropagation()}>
            <header className="rm-detail-head">
              <h3>{t('roadmap.assignTitle')}</h3>
              <button
                className="icon-btn"
                title={t('common.close')}
                onClick={() => setAssignItem(null)}
              >
                ✕
              </button>
            </header>
            <p className="rm-assign-hint">{t('roadmap.assignHint', { title: assignItem.title })}</p>
            {liveAgents.length === 0 && (
              <p className="rm-assign-empty">{t('roadmap.assignNoAgents')}</p>
            )}
            <div className="rm-assign-list">
              {liveAgents.map((s) => (
                <button
                  key={s.id}
                  className="rm-assign-row"
                  onClick={() => void assign(assignItem, s.peerId!)}
                >
                  <span className="rm-assign-dot" style={{ background: s.color }} />
                  <span className="rm-assign-name">{s.name}</span>
                  {s.lead && <span title={t('sidebar.leadTitle')}>👑</span>}
                  <span className="rm-assign-peer">{s.peerId}</span>
                </button>
              ))}
            </div>
            <div className="modal-actions">
              <button onClick={() => setAssignItem(null)}>{t('common.cancel')}</button>
              <button
                className="primary"
                onClick={() => {
                  const item = assignItem
                  setAssignItem(null)
                  setLaunchItem(item)
                }}
              >
                {t('roadmap.assignNew')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
