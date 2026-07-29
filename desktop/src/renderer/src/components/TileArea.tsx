import { useRef } from 'react'
import type { DisplayMode } from '@shared/types'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { TerminalTile } from './TerminalTile'
import { GLYPH_ACTIONS } from './icons'

/** Visible columns/rows for the grid modes (1x1 is rendered as a carousel). */
function gridShape(mode: DisplayMode, cols: number, rows: number): { cols: number; rows: number } {
  switch (mode) {
    case '1x2':
      return { cols: 2, rows: 1 }
    case '2x2':
      return { cols: 2, rows: 2 }
    case 'custom':
      return { cols: Math.max(1, cols), rows: Math.max(1, rows) }
    default:
      return { cols: 1, rows: 1 }
  }
}

/**
 * Placeholder standing in for an agent whose PTY does not exist yet. In sandbox
 * mode the spawn waits on the container gate, which used to leave the click
 * with no visible effect at all for seconds.
 */
function PendingTile({ label }: { label: string }): React.JSX.Element {
  return (
    <section className="tile tile-pending">
      <div className="tile-pending-body">
        <span className="sandbox-spinner">{GLYPH_ACTIONS.refresh}</span>
        <span>{label}</span>
      </div>
    </section>
  )
}

export function TileArea(): React.JSX.Element {
  const t = useT()
  const pending = useDeck((s) => s.pendingSessions)
  const pendingTiles = Array.from({ length: pending }, (_, i) => (
    <PendingTile key={`pending-${i}`} label={t('area.spawning')} />
  ))
  const allSessions = useDeck((s) => s.sessions)
  // The supervisor renders in the Home view, never in the agents grid.
  const sessions = allSessions.filter((s) => !s.supervisor)
  const config = useDeck((s) => s.config!)
  const maximizedId = useDeck((s) => s.maximizedId)
  const createSession = useDeck((s) => s.createSession)
  const workspaces = useDeck((s) => s.workspaces)
  const templates = useDeck((s) => s.templates)
  const restoreWorkspace = useDeck((s) => s.restoreWorkspace)
  const openWorkspaces = useDeck((s) => s.openWorkspaces)
  const openTemplates = useDeck((s) => s.openTemplates)
  const carouselRef = useRef<HTMLDivElement>(null)

  // The very first agent has no grid to appear in yet: the placeholder replaces
  // the empty card, otherwise the operator keeps looking at "add an agent".
  if (sessions.length === 0 && pending > 0) {
    return <main className="area area-grid area-grid-single">{pendingTiles}</main>
  }

  if (sessions.length === 0) {
    const previous = workspaces[0]
    return (
      <main className="area area-empty">
        <div className="empty-card">
          <h2>{t('area.emptyTitle')}</h2>
          <p>{t('area.emptyBody')}</p>
          <div className="empty-actions">
            <button className="primary" onClick={() => void createSession({})}>
              {t('area.addTerminal')}
            </button>
            {previous && (
              <button className="restore-prev" onClick={() => void restoreWorkspace(previous.id)}>
                {t('area.restorePrevious')}
              </button>
            )}
            {/* The open-workspaces arrow only makes sense when a workspace exists
                to restore -- aligned with the Restore-previous button above. */}
            {previous && (
              <button
                className="restore-prev empty-open-ws"
                title={t('area.openWorkspacesTitle')}
                onClick={() => openWorkspaces(true, { loadOnly: true })}
              >
                {GLYPH_ACTIONS.forward}
              </button>
            )}
            {/* Use-template only when at least one template exists. */}
            {templates.length > 0 && (
              <button className="use-template-btn" onClick={() => openTemplates(true)}>
                {t('area.useTemplate')}
              </button>
            )}
          </div>
        </div>
      </main>
    )
  }

  // Maximized: a single tile fills the area; the rest stay mounted but hidden.
  if (maximizedId) {
    return (
      <main className="area area-maximized">
        {sessions.map((s) => (
          <TerminalTile key={s.id} session={s} hidden={s.id !== maximizedId} />
        ))}
      </main>
    )
  }

  // 1x1 = horizontal carousel: one tile per view, wheel scrolls sideways.
  if (config.displayMode === '1x1') {
    return (
      <main
        className="area area-carousel"
        ref={carouselRef}
        onWheel={(e) => {
          if (carouselRef.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            carouselRef.current.scrollLeft += e.deltaY
          }
        }}
      >
        {sessions.map((s) => (
          <TerminalTile key={s.id} session={s} hidden={false} />
        ))}
        {pendingTiles}
      </main>
    )
  }

  // Grid modes: cols x rows visible, extra tiles overflow vertically.
  const { cols, rows } = gridShape(config.displayMode, config.gridCols, config.gridRows)
  return (
    <main
      className="area area-grid"
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridAutoRows: `calc((100% - ${rows - 1} * var(--gap)) / ${rows})`
      }}
    >
      {sessions.map((s) => (
        <TerminalTile key={s.id} session={s} hidden={false} />
      ))}
      {pendingTiles}
    </main>
  )
}
