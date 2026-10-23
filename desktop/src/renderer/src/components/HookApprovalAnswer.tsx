import { useRef, useState, type ReactNode } from 'react'
import { errorText, useDeck, type InboxApproval } from '../store'
import { useT } from '../i18n'
import { ApprovalAnswerForm } from './ApprovalAnswerForm'

export type HookAnswerAction =
  | { kind: 'allow' }
  | { kind: 'deny' }
  | { kind: 'handback' }
  | { kind: 'answers'; answers: Record<string, string[]> }

interface Props {
  /** A row on reply_route 'hook': the module waits on it, nothing is typed into a terminal. */
  approval: InboxApproval
  actionsClassName: string
  onSettled?: (ok: boolean) => void
  /** Host buttons placed between the handback and the answering buttons. */
  children?: ReactNode
}

/**
 * The one place a module-served request is claimed, whichever Deck host shows
 * it (the Courrier modal, the tile panel): same IPC primitives, same toasts,
 * same draft, so the two can never answer differently. Resolves to the
 * broker's `ok` once settled (false: another channel won the race), or null
 * when the call failed, already reported to the operator.
 */
export function useHookApprovalSettle(): (approvalId: string, action: HookAnswerAction) => Promise<boolean | null> {
  const t = useT()
  const setApprovalDraft = useDeck((s) => s.setApprovalDraft)
  const clearPendingApproval = useDeck((s) => s.clearPendingApproval)
  const showToast = useDeck((s) => s.showToast)

  return async (approvalId, action) => {
    try {
      const ok =
        action.kind === 'deny'
          ? await window.api.approvalDecline(approvalId)
          : action.kind === 'allow'
            ? await window.api.approvalAllow(approvalId)
            : action.kind === 'handback'
              ? await window.api.approvalHandback(approvalId)
              : await window.api.approvalAnswers(approvalId, action.answers)
      // `false` is not a failure: another channel (phone, Telegram…) won the
      // race and the agent is already released.
      showToast(
        ok ? (action.kind === 'handback' ? 'toast.inboxHandedBack' : 'toast.inboxAnswerSent') : 'toast.inboxAnsweredElsewhere',
        ok ? 'success' : 'info'
      )
      setApprovalDraft(approvalId, null)
      clearPendingApproval(approvalId)
      return ok
    } catch (e) {
      const msg = errorText(e)
      window.api.reportError('inbox', `hook answer '${action.kind}' on ${approvalId} failed: ${msg}`)
      if (msg.includes('remote-blocked')) showToast('inbox.verdictRemoteBlocked', 'error')
      else
        showToast(`${t(action.kind === 'answers' ? 'inbox.answersFailed' : 'inbox.reply')}: ${msg}`, 'error', {
          raw: true
        })
      return null
    }
  }
}

/** The host decides whether verdicts may be offered at all (canAnswerVerdict). */
export function HookApprovalAnswer(props: Props): React.JSX.Element {
  const t = useT()
  const { approval } = props
  const draft = useDeck((s) => s.approvalDrafts[approval.id])
  const setApprovalDraft = useDeck((s) => s.setApprovalDraft)
  const settle = useHookApprovalSettle()
  const [sending, setSending] = useState(false)
  const inFlight = useRef(false)

  const answer = async (action: HookAnswerAction): Promise<void> => {
    // A ref, not `sending`: two gestures in one tick both read the stale state.
    if (inFlight.current) return
    inFlight.current = true
    setSending(true)
    try {
      const ok = await settle(approval.id, action)
      if (ok !== null) props.onSettled?.(ok)
    } finally {
      inFlight.current = false
      setSending(false)
    }
  }

  return (
    <ApprovalAnswerForm
      t={t}
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
