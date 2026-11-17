import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AvatarBubbleActOutcome, AvatarBubbleApi, AvatarBubbleCard, AvatarBubbleState } from '@shared/avatar-bubble-view'
import type { AvatarInboxAction } from '@shared/avatar-inbox-protocol'
import type { AckableInboxEntry } from '../../../shared/types'
import { InboxCore } from '../components/InboxCore'
import { GLYPHS, GLYPH_ACTIONS, GLYPH_BADGES } from '../components/icons'
import { translate, type TFn } from '../translate'
import { bubbleCourrier } from './courrier'
import { ReclameCard } from './ReclameCard'

type Tab = 'reclame' | 'courrier'

interface Notice {
  key: string
  text: string
}

const NO_DRAFTS: Readonly<Record<string, never>> = {}
const noop = (): void => {}

/**
 * How long the verdict buttons of a card stay off after it appears: once a
 * gesture is won the next card takes the same place, and the second click of
 * a double-click must not approve a request nobody has read.
 */
export const AVATAR_BUBBLE_ARM_MS = 600

export interface BubbleClock {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const REAL_CLOCK: BubbleClock = {
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number)
}

/** The wording of an outcome that leaves the card in place; 'won' and 'lost' are told by the next state. */
function outcomeNotice(t: TFn, outcome: AvatarBubbleActOutcome, reason: string | undefined): string | null {
  switch (outcome) {
    case 'refused':
      return reason ? t('avatarBubble.refusedReason', { reason }) : t('avatarBubble.refused')
    case 'unknown':
      return t('avatarBubble.unknown')
    case 'failed':
      return t('avatarBubble.failed')
    case 'busy':
    case 'won':
    case 'lost':
      return null
  }
}

export function BubbleApp({ api, clock = REAL_CLOCK }: { api: AvatarBubbleApi; clock?: BubbleClock }): React.JSX.Element {
  const [state, setState] = useState<AvatarBubbleState | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [tab, setTab] = useState<Tab>('reclame')
  const [currentKey, setCurrentKey] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const pushed = useRef(false)

  useEffect(() => {
    const unsubscribe = api.onState((next) => {
      pushed.current = true
      setState(next)
    })
    api.getState().then(
      (initial) => {
        if (!pushed.current) setState(initial)
      },
      (error: unknown) => {
        api.reportError(`bubble state could not be read: ${error instanceof Error ? error.message : String(error)}`)
        setLoadFailed(true)
      }
    )
    return unsubscribe
  }, [api])

  useEffect(() => {
    if (!state) return
    document.documentElement.dataset.theme = state.theme
    document.documentElement.lang = state.lang
  }, [state?.theme, state?.lang])

  const dict = state?.dict
  const t = useCallback<TFn>((key, params) => translate(dict ?? {}, key, params), [dict])

  const cards = state?.model.reclame ?? []
  // The open card follows its key when the queue shifts under it, else the slot it held.
  const lastIndex = useRef(0)
  const found = cards.findIndex((c) => c.key === currentKey)
  const index = found >= 0 ? found : Math.min(lastIndex.current, Math.max(cards.length - 1, 0))
  lastIndex.current = index
  const card: AvatarBubbleCard | undefined = cards[index]
  const shownKey = card?.key ?? null
  const [armedKey, setArmedKey] = useState<string | null>(null)
  useEffect(() => {
    if (shownKey === null) return
    const handle = clock.setTimeout(() => setArmedKey(shownKey), AVATAR_BUBBLE_ARM_MS)
    return () => clock.clearTimeout(handle)
  }, [shownKey, clock])
  const armed = shownKey !== null && armedKey === shownKey

  const courrier = useMemo(() => (state ? bubbleCourrier(state.model, (message) => api.reportError(message)) : null), [state, api])

  if (!state) {
    return (
      <div className="avb" data-anchor="right">
        <div className="avb-frame">
          <div className="avb-empty" role="status">
            {loadFailed ? 'Kory' : ''}
          </div>
        </div>
      </div>
    )
  }

  const act = (target: AvatarBubbleCard, action: AvatarInboxAction): void => {
    if (busyKey !== null || !armed || target.key !== shownKey) return
    setBusyKey(target.key)
    setNotice(null)
    api
      .act({ generation: state.generation, deckRunId: target.identity.deckRunId, broker_url: target.identity.broker_url, action })
      .then(
        (result) => {
          const text = outcomeNotice(t, result.outcome, result.reason)
          if (text) setNotice({ key: target.key, text })
        },
        (error: unknown) => {
          api.reportError(`bubble gesture ${action.action} was refused: ${error instanceof Error ? error.message : String(error)}`)
          setNotice({ key: target.key, text: t('avatarBubble.failed') })
        }
      )
      .finally(() => setBusyKey(null))
  }

  const openInDeck = (target: AvatarBubbleCard): void => {
    api
      .focusDeck({ generation: state.generation, deckRunId: target.identity.deckRunId, broker_url: target.identity.broker_url })
      .catch((error: unknown) => {
        api.reportError(`bubble could not open the Deck: ${error instanceof Error ? error.message : String(error)}`)
        setNotice({ key: target.key, text: t('avatarBubble.failed') })
      })
  }

  const close = (): void => {
    api.close().catch((error: unknown) => api.reportError(`bubble close failed: ${error instanceof Error ? error.message : String(error)}`))
  }

  const waiting = cards.filter((c) => c.blocking && !c.settledElsewhere).length
  const informations = cards.filter((c) => !c.blocking && !c.settledElsewhere).length
  const open = state.model.courrier.filter((m) => !m.closed && !m.answered).length
  const hidden = state.model.truncated.approvals
  const read = (entry: AckableInboxEntry, gesture: 'markSeen' | 'ack'): void => {
    const m = courrier?.source(entry)
    if (!m) {
      api.reportError(`bubble ${gesture} on an entry the bubble does not list: ${entry.kind}`)
      return
    }
    api[gesture]({
      generation: state.generation,
      deckRunId: m.identity.deckRunId,
      broker_url: m.identity.broker_url,
      scopeGeneration: m.scopeGeneration,
      id: m.id,
      sentAt: m.sentAt
    }).catch((error: unknown) => {
      api.reportError(`bubble ${gesture} was refused: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  return (
    <div className="avb" data-anchor={state.anchor}>
      <div className="avb-frame">
        <header className="avb-head">
          <span className="avb-title">Kory</span>
          <div className="avb-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'reclame'} className={`avb-tab${tab === 'reclame' ? ' is-active' : ''}`} onClick={() => setTab('reclame')}>
              <span className="avb-tab-glyph">{GLYPH_BADGES.clepsydra}</span>
              {t('avatarBubble.reclame')}
              {waiting > 0 && <span className="avb-tab-count is-waiting">{waiting}</span>}
            </button>
            <button role="tab" aria-selected={tab === 'courrier'} className={`avb-tab${tab === 'courrier' ? ' is-active' : ''}`} onClick={() => setTab('courrier')}>
              <span className="avb-tab-glyph">{GLYPHS.inbox}</span>
              {t('avatarBubble.courrier')}
              {open > 0 && <span className="avb-tab-count">{open}</span>}
            </button>
          </div>
          <button className="icon-btn" title={t('avatarBubble.close')} aria-label={t('avatarBubble.close')} onClick={close}>
            {GLYPH_ACTIONS.close}
          </button>
        </header>

        {tab === 'reclame' ? (
          <div className="avb-body" role="tabpanel">
            {(waiting > 0 || informations > 0) && (
              <div className="avb-summary">{t('avatarBubble.summary', { waiting, informations })}</div>
            )}
            {card ? (
              <ReclameCard
                key={card.key}
                t={t}
                lang={state.lang}
                card={card}
                position={index}
                total={cards.length}
                busy={busyKey !== null}
                armed={armed}
                notice={notice?.key === card.key ? notice.text : null}
                onPrev={() => setCurrentKey(cards[index - 1]?.key ?? card.key)}
                onNext={() => setCurrentKey(cards[index + 1]?.key ?? card.key)}
                onAct={(action) => act(card, action)}
                onOpenInDeck={() => openInDeck(card)}
              />
            ) : (
              <div className="avb-empty">{t('avatarBubble.emptyReclame')}</div>
            )}
            {hidden > 0 && <div className="avb-foot">{t('avatarBubble.truncated', { count: hidden })}</div>}
          </div>
        ) : (
          <div className="avb-body" role="tabpanel">
            {courrier && (
              <InboxCore
                t={t}
                embedded
                messages={courrier.messages}
                approvals={[]}
                archive={courrier.archive}
                readStates={courrier.readStates}
                entryKey={courrier.entryKey}
                approvalKey={courrier.approvalKey}
                reclame={null}
                courrier={{ markSeen: (e) => read(e, 'markSeen'), ack: (e) => read(e, 'ack') }}
                replyDrafts={NO_DRAFTS}
                onReplyDraft={noop}
                approvalDrafts={NO_DRAFTS}
                onApprovalDraft={noop}
                resolveSender={() => ({ resolved: false, raw: '' })}
                report={(message) => api.reportError(message)}
                seedApprovalId={null}
                onSeedConsumed={noop}
                onClose={close}
              />
            )}
            <div className="avb-foot">
              <span className="avb-foot-glyph">{GLYPH_ACTIONS.lock}</span>
              {t('avatarBubble.readOnly')}
            </div>
          </div>
        )}
      </div>
      <span className="avb-tail" aria-hidden="true" />
    </div>
  )
}
