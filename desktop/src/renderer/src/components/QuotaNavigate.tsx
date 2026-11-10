import { limitedSessionIds } from '../../../shared/quota-notice'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { GLYPH_ACTIONS } from './icons'

/** Deck-only: jumps to the first tile still in a quota episode, so the store-free inbox receives it as a slot. */
export function QuotaNavigate({ onNavigated }: { onNavigated: () => void }): React.JSX.Element {
  const t = useT()
  const sessions = useDeck((s) => s.sessions)
  const focusTile = useDeck((s) => s.focusTile)
  const target = limitedSessionIds(sessions)[0] ?? null

  return (
    <div className="inbox-modal-goto">
      <button
        type="button"
        className="btn btn-sm inbox-goto-btn"
        disabled={!target}
        onClick={() => {
          if (!target) return
          onNavigated()
          focusTile(target)
        }}
      >
        {GLYPH_ACTIONS.forward}
        {t('inbox.navigate')}
      </button>
      {!target && <span className="inbox-goto-reason">{t('inbox.navigateUnavailable')}</span>}
    </div>
  )
}
