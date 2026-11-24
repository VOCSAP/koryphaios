import type { ReactNode } from 'react'
import type { Approval, ApprovalTextFlag, DangerView, DangerViewEntry } from '@shared/types'
import type { TFn } from '../i18n'
import { GLYPH_BADGES } from './icons'
import { displayApprovalText, splitCommandLine } from './approval-display'

interface Props {
  t: TFn
  approval: Pick<Approval, 'kind' | 'question'> & { text_flags?: ApprovalTextFlag[] }
  /** The Deck's own reading of the risky patterns; the agent-sent `danger` list is never shown. */
  dangerView?: DangerView
  className: string
  /** How a question's agent-written text is shown: the Deck makes its links clickable, another host may not. */
  renderText: (text: string) => ReactNode
}

const TEXT_FLAG_LABELS = {
  bidi: 'inbox.textFlagBidi',
  control: 'inbox.textFlagControl',
  invisible: 'inbox.textFlagInvisible'
} as const

function TextFlagsBadge({ t, flags }: { t: TFn; flags: ApprovalTextFlag[] }): React.JSX.Element {
  return (
    <span className="approval-danger-badge approval-text-flags">
      {GLYPH_BADGES.warning}
      {t('inbox.textFlagsBadge')}
      <code>{flags.map((flag) => t(TEXT_FLAG_LABELS[flag])).join(', ')}</code>
    </span>
  )
}

const VOICE_KEYS = {
  kory: 'inbox.dangerVoiceKory',
  user: 'inbox.dangerVoiceUser',
  repo: 'inbox.dangerVoiceRepo'
} as const

function DangerRow({ t, entry }: { t: TFn; entry: DangerViewEntry }): React.JSX.Element {
  return (
    <span className="approval-danger-row">
      {/* An id this Deck cannot vouch for is never drawn in the danger colour. */}
      <span className={entry.known ? 'approval-danger-badge' : 'approval-danger-badge approval-danger-unknown'}>
        {GLYPH_BADGES.warning}
        {t('inbox.dangerBadge')}
        <code>{entry.id}</code>
      </span>
      <span className="approval-danger-note">
        {!entry.known || entry.message === null
          ? t('inbox.dangerUnknownKory')
          : t(entry.messageFrom === 'agent' ? 'inbox.dangerVoiceAgent' : VOICE_KEYS[entry.source], {
              message: displayApprovalText(entry.message)
            })}
      </span>
      {!entry.confirmed && (
        <span className="approval-danger-note approval-danger-unconfirmed">{t('inbox.dangerUnconfirmed')}</span>
      )}
    </span>
  )
}

export function ApprovalRequestBody({ t, approval, dangerView, className, renderText }: Props): React.JSX.Element {
  const text = displayApprovalText(approval.question)
  const flags = approval.text_flags ?? []
  if (approval.kind !== 'permission') {
    return (
      <>
        <div className={className}>{renderText(text)}</div>
        {flags.length > 0 && (
          <div className="approval-signal">
            <TextFlagsBadge t={t} flags={flags} />
          </div>
        )}
      </>
    )
  }

  const { head, rest } = splitCommandLine(text)
  return (
    <>
      <div className={`${className} approval-command`}>
        <div className="approval-command-head">{head}</div>
        {rest && <div className="approval-command-rest">{rest}</div>}
      </div>
      <div className="approval-signal">
        {flags.length > 0 && <TextFlagsBadge t={t} flags={flags} />}
        {dangerView?.entries.map((entry) => <DangerRow key={entry.id} t={t} entry={entry} />)}
        {dangerView && dangerView.reevaluation !== 'done' && (
          <span className="approval-danger-recheck">
            {t(dangerView.reevaluation === 'partial' ? 'inbox.dangerRecheckPartial' : 'inbox.dangerRecheckUnavailable')}
          </span>
        )}
        {/* Unconditional: a missing badge must never read as "checked and safe". */}
        <span className="approval-signal-legend">{t('inbox.signalLegend')}</span>
      </div>
    </>
  )
}
