import type { Approval } from '@shared/types'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { resolveApprovalSender } from '../inbox-sender'
import { GLYPH_ACTIONS, GLYPH_BADGES } from './icons'
import { displayApprovalText, splitCommandLine } from './approval-display'

interface Props {
  approval: Pick<Approval, 'kind' | 'question'>
  danger?: string | null
  className: string
}

export function ApprovalRequestBody({ approval, danger, className }: Props): React.JSX.Element {
  const t = useT()
  const text = displayApprovalText(approval.question)
  if (approval.kind !== 'permission') return <div className={className}>{text}</div>

  const { head, rest } = splitCommandLine(text)
  return (
    <>
      <div className={`${className} approval-command`}>
        <div className="approval-command-head">{head}</div>
        {rest && <div className="approval-command-rest">{rest}</div>}
      </div>
      <div className="approval-signal">
        {danger && (
          <span className="approval-danger-badge">
            {GLYPH_BADGES.warning}
            {t('inbox.dangerBadge')}
            <code>{danger}</code>
          </span>
        )}
        {/* Unconditional: a missing badge must never read as "checked and safe". */}
        <span className="approval-signal-legend">{t('inbox.signalLegend')}</span>
      </div>
    </>
  )
}

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
