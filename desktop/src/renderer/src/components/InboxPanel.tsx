import { useEffect, useMemo, useState } from 'react'
import { GLYPHS, GLYPH_ACTIONS, GLYPH_BADGES } from './icons'
import { errorText, useDeck } from '../store'
import { useT } from '../i18n'
import { inboxEntryKey } from '@shared/types'
import type { AckableInboxEntry, InboxEntry } from '@shared/types'
import { COMPANION_MANIFEST, REMOTE_BLOCKED_CHANNELS } from '@shared/companion'
import { verdictAnswerKindFor } from './approval-verdict'
import { resolveApprovalSender } from '../inbox-sender'

/**
 * Three structurally distinct entry families: a peer message (repliable,
 * ackable), an event (no recipient, ackable), and a blocking question
 * (repliable and correlated — an agent stays stopped until answered).
 * A question carries no ack at all, not even a greyed one — AckableInboxEntry
 * forbids passing it to inboxAck at compile time; its counterpart is decline,
 * an answer that settles the ticket, not a dismissal.
 * Closing the modal never acks, so an entry opened without time to handle it
 * stays in the operator's way.
 */

/** The three read-states, derived: an entry absent from the map is unread. */
type ReadState = 'unread' | 'seen' | 'acked'

/** ISO timestamp of an entry, whatever its family (used for the ordering). */
function entryAt(e: InboxEntry): string {
  if (e.kind === 'message') return e.message.sentAt
  if (e.kind === 'event') return e.at
  return e.approval.created_at
}

/** Full text of an entry — the modal body and the list excerpt share it. */
function entryText(e: InboxEntry): string {
  if (e.kind === 'message') return e.message.text
  if (e.kind === 'event') return e.text
  return e.approval.question
}

/** Stable React key across the three families (family 3 has no ack key). */
function reactKey(e: InboxEntry): string {
  return e.kind === 'approval' ? `apr:${e.approval.id}` : inboxEntryKey(e)
}

/** Narrowing helper: family 1/2 only, so `inboxAck` cannot be mis-called. */
function ackable(e: InboxEntry): AckableInboxEntry | null {
  return e.kind === 'approval' ? null : e
}

/**
 * Sender snapshot the broker writes when the peer row is gone (see
 * `InboxMessage.from`). Such a message is family 1 but has NO reachable
 * recipient any more, so it must not offer a reply field either — the same
 * reason family 2 has none.
 */
const GONE_PEER = '<gone>'

/**
 * Answering a blocking question RENDERS A HUMAN VERDICT, so both its channels
 * sit on the companion's explicit remote floor: a remote client's call is
 * rejected with 'remote-blocked' by construction, not by accident. DERIVED
 * from that floor rather than hardcoded here — re-tier the channels and this
 * UI follows instead of offering a button that provably cannot land.
 */
const VERDICT_BLOCKED_REMOTELY =
  REMOTE_BLOCKED_CHANNELS.has(COMPANION_MANIFEST.approvalReply.channel) ||
  REMOTE_BLOCKED_CHANNELS.has(COMPANION_MANIFEST.approvalDecline.channel) ||
  REMOTE_BLOCKED_CHANNELS.has(COMPANION_MANIFEST.approvalAllow.channel)

export function InboxPanel(): React.JSX.Element {
  const t = useT()
  const messages = useDeck((s) => s.inboxMessages)
  const approvals = useDeck((s) => s.pendingApprovals)
  const sessions = useDeck((s) => s.sessions)
  const ackState = useDeck((s) => s.inboxAckState)
  const replyDrafts = useDeck((s) => s.inboxReplyDrafts)
  const drafts = useDeck((s) => s.graphDrafts)
  const openInbox = useDeck((s) => s.openInbox)
  const openGraphDraft = useDeck((s) => s.openGraphDraft)
  const markInboxSeen = useDeck((s) => s.markInboxSeen)
  const ackInboxEntry = useDeck((s) => s.ackInboxEntry)
  const setInboxReplyDraft = useDeck((s) => s.setInboxReplyDraft)
  const clearPendingApproval = useDeck((s) => s.clearPendingApproval)
  const showToast = useDeck((s) => s.showToast)
  const remote = useDeck((s) => s.remote)
  // On a remote companion the verdict controls are not rendered at all: the
  // call is refused by design, so offering the button would promise an action
  // that can never land (and the modal would report a raw 'remote-blocked').
  const canAnswerVerdict = !(remote && VERDICT_BLOCKED_REMOTELY)
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  // One list, two wire channels: 'inbox:new' (messages, and the events that
  // will join it) and 'approvals:pending'. Blocking questions ride on TOP
  // whatever their age — they are the only family where someone is stopped
  // waiting; the rest is newest-first.
  const entries = useMemo<InboxEntry[]>(() => {
    const byTimeDesc = (a: InboxEntry, b: InboxEntry): number =>
      entryAt(b).localeCompare(entryAt(a))
    const blocking: InboxEntry[] = approvals.map((approval) => ({ kind: 'approval', approval }))
    const rest: InboxEntry[] = messages.map((message) => ({ kind: 'message', message }))
    return [...blocking.sort(byTimeDesc), ...rest.sort(byTimeDesc)]
  }, [messages, approvals])

  const open = entries.find((e) => reactKey(e) === openKey) ?? null
  // Closes the modal rather than leaving it open on an entry that vanished
  // underneath it (e.g. answered from the phone).
  useEffect(() => {
    if (openKey && !open) setOpenKey(null)
  }, [openKey, open])

  const readState = (e: InboxEntry): ReadState => {
    const a = ackable(e)
    if (!a) return 'unread'
    return ackState[inboxEntryKey(a)] ?? 'unread'
  }

  const openEntry = (e: InboxEntry): void => {
    const a = ackable(e)
    // Opening marks SEEN, never acked: the entry stays to be handled.
    if (a) markInboxSeen(a)
    setOpenKey(reactKey(e))
  }

  const senderOf = (e: InboxEntry): React.ReactNode => {
    if (e.kind === 'message') return e.message.from
    if (e.kind === 'approval') {
      // ALL resolution logic (re-validation against live tiles, sanitizing
      // the unresolved fallback) lives in inbox-sender.ts, on purpose: this
      // must be the only place that decides what counts as a resolved
      // sender, so no inline branch here can quietly skip it (card 55c5470e).
      const res = resolveApprovalSender(e.approval.origin.tile_ref, sessions)
      if (res.resolved) return res.name
      return res.raw ? (
        <>
          {t('inbox.senderUnresolved')} <code>{res.raw}</code>
        </>
      ) : (
        t('inbox.senderUnresolvedEmpty')
      )
    }
    return t('inbox.familyEvent')
  }

  const familyGlyph = (e: InboxEntry): React.JSX.Element => {
    if (e.kind === 'approval') return GLYPH_BADGES.clepsydra
    if (e.kind === 'event') return GLYPH_BADGES.beacon
    return GLYPHS.agents
  }

  const familyLabel = (e: InboxEntry): string =>
    e.kind === 'approval'
      ? t('inbox.familyBlocking')
      : e.kind === 'event'
        ? t('inbox.familyEvent')
        : t('inbox.familyMessage')

  const draftKey = open ? reactKey(open) : ''
  const draft = replyDrafts[draftKey] ?? ''

  /**
   * Courrier lot 1E (card 1e81ee7b) — the manual "delete this one" gesture, a
   * THIRD state distinct from Close (leaves it, unread stays unread) and Ack
   * (a local read-state flag, never removes the entry). Global: every Deck
   * attached to the group sees it gone, not just this window. Scoped to
   * family-1 MESSAGES only — a family-2 event has no broker-side row to
   * delete (its `id` is a locally-synthesized string, not a `messages.id`),
   * and a family-3 blocking QUESTION must never be silently discarded out
   * from under an agent waiting on it.
   */
  const deleteEntry = async (id: number): Promise<void> => {
    try {
      await window.api.inboxDelete([id])
      showToast('toast.inboxDeleted')
      if (openKey && open && open.kind === 'message' && open.message.id === id) setOpenKey(null)
    } catch (e) {
      showToast(`${t('inbox.delete')}: ${errorText(e)}`, 'error', { raw: true })
    }
  }

  /** Family 1 — a plain targeted announce back to the sender. */
  const sendReply = async (toPeerId: string): Promise<void> => {
    if (!draft.trim() || sending) return
    setSending(true)
    try {
      const ok = await window.api.inboxReply(toPeerId, draft.trim())
      if (ok) {
        setInboxReplyDraft(draftKey, '')
        showToast('toast.inboxReplySent')
        setOpenKey(null)
      } else {
        showToast('toast.inboxReplyRefused', 'error')
      }
    } catch (e) {
      showToast(`${t('inbox.reply')}: ${errorText(e)}`, 'error', { raw: true })
    } finally {
      setSending(false)
    }
  }

  /**
   * Family 3 — answering (allow/deny/text) RESOLVES the ticket and releases
   * the agent. Three DISTINCT IPC primitives, never interchangeable (card
   * c7df3781): 'allow'/'deny' render a human VERDICT the CLI's Ink chooser
   * consumes as a keystroke, 'text' relays a free-text answer as a peer
   * message (ask_operator). See approval-verdict.ts for which one a given
   * chip must use.
   */
  const answerApproval = async (
    id: string,
    action: { kind: 'allow' } | { kind: 'deny' } | { kind: 'text'; text: string }
  ): Promise<void> => {
    if (sending) return
    setSending(true)
    try {
      const ok =
        action.kind === 'deny'
          ? await window.api.approvalDecline(id)
          : action.kind === 'allow'
            ? await window.api.approvalAllow(id)
            : await window.api.approvalReply(id, action.text)
      // `false` is not a failure: another channel (phone, Telegram…) won the
      // race and the agent is already released.
      showToast(
        ok ? 'toast.inboxAnswerSent' : 'toast.inboxAnsweredElsewhere',
        ok ? 'success' : 'info'
      )
      setInboxReplyDraft(draftKey, '')
      clearPendingApproval(id)
      setOpenKey(null)
    } catch (e) {
      // Defense in depth: the controls are already hidden on a remote client,
      // so this branch means the refusal came from somewhere else — still say
      // WHY in the operator's language instead of leaking 'remote-blocked'.
      const msg = errorText(e)
      if (msg.includes('remote-blocked')) showToast('inbox.verdictRemoteBlocked', 'error')
      else showToast(`${t('inbox.reply')}: ${msg}`, 'error', { raw: true })
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="inbox-panel">
      <div className="inbox-header">
        <span className="inbox-title">{t('inbox.title')}</span>
        <button className="inbox-close" title={t('inbox.close')} onClick={() => openInbox(false)}>
          {GLYPH_ACTIONS.close}
        </button>
      </div>
      {drafts.length > 0 && (
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
      )}
      <div className="inbox-list">
        {entries.length === 0 && drafts.length === 0 && (
          <div className="inbox-empty">{t('inbox.empty')}</div>
        )}
        {entries.map((e) => {
          const state = readState(e)
          const a = ackable(e)
          return (
            <div
              key={reactKey(e)}
              className={`inbox-entry inbox-entry-${e.kind} is-${state}`}
              role="button"
              tabIndex={0}
              title={t('inbox.openEntry')}
              onClick={() => openEntry(e)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault()
                  openEntry(e)
                }
              }}
            >
              <span className="inbox-entry-mark" title={familyLabel(e)}>
                {familyGlyph(e)}
              </span>
              <span className="inbox-entry-main">
                <span className="inbox-entry-meta">
                  {/* Shape, not only colour: filled disc = unread, ring = seen,
                      nothing (a check lands in the actions) = acked. */}
                  <span className={`inbox-entry-dot is-${state}`} title={t(`inbox.state.${state}`)} />
                  <span className="inbox-entry-from">{senderOf(e)}</span>
                  <span className="inbox-entry-time">
                    {new Date(entryAt(e)).toLocaleTimeString()}
                  </span>
                </span>
                <span className="inbox-entry-excerpt">{entryText(e)}</span>
              </span>
              <span className="inbox-entry-actions">
                {a && state !== 'acked' && (
                  <button
                    className="icon-btn inbox-ack-btn"
                    title={t('inbox.ack')}
                    onClick={(ev) => {
                      ev.stopPropagation()
                      ackInboxEntry(a)
                    }}
                  >
                    {GLYPH_ACTIONS.check}
                  </button>
                )}
                {a && state === 'acked' && (
                  <span className="inbox-entry-done" title={t('inbox.state.acked')}>
                    {GLYPH_ACTIONS.check}
                  </span>
                )}
                {e.kind === 'message' && (
                  <button
                    className="icon-btn danger inbox-delete-btn"
                    title={t('inbox.delete')}
                    onClick={(ev) => {
                      ev.stopPropagation()
                      void deleteEntry(e.message.id)
                    }}
                  >
                    {GLYPH_ACTIONS.trash}
                  </button>
                )}
                <span className="inbox-entry-chevron">{GLYPH_ACTIONS.forward}</span>
              </span>
            </div>
          )
        })}
      </div>
      <div className="inbox-hint">{t('inbox.hint')}</div>

      {open && (
        <div className="modal-backdrop" onClick={() => setOpenKey(null)}>
          <div className="modal inbox-modal" onClick={(ev) => ev.stopPropagation()}>
            <header className="modal-head">
              <h2>{senderOf(open)}</h2>
              <span className={`inbox-modal-family inbox-entry-${open.kind}`}>
                <span className="inbox-entry-mark">{familyGlyph(open)}</span>
                {familyLabel(open)}
              </span>
              <button
                className="icon-btn"
                title={t('inbox.close')}
                onClick={() => setOpenKey(null)}
              >
                {GLYPH_ACTIONS.close}
              </button>
            </header>
            <div className="inbox-modal-time">{new Date(entryAt(open)).toLocaleString()}</div>
            {open.kind === 'approval' && open.approval.title && (
              <div className="inbox-modal-subject">{open.approval.title}</div>
            )}
            <div className="inbox-modal-text">{entryText(open)}</div>

            {open.kind === 'approval' && !canAnswerVerdict && (
              <div className="inbox-modal-note">{t('inbox.verdictRemoteBlocked')}</div>
            )}

            {open.kind === 'approval' && canAnswerVerdict && open.approval.options.length > 0 && (
              <div className="inbox-modal-options">
                {open.approval.options.map((opt, idx) => {
                  // Discriminate on `kind`, never on the label string
                  // (see approval-verdict.ts): a 'permission' chip renders
                  // an allow/deny VERDICT, a 'question' chip relays its
                  // label as free text.
                  const answerKind = verdictAnswerKindFor(open.approval.kind, idx)
                  return (
                    <button
                      key={opt}
                      className="chip inbox-option"
                      disabled={sending}
                      onClick={() =>
                        void answerApproval(
                          open.approval.id,
                          answerKind === 'text' ? { kind: 'text', text: opt } : { kind: answerKind }
                        )
                      }
                    >
                      {opt}
                    </button>
                  )
                })}
              </div>
            )}

            {/* Family 2 has NO recipient, so it gets no reply field at all —
                an input that leads nowhere is worse than its absence. Same
                treatment for a family-1 message whose sender was purged. */}
            {open.kind === 'message' && open.message.from === GONE_PEER && (
              <div className="inbox-modal-note">{t('inbox.senderGone')}</div>
            )}
            {open.kind !== 'event' &&
              !(open.kind === 'message' && open.message.from === GONE_PEER) &&
              !(open.kind === 'approval' && !canAnswerVerdict) && (
              <textarea
                className="inbox-modal-reply"
                rows={3}
                placeholder={t('inbox.replyPlaceholder')}
                value={draft}
                onChange={(ev) => setInboxReplyDraft(draftKey, ev.target.value)}
              />
            )}

            <div className="modal-actions inbox-modal-actions">
              {open.kind === 'approval' ? (
                <>
                  {/* Not an ack: it ANSWERS with a refusal, which is what
                      releases the waiting agent. Both verdict controls are
                      absent on a remote companion (see canAnswerVerdict). */}
                  {canAnswerVerdict && (
                    <button
                      className="btn danger"
                      disabled={sending}
                      onClick={() => void answerApproval(open.approval.id, { kind: 'deny' })}
                    >
                      {t('inbox.decline')}
                    </button>
                  )}
                  <button className="btn" onClick={() => setOpenKey(null)}>
                    {t('inbox.close')}
                  </button>
                  {canAnswerVerdict && (
                    <button
                      className="primary"
                      disabled={sending || !draft.trim()}
                      onClick={() =>
                        void answerApproval(open.approval.id, { kind: 'text', text: draft.trim() })
                      }
                    >
                      {t('inbox.reply')}
                    </button>
                  )}
                </>
              ) : (
                <>
                  {readState(open) !== 'acked' && (
                    <button
                      className="btn"
                      onClick={() => {
                        const a = ackable(open)
                        if (a) ackInboxEntry(a)
                      }}
                    >
                      {t('inbox.ack')}
                    </button>
                  )}
                  <button className="btn" onClick={() => setOpenKey(null)}>
                    {t('inbox.close')}
                  </button>
                  {open.kind === 'message' && (
                    <button
                      className="btn danger"
                      onClick={() => void deleteEntry(open.message.id)}
                    >
                      {t('inbox.delete')}
                    </button>
                  )}
                  {open.kind === 'message' && open.message.from !== GONE_PEER && (
                    <button
                      className="primary"
                      disabled={sending || !draft.trim()}
                      onClick={() => void sendReply(open.message.from)}
                    >
                      {t('inbox.reply')}
                    </button>
                  )}
                </>
              )}
            </div>
            <div className="inbox-modal-note">
              {open.kind === 'approval' ? t('inbox.noteBlocking') : t('inbox.noteClose')}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
