import { useEffect, useRef, useState } from 'react'
import type { HelpExchange, HelpSelection } from '@shared/types'
import { targetLabel } from '@shared/models'
import { GLYPH_ACTIONS, GLYPH_BADGES } from './icons'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { ContextMenu } from './ContextMenu'

// Floating "?" help assistant (PLAN C9). Each question is a throwaway
// headless invocation against the configured target (config.helpTarget, any
// provider of the unified catalog — lot A), view-aware through an
// app-generated system prompt -- a decisions/comprehension advisor that
// technically cannot act (no MCP, no mutating tools). Right-click on the
// button: hide it or quick-switch among the Claude aliases (the full catalog
// choice lives in Settings > Models).

const QUICK_MODELS = ['haiku', 'sonnet', 'opus']

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
  const helpSeed = useDeck((s) => s.helpSeed)
  const clearHelpSeed = useDeck((s) => s.clearHelpSeed)

  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  /** Files-view code selection attached to the NEXT question (PLAN GX7). */
  const [selection, setSelection] = useState<HelpSelection | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  // Keep the transcript pinned to the latest message.
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [messages, open])

  // Seed from the Files view (PLAN GX7): open prefilled, attach the selection.
  // Sending stays a manual operator action.
  useEffect(() => {
    if (!helpSeed) return
    setOpen(true)
    setDraft(helpSeed.question)
    setSelection(helpSeed.selection)
    clearHelpSeed()
  }, [helpSeed, clearHelpSeed])

  if (config.helpButton === false) return null

  // Resume digest (PLAN C17): fixed question, sources configured globally.
  const digest = (): void => {
    if (busy) return
    setBusy(true)
    setMessages((m) => [...m, { question: t('help.digestQuestion'), answer: '', pending: true }])
    window.api.askDigest().then(
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

  const send = (): void => {
    const question = draft.trim()
    if (!question || busy) return
    setDraft('')
    setBusy(true)
    setMessages((m) => [...m, { question, answer: '', pending: true }])
    // Replay only completed exchanges for continuity (the CLI is stateless).
    const transcript = messages.filter((m) => !m.pending && !m.error)
    // The attached selection is one-shot: it rides this question's snapshot.
    const attached = selection ?? undefined
    setSelection(null)
    window.api.askHelp(question, view, transcript, attached).then(
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
            <button
              className="icon-btn"
              title={t('help.digestTitle')}
              disabled={busy}
              onClick={digest}
            >
              {GLYPH_ACTIONS.copy}
            </button>
            <span className="help-model">{targetLabel(config.helpTarget)}</span>
            <button className="icon-btn" title={t('common.close')} onClick={() => setOpen(false)}>
              {GLYPH_ACTIONS.close}
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
          {selection && (
            <div className="help-selection">
              <span className="help-selection-ref" title={selection.text.slice(0, 500)}>
                {GLYPH_BADGES.clip} {selection.file}:{selection.startLine}–{selection.endLine}
              </span>
              <button
                className="icon-btn"
                title={t('help.detachSelection')}
                onClick={() => setSelection(null)}
              >
                {GLYPH_ACTIONS.close}
              </button>
            </div>
          )}
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
            ...QUICK_MODELS.map((m) => ({
              label: (
                <>
                  {config.helpTarget.cli === 'claude' && config.helpTarget.model === m ? (
                    <span className="ctx-icon">{GLYPH_ACTIONS.check}</span>
                  ) : null}{' '}
                  {t('help.model', { model: m })}
                </>
              ),
              onSelect: () => void updateConfig({ helpTarget: { cli: 'claude', model: m } })
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
