import { useDeck } from '../store'
import { useT } from '../i18n'
import type { DeckView } from '@shared/types'

// Vertical navigation rail (VS Code activity-bar style), left of everything.
// Home = the supervisor session (C5), Agents = the session tiles, Roadmap = C3.
const VIEWS: { id: DeckView; icon: string; key: string }[] = [
  { id: 'home', icon: '🏠', key: 'nav.home' },
  { id: 'agents', icon: '🖥', key: 'nav.agents' },
  { id: 'browser', icon: '🌐', key: 'nav.browser' },
  { id: 'roadmap', icon: '🗺', key: 'nav.roadmap' },
  { id: 'graph', icon: '🕸', key: 'nav.graph' },
  { id: 'worktrees', icon: '⎇', key: 'nav.worktrees' },
  { id: 'journal', icon: '📜', key: 'nav.journal' }
]

export function NavRail(): React.JSX.Element {
  const t = useT()
  const view = useDeck((s) => s.view)
  const setView = useDeck((s) => s.setView)
  const inboxOpen = useDeck((s) => s.inboxOpen)
  const inboxUnread = useDeck((s) => s.inboxUnread)
  const openInbox = useDeck((s) => s.openInbox)
  const draftCount = useDeck((s) => s.graphDrafts.length)
  // Attention badge = unread messages + pending drafts; the glyph GLOW is
  // drafts-only (an action is awaited, not just a message to read).
  const badge = inboxUnread + draftCount

  const remote = useDeck((s) => s.remote)
  const companionOpen = useDeck((s) => s.companionOpen)
  const openCompanion = useDeck((s) => s.openCompanion)
  const companionRunning = useDeck((s) => s.companionRunning)

  // The embedded browser is a <webview>, Electron-only — hidden for a remote
  // client (EXPLORATION §3); the Compagnon button is a physical-presence
  // action, desktop window only.
  const views = remote ? VIEWS.filter((v) => v.id !== 'browser') : VIEWS

  return (
    <nav className="nav-rail">
      {views.map((v) => (
        <button
          key={v.id}
          className={`nav-rail-item${view === v.id ? ' is-active' : ''}`}
          title={t(v.key)}
          onClick={() => setView(v.id)}
        >
          <span className="nav-rail-icon">{v.icon}</span>
          <span className="nav-rail-label">{t(v.key)}</span>
        </button>
      ))}
      <div className="nav-rail-spacer" />
      {!remote && (
        <button
          className={`nav-rail-item${companionOpen ? ' is-active' : ''}${companionRunning ? ' is-glowing' : ''}`}
          title={t('companion.title')}
          onClick={() => openCompanion(!companionOpen)}
        >
          <span className="nav-rail-icon">📱</span>
          <span className="nav-rail-label">{t('companion.title')}</span>
        </button>
      )}
      {/* Operator inbox (PLAN C12): overlay panel, not a view. */}
      <button
        className={`nav-rail-item${inboxOpen ? ' is-active' : ''}${draftCount > 0 ? ' is-glowing' : ''}`}
        title={t('nav.inbox')}
        onClick={() => openInbox(!inboxOpen)}
      >
        <span className="nav-rail-icon">
          ✉
          {badge > 0 && <span className="nav-rail-badge">{badge}</span>}
        </span>
        <span className="nav-rail-label">{t('nav.inbox')}</span>
      </button>
    </nav>
  )
}
