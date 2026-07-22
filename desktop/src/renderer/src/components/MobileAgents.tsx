import { useRef } from 'react'
import { GLYPH_ACTIONS, GLYPH_BADGES } from './icons'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { TerminalTile } from './TerminalTile'
import { KeyBar } from './KeyBar'

// Mobile agents view (PLAN MB3 — EXPLORATION §4): a PAGER. One session fills
// the screen; a chip row switches (color dot + attention/quota badges); a
// horizontal swipe on the pager moves prev/next. All tiles stay MOUNTED
// (hidden pattern) exactly like the desktop maximized mode, so xterm
// scrollback survives switching.

export function MobileAgents(): React.JSX.Element {
  const t = useT()
  const allSessions = useDeck((s) => s.sessions)
  const sessions = allSessions.filter((s) => !s.supervisor)
  const selectedId = useDeck((s) => s.selectedId)
  const setSelected = useDeck((s) => s.setSelected)
  const createSession = useDeck((s) => s.createSession)
  const touch = useRef<{ x: number; y: number } | null>(null)

  const current = sessions.find((s) => s.id === selectedId) ?? sessions[0] ?? null

  const step = (dir: 1 | -1): void => {
    if (!current) return
    const idx = sessions.findIndex((s) => s.id === current.id)
    const next = sessions[idx + dir]
    if (next) setSelected(next.id)
  }

  if (sessions.length === 0) {
    return (
      <main className="area area-empty">
        <div className="empty-card">
          <h2>{t('area.emptyTitle')}</h2>
          <div className="empty-actions">
            <button className="primary" onClick={() => void createSession({})}>
              {t('area.addTerminal')}
            </button>
          </div>
        </div>
      </main>
    )
  }

  return (
    <div className="mpager">
      <div className="mchips">
        {sessions.map((s) => (
          <button
            key={s.id}
            className={`mchip${current?.id === s.id ? ' is-active' : ''}`}
            style={{ '--chip-color': s.color } as React.CSSProperties}
            onClick={() => setSelected(s.id)}
          >
            <span className="mchip-dot" />
            {s.name}
            {s.needsAttention && <span className="mchip-flag">{GLYPH_BADGES.warning}</span>}
            {s.rateLimited && <span className="mchip-flag">{GLYPH_BADGES.clepsydra}</span>}
          </button>
        ))}
        <button className="mchip mchip-add" onClick={() => void createSession({})}>
          {GLYPH_ACTIONS.plus}
        </button>
      </div>
      <div
        className="mpager-tile"
        onTouchStart={(e) => {
          const t0 = e.touches[0]
          if (t0) touch.current = { x: t0.clientX, y: t0.clientY }
        }}
        onTouchEnd={(e) => {
          const start = touch.current
          touch.current = null
          const t1 = e.changedTouches[0]
          if (!start || !t1) return
          const dx = t1.clientX - start.x
          const dy = t1.clientY - start.y
          // Deliberate horizontal fling only: dominant axis + real distance,
          // so terminal scrolling and taps never page by accident.
          if (Math.abs(dx) > 80 && Math.abs(dx) > 2 * Math.abs(dy)) {
            step(dx < 0 ? 1 : -1)
          }
        }}
      >
        {sessions.map((s) => (
          <TerminalTile key={s.id} session={s} hidden={s.id !== (current?.id ?? '')} />
        ))}
      </div>
      <KeyBar sessionId={current?.id ?? null} />
    </div>
  )
}
