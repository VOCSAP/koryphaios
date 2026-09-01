import { useEffect, useRef, useState } from 'react'
import type { ElementPick, PickAnnotationIntent, PickAnnotationPriority, PickNote } from '@shared/types'
import { PICK_BUDGET } from '@shared/pick-security'
import { GLYPH_BADGES } from './icons'
import { useT } from '../i18n'

/**
 * Pick-context dialog (`pickContextPrompt` flag, DeckConfig): opens right
 * after an element pick -- the webview's inspect mode (BrowserView.tsx) or an
 * external app's pick over the design endpoint (App.tsx's onDesignPick) --
 * so the operator can add an optional note/intent/priority before the prompt
 * is composed and delivered. Pure and prop-driven, no `useDeck`, modelled on
 * ConfirmDialog.tsx: both call sites already hold everything this needs
 * (the pick, the best-effort screenshot's status, and what to do on
 * send/cancel), and staying prop-driven keeps it mountable in isolation here
 * and in tests/desktop-pick-context-dialog.test.ts.
 *
 * `pick` is HOSTILE input -- every field on it was read off the inspected
 * page, not typed by the operator -- so the summary below renders it as text
 * nodes only (plain JSX interpolation), never `dangerouslySetInnerHTML` or a
 * hand-built HTML string. `formatPickDetails` (shared/pick-prompt.ts) does
 * the actual prompt composition from the returned `PickNote`; this component
 * never pre-formats the note itself.
 */
export function PickContextDialog({
  pick,
  shot,
  onSend,
  onCancel
}: {
  pick: ElementPick
  /** Best-effort element screenshot: 'pending' while captureElementShot is
   *  still in flight, 'ready' once it resolved to a path, 'none' when it
   *  will never run (no capture capability, e.g. the external-app pick path)
   *  or resolved to null. */
  shot: 'pending' | 'ready' | 'none'
  onSend: (note: PickNote, dontAskAgain: boolean) => void
  onCancel: () => void
}): React.JSX.Element {
  const t = useT()
  const [comment, setComment] = useState('')
  const [intent, setIntent] = useState<PickAnnotationIntent | ''>('')
  const [priority, setPriority] = useState<PickAnnotationPriority | ''>('')
  const [dontAskAgain, setDontAskAgain] = useState(false)

  const selector = pick.selectors[0]?.value ?? pick.tagName

  function send(): void {
    onSend({ comment, intent: intent || undefined, priority: priority || undefined }, dontAskAgain)
  }

  // Refs so the window-level keydown listener below (mounted once) always
  // acts on the LATEST render's closures -- same discipline BrowserView.tsx
  // uses for its stable webview listeners -- rather than re-subscribing the
  // listener on every keystroke just to keep `send`/`onCancel` fresh.
  const sendRef = useRef(send)
  sendRef.current = send
  const onCancelRef = useRef(onCancel)
  onCancelRef.current = onCancel

  // Escape cancels, Ctrl/Cmd+Enter sends -- from anywhere in the dialog,
  // textarea and selects included, since keydown bubbles to window and
  // nothing inside here stops it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancelRef.current()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        sendRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const shotStatus =
    shot === 'pending'
      ? t('browser.pickContextShotPending')
      : shot === 'ready'
        ? t('browser.pickContextShotReady')
        : t('browser.pickContextShotNone')

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal modal-pick-context" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{t('browser.pickContextTitle')}</h2>
        <p className="pick-context-summary">
          {t('browser.pickContextSummary', {
            tag: pick.tagName,
            w: pick.width,
            h: pick.height,
            selector
          })}
        </p>
        {pick.sourceFile && <p className="pick-context-summary">{`source: ${pick.sourceFile}`}</p>}
        <textarea
          className="annotate-comment"
          rows={4}
          autoFocus
          maxLength={PICK_BUDGET.annotationCommentMaxLength}
          placeholder={t('browser.pickContextPlaceholder')}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        <div className="annotate-row-selects">
          <select
            className="annotate-select"
            title={t('browser.annotateIntentLabel')}
            value={intent}
            onChange={(e) => setIntent(e.target.value as PickAnnotationIntent | '')}
          >
            <option value="">{t('browser.pickContextIntentUnset')}</option>
            <option value="fix">{t('browser.annotateIntentFix')}</option>
            <option value="change">{t('browser.annotateIntentChange')}</option>
            <option value="question">{t('browser.annotateIntentQuestion')}</option>
            <option value="approve">{t('browser.annotateIntentApprove')}</option>
          </select>
          <select
            className="annotate-select"
            title={t('browser.annotatePriorityLabel')}
            value={priority}
            onChange={(e) => setPriority(e.target.value as PickAnnotationPriority | '')}
          >
            <option value="">{t('browser.pickContextPriorityUnset')}</option>
            <option value="blocking">{t('browser.annotatePriorityBlocking')}</option>
            <option value="important">{t('browser.annotatePriorityImportant')}</option>
            <option value="suggestion">{t('browser.annotatePrioritySuggestion')}</option>
          </select>
        </div>
        <p className="pick-context-summary">{shotStatus}</p>
        {/* "Don't ask again" toggle: the GLYPH_BADGES.checkboxOn/Off row
            button RoadmapFilterPanel.tsx/ModelPicker.tsx already use for a
            themed checkbox, not a native `<input type="checkbox">` --
            DESIGN.md §3 names that element as still unstyled/native (11
            sites, card 0d57a60c) and this dialog should not become a 12th.
            `.rm-filter-value` is self-contained (no dependency on a filter
            panel ancestor), so it is reused verbatim here. */}
        <button
          type="button"
          className={`rm-filter-value${dontAskAgain ? ' is-on' : ''}`}
          onClick={() => setDontAskAgain((v) => !v)}
        >
          {dontAskAgain ? GLYPH_BADGES.checkboxOn : GLYPH_BADGES.checkboxOff}
          <span className="rm-filter-value-label">{t('browser.pickContextDontAsk')}</span>
        </button>
        <div className="modal-actions">
          <button onClick={onCancel}>{t('common.cancel')}</button>
          <button className="primary" onClick={send}>
            {t('browser.pickContextSend')}
          </button>
        </div>
      </div>
    </div>
  )
}
