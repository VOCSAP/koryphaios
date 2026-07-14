import { useDeck } from '../store'
import { useT } from '../i18n'
import type { DeckView } from '@shared/types'

// Vertical navigation rail (VS Code activity-bar style), left of everything.
// Home = the supervisor session (C5), Agents = the session tiles, Roadmap = C3.
const VIEWS: { id: DeckView; icon: string; key: string }[] = [
  { id: 'home', icon: '🏠', key: 'nav.home' },
  { id: 'agents', icon: '🖥', key: 'nav.agents' },
  { id: 'roadmap', icon: '🗺', key: 'nav.roadmap' }
]

export function NavRail(): React.JSX.Element {
  const t = useT()
  const view = useDeck((s) => s.view)
  const setView = useDeck((s) => s.setView)

  return (
    <nav className="nav-rail">
      {VIEWS.map((v) => (
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
    </nav>
  )
}
