import { useState } from 'react'
import { inboxBadgeCount, roadmapConflictCount, useDeck } from '../store'
import { useT } from '../i18n'
import { MobileSheet } from './MobileSheet'
import { GLYPHS, GLYPH_BADGES } from './icons'
import { MOBILE_MORE, MOBILE_TABS, MOBILE_VIEWS } from '../mobile-views'
import type { DeckView } from '@shared/types'

// Bottom tab bar (PLAN MB3 — EXPLORATION §4 "Navigation générale"): 5 slots,
// Inbox promoted to a first-class tab (it IS the mobile notification center),
// the long tail (Journal, Worktrees, Settings) behind the ⋯ sheet. Which
// DeckView goes where is the single exhaustive registry in mobile-views.ts —
// Browser (webview) and Graph (canvas) are declared desktop-only there.

export function MobileNav(): React.JSX.Element {
  const t = useT()
  const view = useDeck((s) => s.view)
  const setView = useDeck((s) => s.setView)
  const inboxOpen = useDeck((s) => s.inboxOpen)
  const openInbox = useDeck((s) => s.openInbox)
  const openSettings = useDeck((s) => s.openSettings)
  const [moreOpen, setMoreOpen] = useState(false)

  const goto = (v: DeckView): void => {
    openInbox(false)
    setView(v)
  }
  // Same single producer as NavRail: this bar summed its own terms and so
  // missed the blocking-question count when NavRail gained it (card 8fdac3dd
  // review). A blocking question is the one family where an agent is stopped
  // waiting, so a mobile zero here was a confident lie.
  const badge = useDeck(inboxBadgeCount)
  // Same single producer as the rail: a conflict count that reached one bar
  // and not the other is exactly the divergence card 8fdac3dd fixed above.
  const conflicts = useDeck(roadmapConflictCount)

  return (
    <>
      <nav className="mnav">
        {MOBILE_TABS.map((id) => (
          <button
            key={id}
            className={`mnav-btn${view === id && !inboxOpen ? ' is-active' : ''}`}
            onClick={() => goto(id)}
          >
            <span className="mnav-icon">
              {GLYPHS[id]}
              {id === 'roadmap' && conflicts > 0 && (
                <span className="mnav-badge">{conflicts > 99 ? '99+' : conflicts}</span>
              )}
            </span>
            <span className="mnav-label">{t(MOBILE_VIEWS[id].labelKey)}</span>
          </button>
        ))}
        <button
          className={`mnav-btn${inboxOpen ? ' is-active' : ''}`}
          onClick={() => openInbox(!inboxOpen)}
        >
          <span className="mnav-icon">
            {GLYPHS.inbox}
            {badge > 0 && <span className="mnav-badge">{badge > 99 ? '99+' : badge}</span>}
          </span>
          <span className="mnav-label">{t('nav.inbox')}</span>
        </button>
        <button className="mnav-btn" onClick={() => setMoreOpen(true)}>
          <span className="mnav-icon">{GLYPHS.more}</span>
          <span className="mnav-label">{t('mobile.more')}</span>
        </button>
      </nav>
      {moreOpen && (
        <MobileSheet onClose={() => setMoreOpen(false)} title={t('mobile.more')}>
          {MOBILE_MORE.map((id) => (
            <button
              key={id}
              className="msheet-item"
              onClick={() => {
                goto(id)
                setMoreOpen(false)
              }}
            >
              <span className="msheet-icon">{GLYPHS[id]}</span> {t(MOBILE_VIEWS[id].labelKey)}
            </button>
          ))}
          {/* Settings is an overlay, not a DeckView — kept explicit here. */}
          <button
            className="msheet-item"
            onClick={() => {
              openSettings(true)
              setMoreOpen(false)
            }}
          >
            <span className="msheet-icon">{GLYPH_BADGES.gear}</span> {t('settings.title')}
          </button>
        </MobileSheet>
      )}
    </>
  )
}
