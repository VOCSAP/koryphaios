import { useCallback, useEffect, useRef, useState } from 'react'
import type { RoadmapItem, RoadmapPriority, RoadmapStatus, StopResult } from '@shared/types'
import { GLYPHS, GLYPH_ACTIONS, GLYPH_BADGES } from './icons'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { ConfirmDialog } from './ConfirmDialog'
import { MobileSheet } from './MobileSheet'
import { KIND_ICONS, RoadmapItemModal } from './RoadmapItemModal'
import { DEFAULT_HOLD_GESTURE, HoldGesture } from '@shared/hold-gesture'
import { enqueueClosure, insertSoloWaves, queuedItems, wavesOf } from '@shared/workflow'

// Mobile roadmap (PLAN MB4 — EXPLORATION §4): ONE column at a time (status
// tabs + counters), full-width cards auto-sorted by MoSCoW, explicit moves
// through the action sheet, and the FLOATING BASKET: long-press seizes a card
// (haptic), moving detaches it into a thumbnail tray docked above the tab
// bar; navigate to the target column and tap the thumbnail to drop it there.
// Same five roadmap IPC calls as the desktop kanban — presentation only.

const STATUSES: RoadmapStatus[] = ['idea', 'planned', 'in_progress', 'done']
const PRIORITY_RANK: Record<RoadmapPriority, number> = { must: 0, should: 1, could: 2, wont: 3 }
const PRIORITIES: RoadmapPriority[] = ['must', 'should', 'could', 'wont']
const POLL_MS = 5000

function isLocked(item: RoadmapItem): boolean {
  return item.locked && item.status === 'in_progress'
}

/** Compact edit buffer (mobile v1: the fields that matter on the go). */
interface QuickEdit {
  id: string
  title: string
  priority: RoadmapPriority
  description: string
}

function RoadmapCard({
  item,
  onTap,
  onSeize,
  onDetach,
  onOptions,
  t
}: {
  item: RoadmapItem
  onTap: () => void
  onSeize: () => void
  onDetach: () => void
  onOptions: () => void
  t: (key: string) => string
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [seized, setSeized] = useState(false)
  const locked = isLocked(item)

  // Latest-ref pattern: the parent re-renders every POLL_MS (5s) with fresh
  // inline callbacks. Reading them through a ref keeps the listener effect
  // stable (deps: [locked] only), so a re-render mid-press no longer tears
  // down the HoldGesture and aborts the seize/drag in progress.
  const cbRef = useRef({ onSeize, onDetach, onOptions })
  cbRef.current = { onSeize, onDetach, onOptions }

  // Native listeners (not React synthetic): touchmove must be NON-passive so
  // preventDefault can keep the scroll from starting once the card is seized
  // (EXPLORATION §4 grammaire gestuelle — the window exploited is "scroll not
  // started yet"). React registers touch listeners passively, hence the ref.
  useEffect(() => {
    const el = ref.current
    if (!el || locked) return
    const gesture = new HoldGesture(DEFAULT_HOLD_GESTURE)
    let timer: number | null = null
    let seizedNow = false

    const clear = (): void => {
      if (timer !== null) window.clearTimeout(timer)
      timer = null
      seizedNow = false
      setSeized(false)
    }
    const onDown = (e: TouchEvent): void => {
      const t0 = e.touches[0]
      if (!t0 || e.touches.length > 1) return
      gesture.down(t0.clientX, t0.clientY, e.timeStamp)
      timer = window.setTimeout(() => {
        if (gesture.tick(performance.now()) === 'seized') {
          seizedNow = true
          setSeized(true)
          navigator.vibrate?.(15)
          cbRef.current.onSeize()
        }
      }, DEFAULT_HOLD_GESTURE.holdMs + 10)
    }
    const onMove = (e: TouchEvent): void => {
      const t0 = e.touches[0]
      if (!t0) return
      if (seizedNow) e.preventDefault()
      const outcome = gesture.move(t0.clientX, t0.clientY, e.timeStamp)
      if (outcome === 'seized') {
        seizedNow = true
        setSeized(true)
        navigator.vibrate?.(15)
        cbRef.current.onSeize()
      } else if (outcome === 'detach') {
        clear()
        navigator.vibrate?.([10, 30, 20])
        cbRef.current.onDetach()
      } else if (outcome === 'cancel') {
        clear()
      }
    }
    const onUp = (e: TouchEvent): void => {
      const outcome = gesture.up(e.timeStamp)
      const wasSeized = seizedNow
      clear()
      if (outcome === 'options' && wasSeized) cbRef.current.onOptions()
    }
    const onCancel = (): void => {
      gesture.cancel()
      clear()
    }
    const onCtx = (e: Event): void => e.preventDefault()
    el.addEventListener('touchstart', onDown, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onUp, { passive: true })
    el.addEventListener('touchcancel', onCancel, { passive: true })
    el.addEventListener('contextmenu', onCtx)
    return () => {
      el.removeEventListener('touchstart', onDown)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onUp)
      el.removeEventListener('touchcancel', onCancel)
      el.removeEventListener('contextmenu', onCtx)
      clear()
    }
  }, [locked])

  return (
    <div
      ref={ref}
      className={`mrm-card${locked ? ' mrm-card-locked' : ''}${seized ? ' mrm-card-seized' : ''}`}
      onClick={onTap}
    >
      <div className="mrm-card-head">
        <span className="mrm-kind">{KIND_ICONS[item.kind]}</span>
        <span className="mrm-title">{item.title}</span>
        {locked && <span className="mrm-lock">{GLYPH_BADGES.lock}</span>}
        {item.queue !== null && <span className="mrm-queue">#{item.queue}</span>}
      </div>
      <div className="mrm-card-meta">
        <span className={`mrm-prio mrm-prio-${item.priority}`}>{t(`roadmap.priority.${item.priority}`)}</span>
        {item.tags.slice(0, 3).map((tag) => (
          <span key={tag} className="mrm-tag">
            {tag}
          </span>
        ))}
      </div>
    </div>
  )
}

export function RoadmapList(): React.JSX.Element {
  const t = useT()
  const showToast = useDeck((s) => s.showToast)
  const sessions = useDeck((s) => s.sessions)
  const [items, setItems] = useState<RoadmapItem[]>([])
  const [tab, setTab] = useState<RoadmapStatus | 'archived'>('planned')
  const [showArchived, setShowArchived] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sheetItem, setSheetItem] = useState<RoadmapItem | null>(null)
  const [moveItemSheet, setMoveItemSheet] = useState<RoadmapItem | null>(null)
  const [assignItem, setAssignItem] = useState<RoadmapItem | null>(null)
  const [detail, setDetail] = useState<RoadmapItem | null>(null)
  const [confirmDone, setConfirmDone] = useState<RoadmapItem | null>(null)
  const [edit, setEdit] = useState<QuickEdit | null>(null)
  /** Floating basket (MB4): seized-then-detached cards, by id. */
  const [basket, setBasket] = useState<RoadmapItem[]>([])
  /** Undo snackbar for the last drop: revert to the previous status. */
  const [undo, setUndo] = useState<{ item: RoadmapItem; from: RoadmapStatus } | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.roadmapList({ include_archived: showArchived })
      setItems(next)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [showArchived])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const upsert = async (patch: Parameters<typeof window.api.roadmapUpsert>[0]): Promise<void> => {
    try {
      await window.api.roadmapUpsert(patch)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const addDep = async (childId: string, parentId: string): Promise<void> => {
    const child = items.find((i) => i.id === childId)
    if (!child || child.depends_on.includes(parentId)) return
    await upsert({ id: childId, depends_on: [...child.depends_on, parentId] })
  }

  const removeDep = async (childId: string, parentId: string): Promise<void> => {
    const child = items.find((i) => i.id === childId)
    if (!child) return
    await upsert({ id: childId, depends_on: child.depends_on.filter((d) => d !== parentId) })
  }

  const applyMove = async (item: RoadmapItem, status: RoadmapStatus): Promise<void> => {
    const from = item.status as RoadmapStatus
    await upsert({ id: item.id, status })
    setBasket((b) => b.filter((x) => x.id !== item.id))
    setUndo({ item, from })
    window.setTimeout(() => setUndo((u) => (u?.item.id === item.id ? null : u)), 5000)
  }

  const moveTo = (item: RoadmapItem, status: RoadmapStatus): void => {
    if (item.status === status || isLocked(item)) return
    if (status === 'done') setConfirmDone(item)
    else void applyMove(item, status)
  }

  const stop = async (item: RoadmapItem): Promise<void> => {
    try {
      const r: StopResult = await window.api.roadmapStop(item.id)
      if (!r.stopped) showToast('toast.stopFailed', 'info')
      else showToast(r.via === 'supervisor' ? 'toast.stopSupervisor' : 'toast.stopBroadcast')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // Appends item to the end of the queue, pulling its unmet, unqueued
  // dependencies along with it (dependency-first, right before it) in the
  // SAME reorder commit -- mirrors RoadmapView's desktop queueItem so the
  // mobile "add to queue" entry point can't skip enqueueClosure either.
  // Preserves existing wave ties (wavesOf) instead of flattening the queue to
  // 1..N; the appended item and its closure each land as their own singleton
  // wave (see insertSoloWaves).
  const queueItem = async (item: RoadmapItem): Promise<void> => {
    const queued = queuedItems(items).filter((i) => i.id !== item.id)
    const queuedIds = queued.map((i) => i.id)
    const closure = enqueueClosure(items, item.id)
    const ids = [...queuedIds, ...closure, item.id]
    const waves = insertSoloWaves(wavesOf(queued), queuedIds.length, [...closure, item.id])
    try {
      await window.api.roadmapReorder(ids, waves)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

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

  const archive = async (item: RoadmapItem): Promise<void> => {
    try {
      await window.api.roadmapArchive(item.id)
      showToast('toast.roadmapArchived')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const liveAgents = sessions.filter((s) => !s.supervisor && s.status !== 'exited' && s.peerId)

  const tabs: (RoadmapStatus | 'archived')[] = showArchived ? [...STATUSES, 'archived'] : STATUSES
  const inTab = items
    .filter((i) => i.status === tab)
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])
  const count = (s: RoadmapStatus | 'archived'): number => items.filter((i) => i.status === s).length

  const detach = (item: RoadmapItem): void => {
    setBasket((b) => (b.some((x) => x.id === item.id) ? b : [...b, item]))
  }

  return (
    <div className="mrm">
      <div className="mrm-tabs">
        {tabs.map((s) => (
          <button
            key={s}
            className={`mrm-tab${tab === s ? ' is-active' : ''}`}
            onClick={() => setTab(s)}
          >
            {t(`roadmap.status.${s}`)}
            <span className="mrm-tab-count">{count(s)}</span>
          </button>
        ))}
        <button
          className={`mrm-tab mrm-tab-arch${showArchived ? ' is-active' : ''}`}
          onClick={() => {
            setShowArchived((v) => !v)
            if (tab === 'archived') setTab('planned')
          }}
        >
          {GLYPH_BADGES.archive}
        </button>
      </div>
      {error && <div className="mrm-error">{error}</div>}
      <div className="mrm-list">
        {inTab.length === 0 && <div className="mrm-empty">{t('mobile.roadmapEmpty')}</div>}
        {inTab.map((item) => (
          <RoadmapCard
            key={item.id}
            item={item}
            t={t}
            onTap={() => setDetail(item)}
            onSeize={() => undefined}
            onDetach={() => detach(item)}
            onOptions={() => setSheetItem(item)}
          />
        ))}
      </div>

      {/* Floating basket tray (MB4): thumb-zone docked, above the tab bar. */}
      {basket.length > 0 && (
        <div className="mrm-basket">
          <span className="mrm-basket-hint">{t('mobile.basketHint')}</span>
          {basket.map((b) => (
            <button
              key={b.id}
              className="mrm-basket-chip"
              onClick={() => {
                if (tab === 'archived') return
                // Resolve the LIVE item by id: the snapshot captured at detach
                // time can be stale after a poll (an agent may have moved or
                // locked it while it floated). moveTo then sees the real state.
                const live = items.find((i) => i.id === b.id)
                if (!live) {
                  setBasket((cur) => cur.filter((x) => x.id !== b.id))
                  return
                }
                moveTo(live, tab)
              }}
            >
              {KIND_ICONS[b.kind]} {b.title.slice(0, 24)}
            </button>
          ))}
          <button className="mrm-basket-clear" onClick={() => setBasket([])}>
            {GLYPH_ACTIONS.close}
          </button>
        </div>
      )}

      {undo && (
        <div className="mrm-undo">
          <span>{t('mobile.moved')}</span>
          <button
            onClick={() => {
              void applyMove(undo.item, undo.from)
              setUndo(null)
            }}
          >
            {t('mobile.undo')}
          </button>
        </div>
      )}

      {/* Action sheet — the mobile mirror of the desktop right-click menu,
          plus "Soulever" as the discoverable path to the basket. */}
      {sheetItem && (
        <MobileSheet onClose={() => setSheetItem(null)} title={sheetItem.title}>
          <button
            className="msheet-item"
            onClick={() => {
              setMoveItemSheet(sheetItem)
              setSheetItem(null)
            }}
          >
            ⇢ {t('mobile.moveTo')}
          </button>
          <button
            className="msheet-item"
            onClick={() => {
              detach(sheetItem)
              setSheetItem(null)
            }}
          >
            <span className="msheet-icon">{GLYPH_BADGES.lift}</span> {t('mobile.lift')}
          </button>
          <button
            className="msheet-item"
            disabled={isLocked(sheetItem)}
            onClick={() => {
              setEdit({
                id: sheetItem.id,
                title: sheetItem.title,
                priority: sheetItem.priority,
                description: sheetItem.description
              })
              setSheetItem(null)
            }}
          >
            <span className="msheet-icon">{GLYPH_ACTIONS.edit}</span> {t('roadmap.menuEdit')}
          </button>
          <button
            className="msheet-item"
            disabled={
              isLocked(sheetItem) ||
              sheetItem.status === 'done' ||
              sheetItem.status === 'archived' ||
              sheetItem.queue !== null
            }
            onClick={() => {
              void queueItem(sheetItem)
              setSheetItem(null)
            }}
          >
            ⏱ {t('roadmap.menuQueue')}
          </button>
          <button
            className="msheet-item"
            disabled={liveAgents.length === 0}
            onClick={() => {
              setAssignItem(sheetItem)
              setSheetItem(null)
            }}
          >
            <span className="msheet-icon">{GLYPHS.agents}</span> {t('roadmap.menuAssign')}
          </button>
          {isLocked(sheetItem) && (
            <button
              className="msheet-item"
              onClick={() => {
                void stop(sheetItem)
                setSheetItem(null)
              }}
            >
              ⏹ {t('roadmap.stop')}
            </button>
          )}
          <button
            className="msheet-item msheet-item-danger"
            disabled={isLocked(sheetItem)}
            onClick={() => {
              void archive(sheetItem)
              setSheetItem(null)
            }}
          >
            {t('roadmap.menuDelete')}
          </button>
        </MobileSheet>
      )}

      {moveItemSheet && (
        <MobileSheet onClose={() => setMoveItemSheet(null)} title={t('mobile.moveTo')}>
          {STATUSES.filter((s) => s !== moveItemSheet.status).map((s) => (
            <button
              key={s}
              className="msheet-item"
              onClick={() => {
                moveTo(moveItemSheet, s)
                setMoveItemSheet(null)
              }}
            >
              {t(`roadmap.status.${s}`)}
            </button>
          ))}
        </MobileSheet>
      )}

      {assignItem && (
        <MobileSheet onClose={() => setAssignItem(null)} title={t('roadmap.menuAssign')}>
          {liveAgents.map((s) => (
            <button
              key={s.id}
              className="msheet-item"
              onClick={() => void assign(assignItem, s.peerId!)}
            >
              {s.name} ({s.peerId})
            </button>
          ))}
        </MobileSheet>
      )}

      {edit && (
        <MobileSheet onClose={() => setEdit(null)} title={t('roadmap.menuEdit')}>
          <input
            className="msheet-input"
            value={edit.title}
            onChange={(e) => setEdit({ ...edit, title: e.target.value })}
          />
          <div className="msheet-prio-row">
            {PRIORITIES.map((p) => (
              <button
                key={p}
                className={`mrm-prio mrm-prio-${p}${edit.priority === p ? ' is-active' : ''}`}
                onClick={() => setEdit({ ...edit, priority: p })}
              >
                {t(`roadmap.priority.${p}`)}
              </button>
            ))}
          </div>
          <textarea
            className="msheet-textarea"
            rows={5}
            value={edit.description}
            onChange={(e) => setEdit({ ...edit, description: e.target.value })}
          />
          <button
            className="msheet-item msheet-item-primary"
            disabled={!edit.title.trim()}
            onClick={() => {
              void upsert({
                id: edit.id,
                title: edit.title.trim(),
                priority: edit.priority,
                description: edit.description
              })
              setEdit(null)
            }}
          >
            {t('common.save')}
          </button>
        </MobileSheet>
      )}

      {confirmDone && (
        <ConfirmDialog
          title={t('roadmap.confirmDoneTitle')}
          message={t('roadmap.confirmDoneMessage', { title: confirmDone.title })}
          confirmLabel={t('roadmap.confirmDone')}
          onCancel={() => setConfirmDone(null)}
          onConfirm={() => {
            void applyMove(confirmDone, 'done')
            setConfirmDone(null)
          }}
        />
      )}

      {detail && (
        <RoadmapItemModal
          item={items.find((i) => i.id === detail.id) ?? detail}
          items={items}
          onClose={() => setDetail(null)}
          onEdit={() => {
            setEdit({
              id: detail.id,
              title: detail.title,
              priority: detail.priority,
              description: detail.description
            })
            setDetail(null)
          }}
          onLaunch={() => {
            setAssignItem(detail)
            setDetail(null)
          }}
          onStop={() => {
            void stop(detail)
            setDetail(null)
          }}
          onQueue={() => {
            void queueItem(detail)
            setDetail(null)
          }}
          onUnqueue={() => {
            void upsert({ id: detail.id, queue: null })
            setDetail(null)
          }}
          onArchive={() => {
            void archive(detail)
            setDetail(null)
          }}
          onRestore={() => {
            void upsert({ id: detail.id, status: 'planned' })
            setDetail(null)
          }}
          onAddDep={(parentId) => void addDep(detail.id, parentId)}
          onRemoveDep={(parentId) => void removeDep(detail.id, parentId)}
        />
      )}
    </div>
  )
}
