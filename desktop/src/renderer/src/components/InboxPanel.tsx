import { useEffect, useRef } from 'react'
import { GLYPH_ACTIONS } from './icons'
import { useDeck } from '../store'
import { useT } from '../i18n'

/**
 * Operator inbox (PLAN C12): the messages agents addressed to the reserved
 * 'operator' peer, drained from the broker by the main process. Read-only
 * overlay anchored next to the nav rail — replying happens through the
 * existing announce megaphone (MessageBar), not from here.
 */
export function InboxPanel(): React.JSX.Element {
  const t = useT()
  const messages = useDeck((s) => s.inboxMessages)
  const drafts = useDeck((s) => s.graphDrafts)
  const openInbox = useDeck((s) => s.openInbox)
  const openGraphDraft = useDeck((s) => s.openGraphDraft)
  const endRef = useRef<HTMLDivElement>(null)

  // Keep the newest message in view (list is oldest-first, like a chat).
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

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
        {messages.length === 0 && drafts.length === 0 && (
          <div className="inbox-empty">{t('inbox.empty')}</div>
        )}
        {messages.map((m) => (
          <div key={m.id} className="inbox-msg">
            <div className="inbox-msg-meta">
              <span className="inbox-msg-from">{m.from}</span>
              <span className="inbox-msg-time">{new Date(m.sentAt).toLocaleTimeString()}</span>
            </div>
            <div className="inbox-msg-text">{m.text}</div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="inbox-hint">{t('inbox.hint')}</div>
    </div>
  )
}
