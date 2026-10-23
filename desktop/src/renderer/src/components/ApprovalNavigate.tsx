import type { Approval } from '@shared/types'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { resolveApprovalSender } from '../inbox-sender'
import { GLYPH_ACTIONS } from './icons'

/** Deck-only: jumps to the requesting tile, so the store-free inbox receives it as a slot. */
export function ApprovalNavigate({
  approval,
  onNavigated
}: {
  approval: Pick<Approval, 'origin'>
  onNavigated: () => void
}): React.JSX.Element {
  const t = useT()
  const sessions = useDeck((s) => s.sessions)
  const focusTile = useDeck((s) => s.focusTile)
  const ref = approval.origin.tile_ref
  // tile_ref is agent supplied: only an exact live tile is followed, never a guess.
  const target = resolveApprovalSender(ref, sessions).resolved ? ref : null

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
