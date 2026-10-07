import { useState, type ReactNode } from 'react'
import { errorText, useDeck, type InboxApproval } from '../store'
import { useT } from '../i18n'
import { ApprovalAnswerForm } from './ApprovalAnswerForm'

type HookAction =
  | { kind: 'allow' }
  | { kind: 'deny' }
  | { kind: 'handback' }
  | { kind: 'answers'; answers: Record<string, string[]> }

interface Props {
  /** A row on reply_route 'hook': the module waits on it, nothing is typed into a terminal. */
  approval: InboxApproval
  actionsClassName: string
  /** Called once the row is settled here or elsewhere; the host closes what it opened. */
  onSettled?: () => void
  /** Host buttons placed between the handback and the answering buttons. */
  children?: ReactNode
}

/**
 * The one place a module-served request is claimed, whichever host shows it
 * (the Courrier modal, the tile panel): same IPC primitives, same toasts, same
 * draft, so the two can never answer differently. The host decides whether
 * verdicts may be offered at all (canAnswerVerdict).
 */
export function HookApprovalAnswer(props: Props): React.JSX.Element {
  const t = useT()
  const { approval } = props
  const draft = useDeck((s) => s.approvalDrafts[approval.id])
  const setApprovalDraft = useDeck((s) => s.setApprovalDraft)
  const clearPendingApproval = useDeck((s) => s.clearPendingApproval)
  const showToast = useDeck((s) => s.showToast)
  const [sending, setSending] = useState(false)

  const answer = async (action: HookAction): Promise<void> => {
    if (sending) return
    setSending(true)
    try {
      const ok =
        action.kind === 'deny'
          ? await window.api.approvalDecline(approval.id)
          : action.kind === 'allow'
            ? await window.api.approvalAllow(approval.id)
            : action.kind === 'handback'
              ? await window.api.approvalHandback(approval.id)
              : await window.api.approvalAnswers(approval.id, action.answers)
      // `false` is not a failure: another channel (phone, Telegram…) won the
      // race and the agent is already released.
      showToast(
        ok ? (action.kind === 'handback' ? 'toast.inboxHandedBack' : 'toast.inboxAnswerSent') : 'toast.inboxAnsweredElsewhere',
        ok ? 'success' : 'info'
      )
      setApprovalDraft(approval.id, null)
      clearPendingApproval(approval.id)
      props.onSettled?.()
    } catch (e) {
      const msg = errorText(e)
      if (msg.includes('remote-blocked')) showToast('inbox.verdictRemoteBlocked', 'error')
      else
        showToast(`${t(action.kind === 'answers' ? 'inbox.answersFailed' : 'inbox.reply')}: ${msg}`, 'error', {
          raw: true
        })
    } finally {
      setSending(false)
    }
  }

  return (
    <ApprovalAnswerForm
      approval={approval}
      disabled={sending}
      draft={draft}
      onDraft={(d) => setApprovalDraft(approval.id, d)}
      onAllow={() => void answer({ kind: 'allow' })}
      onDeny={() => void answer({ kind: 'deny' })}
      onAnswers={(answers) => void answer({ kind: 'answers', answers })}
      onHandback={() => void answer({ kind: 'handback' })}
      actionsClassName={props.actionsClassName}
    >
      {props.children}
    </ApprovalAnswerForm>
  )
}
