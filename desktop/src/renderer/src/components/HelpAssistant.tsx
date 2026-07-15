import { useEffect, useRef, useState } from 'react'
import type { HelpExchange } from '@shared/types'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { ContextMenu } from './ContextMenu'

// Floating "?" help assistant (PLAN C9). Each question is a throwaway
// `claude -p` invocation, view-aware through an app-generated system prompt --
// a decisions/comprehension advisor that technically cannot act (no MCP, no
// mutating tools). Right-click on the button: hide it or switch the model.

const MODELS = ['haiku', 'sonnet', 'opus']

interface Message extends HelpExchange {
  /** Answer pending (question sent, no reply yet). */
  pending?: boolean
  error?: boolean
}

export function HelpAssistant(): React.JSX.Element | null {
  const t = useT()
  const config = useDeck((s) => s.config!)
  const view = useDeck((s) => s.view)
  const updateConfig = useDeck((s) => s.updateConfig)

  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  // Keep the transcript pinned to the latest message.
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [messages, open])

  if (config.helpButton === false) return null

  const send = (): void => {
    const question = draft.trim()
    if (!question || busy) return
    setDraft('')
    setBusy(true)
    setMessages((m) => [...m, { question, answer: '', pending: true }])
    // Replay only completed exchanges for continuity (the CLI is stateless).
    const transcript = messages.filter((m) => !m.pending && !m.error)
    window.api.askHelp(question, view, transcript).then(
      (answer) => {
        setBusy(false)
        setMessages((m) =>
          m.map((msg) => (msg.pending ? { question: msg.question, answer } : msg))
        )
      },
      (e) => {
        setBusy(false)
        const detail = e instanceof Error ? e.message : String(e)
        setMessages((m) =>
          m.map((msg) =>
            msg.pending
              ? { question: msg.question, answer: t('help.failed', { error: detail }), error: true }
              : msg
          )
        )
      }
    )
  }

  return (
    <>
      {open && (
        <div className="help-popup">
          <header className="help-head">
            <span className="help-title">{t('help.title')}</span>
            <span className="help-model">{config.helpModel}</span>
            <button className="icon-btn" title={t('common.close')} onClick={() => setOpen(false)}>
              ✕
            </button>
          </header>
          <div className="help-log" ref={logRef}>
            {messages.length === 0 && <p className="help-hint">{t('help.hint')}</p>}
            {messages.map((m, i) => (
              <div key={i} className="help-exchange">
                <div className="help-q">{m.question}</div>
                <div className={`help-a${m.error ? ' help-a-error' : ''}`}>
                  {m.pending ? t('help.thinking') : m.answer}
                </div>
              </div>
            ))}
          </div>
          <div className="help-input-row">
            <textarea
              className="help-input"
              rows={2}
              value={draft}
              placeholder={t('help.placeholder')}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
            />
            <button className="primary" disabled={busy || !draft.trim()} onClick={send}>
              {t('help.send')}
            </button>
          </div>
        </div>
      )}

      <button
        className="help-fab"
        title={t('help.buttonTitle')}
        onClick={() => setOpen((o) => !o)}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenuPos({ x: e.clientX, y: e.clientY })
        }}
      >
        ?
      </button>

      {menuPos && (
        <ContextMenu
          x={menuPos.x}
          y={menuPos.y}
          onClose={() => setMenuPos(null)}
          items={[
            ...MODELS.map((m) => ({
              label: `${config.helpModel === m ? '✓ ' : ''}${t('help.model', { model: m })}`,
              onSelect: () => void updateConfig({ helpModel: m })
            })),
            {
              label: t('help.hide'),
              onSelect: () => {
                setOpen(false)
                void updateConfig({ helpButton: false })
              },
              danger: true
            }
          ]}
        />
      )}
    </>
  )
}
