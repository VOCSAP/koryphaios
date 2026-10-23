import { errorText, useDeck } from '../store'
import { useT } from '../i18n'
import { resolveApprovalSender } from '../inbox-sender'
import { linkedText } from './LinkedText'
import { ApprovalNavigate } from './ApprovalNavigate'
import { useHookApprovalSettle } from './HookApprovalAnswer'
import { canAnswerVerdict as verdictAllowed } from './verdict-remote'
import {
  InboxCore,
  type InboxActionOutcome,
  type InboxAnswerAction,
  type InboxApproval,
  type InboxCourrierCapability,
  type InboxReclameCapability
} from './InboxCore'

export function InboxPanel(): React.JSX.Element {
  const t = useT()
  const messages = useDeck((s) => s.inboxMessages)
  const approvals = useDeck((s) => s.pendingApprovals)
  const sessions = useDeck((s) => s.sessions)
  const ackState = useDeck((s) => s.inboxAckState)
  const replyDrafts = useDeck((s) => s.inboxReplyDrafts)
  const approvalDrafts = useDeck((s) => s.approvalDrafts)
  const drafts = useDeck((s) => s.graphDrafts)
  const openInbox = useDeck((s) => s.openInbox)
  const seed = useDeck((s) => s.inboxSeed)
  const clearInboxSeed = useDeck((s) => s.clearInboxSeed)
  const openGraphDraft = useDeck((s) => s.openGraphDraft)
  const markInboxSeen = useDeck((s) => s.markInboxSeen)
  const ackInboxEntry = useDeck((s) => s.ackInboxEntry)
  const setInboxReplyDraft = useDeck((s) => s.setInboxReplyDraft)
  const setApprovalDraft = useDeck((s) => s.setApprovalDraft)
  const clearPendingApproval = useDeck((s) => s.clearPendingApproval)
  const showToast = useDeck((s) => s.showToast)
  const remote = useDeck((s) => s.remote)
  const settleHook = useHookApprovalSettle()

  const closeInboxAfterFinalSuccessfulApproval = (ok: boolean): void => {
    if (ok && useDeck.getState().pendingApprovals.length === 0) openInbox(false)
  }

  const answer = async (approval: InboxApproval, action: InboxAnswerAction): Promise<InboxActionOutcome> => {
    const hook = approval.reply_route === 'hook'
    const misrouted = (): InboxActionOutcome => {
      window.api.reportError('inbox', `answer '${action.kind}' does not apply to a ${approval.reply_route} request`)
      return 'failed'
    }
    if (hook) {
      if (action.kind === 'ack' || action.kind === 'text') return misrouted()
      const ok = await settleHook(approval.id, action)
      if (ok === null) return 'failed'
      closeInboxAfterFinalSuccessfulApproval(ok)
      return 'settled'
    }
    if (action.kind === 'handback' || action.kind === 'answers') return misrouted()
    try {
      const ok =
        action.kind === 'deny'
          ? await window.api.approvalDecline(approval.id)
          : action.kind === 'ack'
            ? await window.api.approvalAck(approval.id)
            : action.kind === 'allow'
              ? await window.api.approvalAllow(approval.id)
              : await window.api.approvalReply(approval.id, action.text)
      // `false` is not a failure: another channel (phone, Telegram…) won the
      // race and the agent is already released.
      showToast(
        ok ? (action.kind === 'ack' ? 'toast.inboxAckSent' : 'toast.inboxAnswerSent') : 'toast.inboxAnsweredElsewhere',
        ok ? 'success' : 'info'
      )
      clearPendingApproval(approval.id)
      closeInboxAfterFinalSuccessfulApproval(ok)
      return 'settled'
    } catch (e) {
      // Defense in depth: the controls are already hidden on a remote client,
      // so this branch means the refusal came from somewhere else — still say
      // WHY in the operator's language instead of leaking 'remote-blocked'.
      const msg = errorText(e)
      window.api.reportError('inbox', `answer '${action.kind}' on ${approval.id} failed: ${msg}`)
      if (msg.includes('remote-blocked')) showToast('inbox.verdictRemoteBlocked', 'error')
      else showToast(`${t('inbox.reply')}: ${msg}`, 'error', { raw: true })
      return 'failed'
    }
  }

  // On a remote companion the verdict controls are not rendered at all: the
  // call is refused by design, so offering the button would promise an action
  // that can never land.
  const reclame: InboxReclameCapability | null = verdictAllowed(remote) ? { answer } : null

  const courrier: InboxCourrierCapability = {
    markSeen: markInboxSeen,
    ack: ackInboxEntry,
    reply: async (toPeerId, text) => {
      try {
        const ok = await window.api.inboxReply(toPeerId, text)
        if (!ok) {
          showToast('toast.inboxReplyRefused', 'error')
          return 'failed'
        }
        showToast('toast.inboxReplySent')
        return 'settled'
      } catch (e) {
        window.api.reportError('inbox', `reply to ${toPeerId} failed: ${errorText(e)}`)
        showToast(`${t('inbox.reply')}: ${errorText(e)}`, 'error', { raw: true })
        return 'failed'
      }
    },
    deleteMessage: async (id) => {
      try {
        await window.api.inboxDelete([id])
        showToast('toast.inboxDeleted')
        return 'settled'
      } catch (e) {
        window.api.reportError('inbox', `delete of message ${id} failed: ${errorText(e)}`)
        showToast(`${t('inbox.delete')}: ${errorText(e)}`, 'error', { raw: true })
        return 'failed'
      }
    }
  }

  const leading =
    drafts.length > 0 ? (
      <div className="inbox-drafts">
        <div className="inbox-drafts-title">{t('inbox.drafts')}</div>
        {drafts.map((d) => (
          <div key={d.id} className="inbox-draft">
            <div className="inbox-msg-meta">
              <span className="inbox-draft-glyph" />
              <span className="inbox-msg-from">{d.from || '?'}</span>
              <span className="inbox-msg-time">{new Date(d.createdAt).toLocaleTimeString()}</span>
            </div>
            <div className="inbox-draft-title">{d.title}</div>
            <div className="inbox-draft-excerpt">{d.prompt.slice(0, 180)}</div>
            <button className="btn primary inbox-draft-open" onClick={() => void openGraphDraft(d)}>
              {t('inbox.openGraph')}
            </button>
          </div>
        ))}
      </div>
    ) : null

  return (
    <InboxCore
      t={t}
      messages={messages}
      approvals={approvals}
      readStates={ackState}
      reclame={reclame}
      courrier={courrier}
      replyDrafts={replyDrafts}
      onReplyDraft={setInboxReplyDraft}
      approvalDrafts={approvalDrafts}
      onApprovalDraft={setApprovalDraft}
      resolveSender={(approval) => resolveApprovalSender(approval.origin.tile_ref, sessions)}
      renderText={linkedText}
      renderNavigate={(approval, closeEntry) => (
        <ApprovalNavigate
          approval={approval}
          onNavigated={() => {
            closeEntry()
            openInbox(false)
          }}
        />
      )}
      leading={leading}
      seedApprovalId={seed}
      onSeedConsumed={clearInboxSeed}
      onClose={() => openInbox(false)}
    />
  )
}
