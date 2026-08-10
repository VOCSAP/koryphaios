import { useRef } from 'react'
import type { DisplayMode, WorkspaceSummary } from '@shared/types'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { TerminalTile } from './TerminalTile'
import { GLYPH_ACTIONS } from './icons'

/**
 * The workspace the "restore previous" button/chevron should offer: not
 * locked by another live instance, and actually has sessions to respawn
 * (`workspaces[0]` alone, the previous behavior, could pick a locked or
 * empty/dead entry, leaving the button clickable and functionally dead --
 * b8d65b24). The CURRENT workspace is only a candidate when the deck has no
 * live agent session left: an empty deck is itself a fresh start, so
 * "restore what I just had" is exactly the operator's main use case there
 * (b8d65b24 follow-up, operator arbitration); with any agent still running,
 * restoring `current` would kill it for no replacement, so it stays excluded
 * exactly like `locked`. `liveAgentCount` is a PARAMETER, not a store read,
 * so this stays pure and testable without mounting the store -- pass the
 * caller's own supervisor-excluded count (same population `captureSessions()`
 * uses), never a second definition of "live" computed here. Pure and
 * exported so the rule is pinned by a unit test instead of only exercised
 * via JSX.
 */
export function pickRestorable(
  workspaces: WorkspaceSummary[],
  liveAgentCount: number
): WorkspaceSummary | undefined {
  return workspaces.find((w) => {
    if (w.locked || w.sessionCount === 0) return false
    return w.current ? liveAgentCount === 0 : true
  })
}

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

  // Hoisted above the three tile-rendering returns below (maximized/carousel/
  // grid, 903ee271): all three must pass an IDENTICAL children shape, because
  // React's implicit key path is derived from a JSX subtree's structural
  // position, not just each element's own `key`. Building this array once and
  // reusing it verbatim in `{children}` keeps that shape identical across a
  // maximize/un-maximize transition, so TerminalTile stays mounted (its PTY
  // and scrollback survive) instead of unmounting/remounting on every switch.
  // Maximized never showed pending-spawn placeholders before this hoist (the
  // old maximized return had no pendingTiles at all) -- keep that behavior by
  // nulling the slot rather than omitting it: `null` still occupies the
  // second children position, so the shape (and therefore the reconciliation
  // path) stays identical across branches; omitting it conditionally would
  // reintroduce the remount bug this hoist fixes.
  const children = (
    <>
      {sessions.map((s) => (
        <TerminalTile key={s.id} session={s} hidden={maximizedId ? s.id !== maximizedId : false} />
      ))}
      {maximizedId ? null : pendingTiles}
    </>
  )

  // The very first agent has no grid to appear in yet: the placeholder replaces
  // the empty card, otherwise the operator keeps looking at "add an agent".
  if (sessions.length === 0 && pending > 0) {
    return <main className="area area-grid area-grid-single">{pendingTiles}</main>
  }

  if (sessions.length === 0) {
    const previous = pickRestorable(workspaces, sessions.length)
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
      <main className="area area-maximized">{children}</main>
    )
  }

  // 1x1 = horizontal carousel: one tile per view, wheel scrolls sideways.
  if (config.displayMode === '1x1') {
    return (
      <main
        className="area area-carousel"
        ref={carouselRef}
        onWheel={(e) => {
          // A wheel over the terminal surface belongs to xterm's own scroll
          // (scrollback), not the carousel -- xterm can't stop it itself
          // (cancelEvents stays false: turning it on would stopPropagation()
          // every mouse/key event, silencing Ctrl+Shift+F / Ctrl+Shift+M in
          // App.tsx), so the carousel filters at the source instead (1d6abfd2).
          // `.tile-body` is, as of this fix, the ONLY scrollable descendant a
          // tile renders -- a new scrollable area added elsewhere in a tile
          // later would slip past this selector silently. Verifiable, and
          // meant to be checked by whoever adds the next one.
          if ((e.target as HTMLElement).closest('.tile-body')) return
          if (carouselRef.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            carouselRef.current.scrollLeft += e.deltaY
          }
        }}
      >
        {children}
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
      {children}
    </main>
  )
}
