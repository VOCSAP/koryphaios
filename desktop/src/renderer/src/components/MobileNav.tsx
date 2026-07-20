import { useState } from 'react'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { MobileSheet } from './MobileSheet'
import type { DeckView } from '@shared/types'

// Bottom tab bar (PLAN MB3 — EXPLORATION §4 "Navigation générale"): 5 slots,
// Inbox promoted to a first-class tab (it IS the mobile notification center),
// the long tail (Journal, Worktrees, Settings) behind the ⋯ sheet. Browser
// (webview, Electron-only) and Graph (canvas, desktop-first) are absent in v1.
const TABS: { id: DeckView; icon: string; key: string }[] = [
  { id: 'home', icon: '🏠', key: 'nav.home' },
  { id: 'agents', icon: '🖥', key: 'nav.agents' },
  { id: 'roadmap', icon: '🗺', key: 'nav.roadmap' }
]

export function MobileNav(): React.JSX.Element {
  const t = useT()
  const view = useDeck((s) => s.view)
  const setView = useDeck((s) => s.setView)
  const inboxOpen = useDeck((s) => s.inboxOpen)
  const inboxUnread = useDeck((s) => s.inboxUnread)
  const openInbox = useDeck((s) => s.openInbox)
  const openSettings = useDeck((s) => s.openSettings)
  const draftCount = useDeck((s) => s.graphDrafts.length)
  const [moreOpen, setMoreOpen] = useState(false)

  const goto = (v: DeckView): void => {
    openInbox(false)
    setView(v)
  }
  const badge = inboxUnread + draftCount

  return (
    <>
      <nav className="mnav">
        {TABS.map(({ id, icon, key }) => (
          <button
            key={id}
            className={`mnav-btn${view === id && !inboxOpen ? ' is-active' : ''}`}
            onClick={() => goto(id)}
          >
            <span className="mnav-icon">{icon}</span>
            <span className="mnav-label">{t(key)}</span>
          </button>
        ))}
        <button
          className={`mnav-btn${inboxOpen ? ' is-active' : ''}`}
          onClick={() => openInbox(!inboxOpen)}
        >
          <span className="mnav-icon">
            ✉{badge > 0 && <span className="mnav-badge">{badge > 99 ? '99+' : badge}</span>}
          </span>
          <span className="mnav-label">{t('nav.inbox')}</span>
        </button>
        <button className="mnav-btn" onClick={() => setMoreOpen(true)}>
          <span className="mnav-icon">⋯</span>
          <span className="mnav-label">{t('mobile.more')}</span>
        </button>
      </nav>
      {moreOpen && (
        <MobileSheet onClose={() => setMoreOpen(false)} title={t('mobile.more')}>
          <button
            className="msheet-item"
            onClick={() => {
              goto('worktrees')
              setMoreOpen(false)
            }}
          >
            ⎇ {t('nav.worktrees')}
          </button>
          <button
            className="msheet-item"
            onClick={() => {
              goto('journal')
              setMoreOpen(false)
            }}
          >
            📜 {t('nav.journal')}
          </button>
          <button
            className="msheet-item"
            onClick={() => {
              openSettings(true)
              setMoreOpen(false)
            }}
          >
            ⚙ {t('settings.title')}
          </button>
        </MobileSheet>
      )}
    </>
  )
}
