import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { GLYPHS, GLYPH_ACTIONS, GLYPH_BADGES } from './icons'
import type { TFn } from '../i18n'
import type { ApprovalSenderResolution } from '../inbox-sender'
import { inboxEntryKey } from '../../../shared/types'
import type { AckableInboxEntry, InboxAckStatus, InboxEntry, InboxMessage } from '../../../shared/types'
import { verdictAnswerKindFor } from './approval-verdict'
import { ApprovalRequestBody } from './ApprovalRequestBody'
import { ApprovalAnswerForm } from './ApprovalAnswerForm'
import { displayApprovalText } from './approval-display'
import { formQuestions, type QuestionDraft } from './approval-answers'

/**
 * Three entry families: a peer message (repliable, ackable), an event (no
 * recipient, ackable), and a blocking question (an agent stays stopped until
 * it is settled broker-side, never by a local dismissal, so it never reaches
 * the ack callback). Closing the modal never acks.
 *
 * Store-free by contract: every effect leaves through a capability callback,
 * so a host other than the Deck (the avatar's bubble) renders the same list.
 */

export type InboxApproval = Extract<InboxEntry, { kind: 'approval' }>['approval']

export type InboxAnswerAction =
  | { kind: 'allow' }
  | { kind: 'deny' }
  | { kind: 'ack' }
  | { kind: 'text'; text: string }
  | { kind: 'handback' }
  | { kind: 'answers'; answers: Record<string, string[]> }

/** 'settled' closes the entry, answered here or elsewhere; 'failed' keeps it open, the host already reported why. */
export type InboxActionOutcome = 'settled' | 'failed'

/** Reclame: the blocking requests. Absent, no verdict control is offered at all. */
export interface InboxReclameCapability {
  answer: (approval: InboxApproval, action: InboxAnswerAction) => Promise<InboxActionOutcome>
}

/** Courrier: messages and events. Without reply/deleteMessage the tab is read-only. */
export interface InboxCourrierCapability {
  markSeen: (entry: AckableInboxEntry) => void
  ack: (entry: AckableInboxEntry) => void
  reply?: (toPeerId: string, text: string) => Promise<InboxActionOutcome>
  /** Global: every reader of the group loses the message, not just this one. */
  deleteMessage?: (messageId: number) => Promise<InboxActionOutcome>
}

export interface InboxCoreProps {
  t: TFn
  messages: readonly InboxMessage[]
  approvals: readonly InboxApproval[]
  readStates: Readonly<Record<string, InboxAckStatus>>
  reclame: InboxReclameCapability | null
  courrier: InboxCourrierCapability
  replyDrafts: Readonly<Record<string, string>>
  onReplyDraft: (entryKey: string, text: string) => void
  approvalDrafts: Readonly<Record<string, QuestionDraft[] | undefined>>
  onApprovalDraft: (approvalId: string, draft: QuestionDraft[]) => void
  /** tile_ref is agent supplied: only the host knows which tiles are live. */
  resolveSender: (approval: InboxApproval) => ApprovalSenderResolution
  renderText?: (text: string) => ReactNode
  renderNavigate?: (approval: InboxApproval, closeEntry: () => void) => ReactNode
  /** Host content above the list; while present, the empty state stays hidden. */
  leading?: ReactNode
  seedApprovalId: string | null
  onSeedConsumed: () => void
  onClose: () => void
}

type ReadState = 'unread' | 'seen' | 'acked'

function entryAt(e: InboxEntry): string {
  if (e.kind === 'message') return e.message.sentAt
  if (e.kind === 'event') return e.at
  return e.approval.created_at
}

function listTimestamp(e: InboxEntry, today: Date): string {
  const at = new Date(entryAt(e))
  const isToday =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate()
  return isToday ? at.toLocaleTimeString() : at.toLocaleString()
}

function entryText(e: InboxEntry): string {
  if (e.kind === 'message') return e.message.text
  if (e.kind === 'event') return e.text
  return displayApprovalText(e.approval.question)
}

function reactKey(e: InboxEntry): string {
  return e.kind === 'approval' ? `apr:${e.approval.id}` : inboxEntryKey(e)
}

function ackable(e: InboxEntry): AckableInboxEntry | null {
  return e.kind === 'approval' ? null : e
}

const plainText = (text: string): ReactNode => text

/**
 * Sender snapshot the broker writes when the peer row is gone (see
 * `InboxMessage.from`). Such a message is family 1 but has NO reachable
 * recipient any more, so it must not offer a reply field either — the same
 * reason family 2 has none.
 */
const GONE_PEER = '<gone>'

export function InboxCore(props: InboxCoreProps): React.JSX.Element {
  const { t, messages, approvals, reclame, courrier, replyDrafts, onReplyDraft, seedApprovalId, onSeedConsumed } =
    props
  const renderText = props.renderText ?? plainText
  const canAnswerVerdict = reclame !== null
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const inFlight = useRef(false)
  const [today, setToday] = useState(() => new Date())

  useEffect(() => {
    const now = new Date()
    const nextMidnight = new Date(now)
    nextMidnight.setHours(24, 0, 0, 0)
    const timer = setTimeout(() => setToday(new Date()), nextMidnight.getTime() - now.getTime())
    return () => clearTimeout(timer)
  }, [today])

  // Blocking questions ride on TOP whatever their age — they are the only
  // family where someone is stopped waiting; the rest is newest-first.
  const entries = useMemo<InboxEntry[]>(() => {
    const byTimeDesc = (a: InboxEntry, b: InboxEntry): number => entryAt(b).localeCompare(entryAt(a))
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
    return props.readStates[inboxEntryKey(a)] ?? 'unread'
  }

  const openEntry = (e: InboxEntry): void => {
    const a = ackable(e)
    // Opening marks SEEN, never acked: the entry stays to be handled.
    if (a) courrier.markSeen(a)
    setOpenKey(reactKey(e))
  }

  useEffect(() => {
    if (!seedApprovalId) return
    const seeded = entries.find((e) => e.kind === 'approval' && e.approval.id === seedApprovalId)
    if (seeded) setOpenKey(reactKey(seeded))
    onSeedConsumed()
  }, [seedApprovalId, entries, onSeedConsumed])

  const senderOf = (e: InboxEntry): ReactNode => {
    if (e.kind === 'message') return e.message.from
    if (e.kind === 'approval') {
      const res = props.resolveSender(e.approval)
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

  // The module waits on these itself: answered through ApprovalAnswerForm only,
  // never by the chips or the free reply, which it would read as no verdict.
  const hookApproval = open?.kind === 'approval' && open.approval.reply_route === 'hook' ? open.approval : null
  const draftKey = open ? reactKey(open) : ''
  const draft = replyDrafts[draftKey] ?? ''
  const closeEntry = (): void => setOpenKey(null)

  const closeIfStillOpen = (actedKey: string): void => setOpenKey((cur) => (cur === actedKey ? null : cur))

  const run = async (act: () => Promise<InboxActionOutcome>): Promise<void> => {
    // A ref, not `sending`: two gestures in one tick both read the stale state.
    if (inFlight.current) return
    inFlight.current = true
    setSending(true)
    const actedKey = draftKey
    try {
      if ((await act()) === 'settled') {
        if (draft) onReplyDraft(actedKey, '')
        closeIfStillOpen(actedKey)
      }
    } finally {
      inFlight.current = false
      setSending(false)
    }
  }

  const answer = (approval: InboxApproval, action: InboxAnswerAction): void => {
    if (reclame) void run(() => reclame.answer(approval, action))
  }

  const removeMessage = (e: Extract<InboxEntry, { kind: 'message' }>): void => {
    const deleteMessage = courrier.deleteMessage
    if (!deleteMessage) return
    const actedKey = reactKey(e)
    void deleteMessage(e.message.id).then((outcome) => {
      if (outcome === 'settled') closeIfStillOpen(actedKey)
    })
  }

  const sendReply = (toPeerId: string): void => {
    const reply = courrier.reply
    if (!reply || !draft.trim()) return
    void run(() => reply(toPeerId, draft.trim()))
  }

  return (
    <div className="inbox-panel">
      <div className="inbox-header">
        <span className="inbox-title">{t('inbox.title')}</span>
        <button className="inbox-close" title={t('inbox.close')} onClick={props.onClose}>
          {GLYPH_ACTIONS.close}
        </button>
      </div>
      {props.leading}
      <div className="inbox-list">
        {entries.length === 0 && !props.leading && <div className="inbox-empty">{t('inbox.empty')}</div>}
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
                  <span className="inbox-entry-time">{listTimestamp(e, today)}</span>
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
                      courrier.ack(a)
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
                {e.kind === 'message' && courrier.deleteMessage && (
                  <button
                    className="icon-btn danger inbox-delete-btn"
                    title={t('inbox.delete')}
                    onClick={(ev) => {
                      ev.stopPropagation()
                      removeMessage(e)
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
        <div className="modal-backdrop" onClick={closeEntry}>
          <div className="modal inbox-modal" onClick={(ev) => ev.stopPropagation()}>
            <header className="modal-head">
              <h2>{senderOf(open)}</h2>
              <span className={`inbox-modal-family inbox-entry-${open.kind}`}>
                <span className="inbox-entry-mark">{familyGlyph(open)}</span>
                {familyLabel(open)}
              </span>
              <button className="icon-btn" title={t('inbox.close')} onClick={closeEntry}>
                {GLYPH_ACTIONS.close}
              </button>
            </header>
            <div className="inbox-modal-time">{new Date(entryAt(open)).toLocaleString()}</div>
            {open.kind === 'approval' && open.approval.title && (
              <div className="inbox-modal-subject">{open.approval.title}</div>
            )}
            {!(hookApproval && canAnswerVerdict && formQuestions(hookApproval)) &&
              (open.kind === 'approval' ? (
                <ApprovalRequestBody
                  t={t}
                  approval={open.approval}
                  className="inbox-modal-text"
                  renderText={renderText}
                />
              ) : (
                <div className="inbox-modal-text">{renderText(entryText(open))}</div>
              ))}

            {open.kind === 'approval' && props.renderNavigate?.(open.approval, closeEntry)}

            {open.kind === 'approval' && !canAnswerVerdict && (
              <div className="inbox-modal-note">{t('inbox.verdictRemoteBlocked')}</div>
            )}

            {open.kind === 'approval' &&
              canAnswerVerdict &&
              !hookApproval &&
              !open.approval.absorbed_permission &&
              (open.approval.kind === 'permission' || open.approval.options.length > 0) && (
                <div className="inbox-modal-options">
                  {/* A permission's chips are positional verdicts: their labels
                      are ours, never the producer's options. */}
                  {(open.approval.kind === 'permission'
                    ? [t('inbox.permissionAllow'), t('inbox.permissionDeny')]
                    : open.approval.options
                  ).map((opt, idx) => {
                    const answerKind = verdictAnswerKindFor(open.approval.kind, idx)
                    return (
                      <button
                        key={opt}
                        className="chip inbox-option"
                        disabled={sending}
                        onClick={() =>
                          answer(
                            open.approval,
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
                treatment for a family-1 message whose sender was purged, and
                for a Courrier without the reply capability. */}
            {open.kind === 'message' && open.message.from === GONE_PEER && (
              <div className="inbox-modal-note">{t('inbox.senderGone')}</div>
            )}
            {open.kind !== 'event' &&
              !hookApproval &&
              !(open.kind === 'message' && (open.message.from === GONE_PEER || !courrier.reply)) &&
              !(
                open.kind === 'approval' &&
                (!canAnswerVerdict || open.approval.kind === 'permission' || open.approval.absorbed_permission)
              ) && (
                <textarea
                  className="inbox-modal-reply"
                  rows={3}
                  placeholder={t('inbox.replyPlaceholder')}
                  value={draft}
                  onChange={(ev) => onReplyDraft(draftKey, ev.target.value)}
                />
              )}

            {hookApproval && canAnswerVerdict ? (
              <ApprovalAnswerForm
                t={t}
                approval={hookApproval}
                disabled={sending}
                draft={props.approvalDrafts[hookApproval.id]}
                onDraft={(d) => props.onApprovalDraft(hookApproval.id, d)}
                onAllow={() => answer(hookApproval, { kind: 'allow' })}
                onDeny={() => answer(hookApproval, { kind: 'deny' })}
                onAnswers={(answers) => answer(hookApproval, { kind: 'answers', answers })}
                onHandback={() => answer(hookApproval, { kind: 'handback' })}
                actionsClassName="modal-actions inbox-modal-actions approval-actions"
              >
                <button className="btn" onClick={closeEntry}>
                  {t('inbox.close')}
                </button>
              </ApprovalAnswerForm>
            ) : (
              <div className="modal-actions inbox-modal-actions">
                {open.kind === 'approval' ? (
                  <>
                    {/* Not an ack: it ANSWERS with a refusal, which is what
                        releases the waiting agent. */}
                    {canAnswerVerdict && !open.approval.absorbed_permission && (
                      <button
                        className="btn danger"
                        disabled={sending}
                        onClick={() => answer(open.approval, { kind: 'deny' })}
                      >
                        {t('inbox.decline')}
                      </button>
                    )}
                    {canAnswerVerdict &&
                      open.approval.kind !== 'permission' &&
                      open.approval.reply_route === 'channel' &&
                      !open.approval.mergeable && (
                        <button
                          className="btn"
                          disabled={sending}
                          onClick={() => answer(open.approval, { kind: 'ack' })}
                        >
                          {t('inbox.ack')}
                        </button>
                      )}
                    <button className="btn" onClick={closeEntry}>
                      {t('inbox.close')}
                    </button>
                    {canAnswerVerdict && open.approval.kind !== 'permission' && !open.approval.absorbed_permission && (
                      <button
                        className="primary"
                        disabled={sending || !draft.trim()}
                        onClick={() => answer(open.approval, { kind: 'text', text: draft.trim() })}
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
                          if (a) courrier.ack(a)
                        }}
                      >
                        {t('inbox.ack')}
                      </button>
                    )}
                    <button className="btn" onClick={closeEntry}>
                      {t('inbox.close')}
                    </button>
                    {open.kind === 'message' && courrier.deleteMessage && (
                      <button className="btn danger" onClick={() => removeMessage(open)}>
                        {t('inbox.delete')}
                      </button>
                    )}
                    {open.kind === 'message' && open.message.from !== GONE_PEER && courrier.reply && (
                      <button
                        className="primary"
                        disabled={sending || !draft.trim()}
                        onClick={() => sendReply(open.message.from)}
                      >
                        {t('inbox.reply')}
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
            <div className="inbox-modal-note">
              {hookApproval ? t('inbox.noteHook') : open.kind === 'approval' ? t('inbox.noteBlocking') : t('inbox.noteClose')}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
