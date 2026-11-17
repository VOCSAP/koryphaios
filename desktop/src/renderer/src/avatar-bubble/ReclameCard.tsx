import { useState } from 'react'
import type { AvatarBubbleCard } from '@shared/avatar-bubble-view'
import type { AvatarInboxAction, InboxActionKind } from '@shared/avatar-inbox-protocol'
import { ApprovalRequestBody } from '../components/ApprovalRequestBody'
import { GLYPH_ACTIONS, GLYPH_BADGES } from '../components/icons'
import type { TFn } from '../translate'

export interface ReclameCardProps {
  t: TFn
  lang: string
  card: AvatarBubbleCard
  position: number
  total: number
  busy: boolean
  /** False while the card has just appeared: a verdict is never one click of a double-click away. */
  armed: boolean
  /** The last gesture's outcome on this card, already worded; null when there is nothing to say. */
  notice: string | null
  onPrev: () => void
  onNext: () => void
  onAct: (action: AvatarInboxAction) => void
  onOpenInDeck: () => void
}

const asText = (text: string): string => text

/** One request at a time: the verdict is one click, and only the gestures the Deck will carry are drawn. */
export function ReclameCard(props: ReclameCardProps): React.JSX.Element {
  const { t, card, busy } = props
  const locked = busy || !props.armed
  const [draft, setDraft] = useState('')
  const [picks, setPicks] = useState<Record<number, number[]>>({})
  const may = (kind: InboxActionKind): boolean => card.gestures.includes(kind)
  const freeText = may('text')
  const send = (action: Omit<AvatarInboxAction, 'approval_id'>): void => props.onAct({ approval_id: card.approvalId, ...action })

  const questions = card.questions
  const answersReady = questions !== null && questions.every((_, i) => (picks[i]?.length ?? 0) > 0)
  const toggle = (qi: number, oi: number, multi: boolean): void =>
    setPicks((all) => {
      const cur = all[qi] ?? []
      const next = multi ? (cur.includes(oi) ? cur.filter((x) => x !== oi) : [...cur, oi]) : [oi]
      return { ...all, [qi]: next }
    })
  const answers = (): Record<string, string[]> =>
    Object.fromEntries((questions ?? []).map((q, i) => [q.key, (picks[i] ?? []).map((oi) => q.options[oi]!.value)]))

  const state = card.settledElsewhere ? ' is-settled' : card.blocking ? ' is-blocking' : ' is-information'
  return (
    <article className={`avb-card${state}`} aria-label={card.title || card.deckLabel}>
      <div className="avb-card-head">
        <span className="avb-card-family">
          <span className="inbox-entry-mark">{card.blocking ? GLYPH_BADGES.clepsydra : GLYPH_BADGES.beacon}</span>
          {t(card.blocking ? 'inbox.familyBlocking' : 'inbox.familyInformation')}
        </span>
        <span className="avb-pager">
          <button className="icon-btn" title={t('avatarBubble.previous')} aria-label={t('avatarBubble.previous')} disabled={props.position === 0} onClick={props.onPrev}>
            {GLYPH_ACTIONS.back}
          </button>
          <span className="avb-pager-count">{t('avatarBubble.position', { n: props.position + 1, total: props.total })}</span>
          <button className="icon-btn" title={t('avatarBubble.next')} aria-label={t('avatarBubble.next')} disabled={props.position >= props.total - 1} onClick={props.onNext}>
            {GLYPH_ACTIONS.forward}
          </button>
        </span>
      </div>
      <div className="avb-card-from">
        <span className="avb-card-deck">{card.deckLabel}</span>
        <span className="avb-card-sep">·</span>
        <span className="avb-card-tile">{card.tileName ?? card.fromPeerId}</span>
        <span className="avb-card-time">{new Date(card.createdAt).toLocaleTimeString(props.lang)}</span>
      </div>
      {card.title && <div className="inbox-modal-subject">{card.title}</div>}
      {/* A structured question says its text again in its own legend. */}
      {!(questions && may('answers')) && (
        <ApprovalRequestBody t={t} approval={card} className="inbox-modal-text avb-card-text" renderText={asText} />
      )}

      {card.settledElsewhere && (
        <div className="avb-card-line is-settled" role="status">
          <span className="avb-card-line-glyph">{GLYPH_BADGES.archive}</span>
          {t('avatarBubble.settledElsewhere')}
        </div>
      )}
      {card.cut && !card.settledElsewhere && (
        <div className="avb-card-line is-cut" role="note">
          <span className="avb-card-line-glyph">{GLYPH_ACTIONS.shears}</span>
          {t('avatarBubble.cutNote')}
        </div>
      )}

      {questions && may('answers') && (
        <div className="avb-questions">
          {questions.map((q, qi) => (
            <fieldset key={q.key} className="aq">
              <legend className="aq-head">
                {q.header && <span className="aq-tag">{q.header}</span>}
                <span className="aq-q">{q.question}</span>
              </legend>
              <div className="aq-opts">
                {q.options.map((o, oi) => (
                  <button
                    key={oi}
                    className={`aq-pick avb-pick${(picks[qi] ?? []).includes(oi) ? ' is-on' : ''}`}
                    aria-pressed={(picks[qi] ?? []).includes(oi)}
                    disabled={busy}
                    onClick={() => toggle(qi, oi, q.multiSelect)}
                  >
                    <span className="aq-label">{o.label}</span>
                    {o.description && <span className="aq-desc">{o.description}</span>}
                  </button>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      )}

      {freeText && card.options.length > 0 && (
        <div className="inbox-modal-options">
          {card.options.map((opt, oi) => (
            <button key={oi} className="chip inbox-option" disabled={locked} onClick={() => send({ action: 'text', text: opt.value })}>
              {opt.label}
            </button>
          ))}
        </div>
      )}
      {freeText && (
        <textarea
          className="inbox-modal-reply avb-reply"
          rows={2}
          placeholder={t('inbox.replyPlaceholder')}
          value={draft}
          disabled={busy}
          onChange={(ev) => setDraft(ev.target.value)}
        />
      )}

      {props.notice && (
        <div className="avb-card-notice" role="alert">
          {props.notice}
        </div>
      )}

      {!card.settledElsewhere && (
        <div className="modal-actions inbox-modal-actions avb-card-actions">
          {may('deny') && (
            <button className="btn danger" disabled={locked} onClick={() => send({ action: 'deny' })}>
              {t(card.kind === 'permission' ? 'inbox.permissionDeny' : 'inbox.decline')}
            </button>
          )}
          {may('acknowledge') && (
            <button className="btn" disabled={locked} onClick={() => send({ action: 'acknowledge' })}>
              {t('inbox.ack')}
            </button>
          )}
          {card.openInDeck && (
            <button className="btn" disabled={busy} onClick={props.onOpenInDeck}>
              {GLYPH_ACTIONS.external}
              {t('avatarBubble.openInDeck')}
            </button>
          )}
          {card.kind === 'permission' && may('allow') && (
            <button className="primary" disabled={locked} onClick={() => send({ action: 'allow' })}>
              {t('inbox.permissionAllow')}
            </button>
          )}
          {questions && may('answers') && (
            <button className="primary" disabled={locked || !answersReady} onClick={() => send({ action: 'answers', answers: answers() })}>
              {t('avatarBubble.sendAnswers')}
            </button>
          )}
          {freeText && (
            <button className="primary" disabled={locked || !draft.trim()} onClick={() => send({ action: 'text', text: draft.trim() })}>
              {t('inbox.reply')}
            </button>
          )}
        </div>
      )}
      {!card.settledElsewhere && (
        <div className="inbox-modal-note">
          {t(
            card.kind === 'permission'
              ? 'inbox.notePermission'
              : !card.blocking
                ? 'inbox.noteInformation'
                : questions
                  ? 'inbox.noteHook'
                  : 'inbox.noteBlocking'
          )}
        </div>
      )}
    </article>
  )
}
