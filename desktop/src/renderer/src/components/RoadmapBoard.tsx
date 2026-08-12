import type { RoadmapItem, RoadmapPriority, RoadmapStatus } from '@shared/types'
import { AgentStopControls } from './AgentStopControls'
import { GLYPH_BADGES } from './icons'
import { KIND_ICONS, RoadmapItemId } from './RoadmapItemModal'
import { type TFn } from '../i18n'

// Card 3b0fda5f: the kanban board, extracted out of RoadmapView.tsx so it can
// sit next to the new filter panel/chips without RoadmapView itself growing
// further. Receives an ALREADY-FILTERED `items` prop (RoadmapView/roadmap-
// data.ts own the unfiltered list and the filter criteria) -- this component
// has no way to reach past what it was handed, by construction.

/** Column order of the board; 'archived' joins only when the toggle is on. */
export const BOARD_COLUMNS: RoadmapStatus[] = ['idea', 'planned', 'in_progress', 'done']
const PRIORITY_RANK: Record<RoadmapPriority, number> = { must: 0, should: 1, could: 2, wont: 3 }

/** True when the card is frozen by an agent's work-lock (PLAN K2). */
export function isLocked(item: RoadmapItem): boolean {
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
        {/* Short id first, Trello card-number position: the operator reads the
            board but agents address cards by id, so the link has to be on the
            miniature, not only in the detail modal. */}
        <RoadmapItemId item={item} t={t} />
        <span className={`rm-badge rm-badge-value-${item.value}`}>
          {t('roadmap.value')}: {t(`roadmap.level.${item.value}`)}
        </span>
        <span className={`rm-badge rm-badge-effort-${item.effort}`}>
          {t('roadmap.effort')}: {t(`roadmap.level.${item.effort}`)}
        </span>
        {item.queue !== null && (
          <span className="rm-badge rm-badge-queue" title={t('roadmap.queueSection')}>
            {GLYPH_BADGES.clepsydra} #{item.queue}
          </span>
        )}
        {locked && (
          <span className="rm-badge rm-badge-locked" title={t('roadmap.lockedHint')}>
            {GLYPH_BADGES.lock} {item.locked_by}
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

export interface RoadmapBoardProps {
  /** Already-filtered board slice (roadmap-data.ts's `board`), never the full queue. */
  items: RoadmapItem[]
  showArchived: boolean
  /**
   * Review round 3 (2026-08-10), MAJOR (D1): distinguishes "the roadmap has
   * zero items, full stop" from "these filters matched zero items" -- the two
   * used to share ONE message ("Add a feature/bug/debt/idea...") keyed only
   * off `items.length === 0`, so a narrow filter on a 115-card project told
   * the operator their whole backlog was gone.
   */
  hasActiveFilters: boolean
  onClearFilters: () => void
  loaded: boolean
  error: string | null
  dragId: string | null
  dropCol: RoadmapStatus | null
  onDragStartItem: (item: RoadmapItem) => void
  onDragEndItem: () => void
  onDragOverCol: (status: RoadmapStatus) => void
  onDragLeaveCol: (status: RoadmapStatus) => void
  onDropCol: (status: RoadmapStatus) => void
  onOpen: (item: RoadmapItem) => void
  onMenu: (item: RoadmapItem, x: number, y: number) => void
  onPrio: (item: RoadmapItem, x: number, y: number) => void
  t: TFn
}

export function RoadmapBoard({
  items,
  showArchived,
  hasActiveFilters,
  onClearFilters,
  loaded,
  error,
  dragId,
  dropCol,
  onDragStartItem,
  onDragEndItem,
  onDragOverCol,
  onDragLeaveCol,
  onDropCol,
  onOpen,
  onMenu,
  onPrio,
  t
}: RoadmapBoardProps): React.JSX.Element {
  const columns: RoadmapStatus[] = showArchived ? [...BOARD_COLUMNS, 'archived'] : BOARD_COLUMNS
  const columnItems = (status: RoadmapStatus): RoadmapItem[] =>
    items.filter((i) => i.status === status).sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])

  return (
    <>
      {error && <div className="roadmap-error">{t('roadmap.error', { error })}</div>}

      {loaded && items.length === 0 && !error && hasActiveFilters && (
        <p className="roadmap-empty">
          {t('roadmap.emptyFiltered')}{' '}
          <button type="button" className="rm-empty-clear-filters" onClick={onClearFilters}>
            {t('roadmap.filter.clearAll')}
          </button>
        </p>
      )}
      {loaded && items.length === 0 && !error && !hasActiveFilters && (
        <p className="roadmap-empty">{t('roadmap.empty')}</p>
      )}
      {loaded && items.length > 0 && (
        <p className="roadmap-shown-count">{t('roadmap.shownCount', { count: items.length })}</p>
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
                      onDragOverCol(status)
                    }
                  : undefined
              }
              onDragLeave={droppable ? () => onDragLeaveCol(status) : undefined}
              onDrop={droppable ? () => onDropCol(status) : undefined}
            >
              <h3 className={`rm-col-head rm-col-head-${status}`}>
                {t(`roadmap.status.${status}`)}
                <span className="rm-count">{rows.length}</span>
                {/* Card aaf4537d: the fleet stop controls belong to the column
                    that shows what is running, not to the view's top bar --
                    the operator halts what they are looking at. */}
                {status === 'in_progress' && <AgentStopControls t={t} />}
              </h3>
              <div className="rm-col-body">
                {rows.map((item) => (
                  <BoardCard
                    key={item.id}
                    item={item}
                    onOpen={() => onOpen(item)}
                    onMenu={(x, y) => onMenu(item, x, y)}
                    onPrio={(x, y) => onPrio(item, x, y)}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', item.id)
                      e.dataTransfer.effectAllowed = 'move'
                      onDragStartItem(item)
                    }}
                    onDragEnd={onDragEndItem}
                    t={t}
                  />
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </>
  )
}
