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
  // Card 99d3a9eb, AC2: the priority chip's setPriority() write needs the
  // same gate as every other write path on this card -- reused below for
  // both the drag guard (arbitrage 2) and the chip's click guard.
  const closed = item.status === 'done' || item.status === 'archived'
  // Card 99d3a9eb, arbitrage 2: a closed card (done or archived) no longer
  // drags to another column -- 'archived' was already excluded, 'done' was
  // not (the exact gap the card measured).
  const draggable = !locked && !closed
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
          className={`rm-prio-chip rm-prio-${item.priority}${locked || closed ? ' rm-prio-chip-inert' : ''}`}
          role={locked || closed ? undefined : 'button'}
          title={
            locked || closed
              ? t(`roadmap.priority.${item.priority}`)
              : `${t(`roadmap.priority.${item.priority}`)} — ${t('roadmap.prioPick')}`
          }
          onClick={(e) => {
            e.stopPropagation()
            // Card 99d3a9eb, AC2: same gate as every other write path on a
            // closed/locked card -- this chip was the one entry point that
            // had none, a click straight on the card (not via right-click).
            if (locked || closed) return
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
        {/* Card 442084b7: operator-only park flag. Neither the lock glyph
            (an agent's own claim) nor the archive glyph/dimming (a lifecycle
            end-state) -- an extinguished torch reads as "deliberately set
            aside", distinct from both, and its own muted tone (--fg-dim)
            avoids lock's amber and queue's accent blue. */}
        {item.inactive && (
          <span className="rm-badge rm-badge-inactive" title={t('roadmap.inactiveHint')}>
            {GLYPH_BADGES.torchOut} {t('roadmap.inactiveBadge')}
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
   * the operator their whole backlog was gone. Card 442084b7 review B1: this
   * boolean must OR in every filtering dimension the caller applies to
   * `items` before this point -- `criteria` via hasActiveCriteria() AND the
   * client-side `hideInactive` toggle, not just the former. Missing one
   * dimension here reopens exactly this D1 defect for that one dimension.
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
  /**
   * Card f95ccfa6: passed the column's OWN already-filtered `rows` (never
   * `items` in full, never the unfiltered queue) -- the confirmation this
   * fires must announce exactly the population the operator can see, and
   * this component is the only one that HAS that filtered slice by the time
   * it is rendering the 'done' column's header.
   */
  onArchiveAll: (items: RoadmapItem[]) => void
  /** Card f95ccfa6, ajout 1: true for the whole loop, not just the confirm -- a second click before the batch finishes would re-fire the same N requests. */
  archiveAllBusy: boolean
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
  onArchiveAll,
  archiveAllBusy,
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
                {/* Card f95ccfa6: same placement precedent as the stop
                    controls above -- a column-scoped mass action belongs in
                    THAT column's own header, not the view's top bar. `rows`
                    here is this render's own already-filtered slice for
                    'done' (hideInactive + criteria both already applied
                    upstream), passed through unchanged so the confirmation
                    this fires announces exactly what the operator can see. */}
                {status === 'done' && rows.length > 0 && (
                  <button
                    type="button"
                    className="icon-btn rm-archive-all-btn"
                    title={t('roadmap.archiveAllHint')}
                    aria-label={t('roadmap.archiveAllHint')}
                    disabled={archiveAllBusy}
                    onClick={() => onArchiveAll(rows)}
                  >
                    {GLYPH_BADGES.archive}
                  </button>
                )}
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
