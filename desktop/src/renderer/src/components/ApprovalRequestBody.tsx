import type { ReactNode } from 'react'
import type { Approval } from '@shared/types'
import type { TFn } from '../i18n'
import { GLYPH_BADGES } from './icons'
import { displayApprovalText, splitCommandLine } from './approval-display'

interface Props {
  t: TFn
  approval: Pick<Approval, 'kind' | 'question'>
  danger?: string | null
  className: string
  /** How a question's agent-written text is shown: the Deck makes its links clickable, another host may not. */
  renderText: (text: string) => ReactNode
}

export function ApprovalRequestBody({ t, approval, danger, className, renderText }: Props): React.JSX.Element {
  const text = displayApprovalText(approval.question)
  if (approval.kind !== 'permission') {
    return <div className={className}>{renderText(text)}</div>
  }

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
