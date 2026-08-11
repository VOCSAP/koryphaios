import type { DisplayMode } from '@shared/types'
import { GLYPH_ACTIONS } from './icons'
import { useDeck } from '../store'
import { useT } from '../i18n'

// Short labels are language-neutral glyphs; the hover title carries the meaning.
const MODES: { mode: DisplayMode; label: string; titleKey: string }[] = [
  { mode: '1x1', label: '1×1', titleKey: 'modebar.1x1Title' },
  { mode: '1x2', label: '1×2', titleKey: 'modebar.1x2Title' },
  { mode: '2x2', label: '2×2', titleKey: 'modebar.2x2Title' },
  { mode: 'custom', label: 'X×Y', titleKey: 'modebar.customTitle' }
]

export function DisplayModeBar(): React.JSX.Element {
  const t = useT()
  const config = useDeck((s) => s.config!)
  const updateConfig = useDeck((s) => s.updateConfig)
  // The supervisor is never an agent tile: HomeView.tsx renders it directly
  // (`sessions.find((s) => s.supervisor)`), and TileArea.tsx filters it out
  // of the grid the same way (`allSessions.filter((s) => !s.supervisor)`) --
  // this count must match the grid it labels.
  const allSessions = useDeck((s) => s.sessions)
  const sessions = allSessions.filter((s) => !s.supervisor)
  const searchOpen = useDeck((s) => s.searchOpen)
  const openSearch = useDeck((s) => s.openSearch)

  const clamp = (n: number): number => (Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1)

  return (
    <div className="modebar">
      <div className="modebar-group">
        {MODES.map(({ mode, label, titleKey }) => (
          <button
            key={mode}
            className={`mode-btn ${config.displayMode === mode ? 'mode-btn-active' : ''}`}
            title={t(titleKey)}
            onClick={() => void updateConfig({ displayMode: mode })}
          >
            {label}
          </button>
        ))}
      </div>

      {config.displayMode === 'custom' && (
        <div className="modebar-custom">
          <input
            type="number"
            min={1}
            max={12}
            value={config.gridCols}
            title={t('modebar.columns')}
            onChange={(e) => void updateConfig({ gridCols: clamp(Number(e.target.value)) })}
          />
          <span className="modebar-x">×</span>
          <input
            type="number"
            min={1}
            max={12}
            value={config.gridRows}
            title={t('modebar.rows')}
            onChange={(e) => void updateConfig({ gridRows: clamp(Number(e.target.value)) })}
          />
        </div>
      )}

      <span className="modebar-spacer" />
      <button
        className={`mode-btn search-toggle ${searchOpen ? 'mode-btn-active' : ''}`}
        title={t('search.toggleTitle')}
        onClick={() => openSearch(!searchOpen)}
      >
        {GLYPH_ACTIONS.search}
      </button>
      <span className="modebar-count">
        {t(sessions.length === 1 ? 'modebar.countOne' : 'modebar.countOther', {
          n: sessions.length
        })}
      </span>
    </div>
  )
}
