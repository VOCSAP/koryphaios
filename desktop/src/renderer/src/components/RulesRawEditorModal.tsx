// Fallback editor for an INVALID rules file: the structured form in
// RuleEditorModal has nothing to bind to (the file may not even parse as
// JSON), so this is the raw text of the whole file, saved back verbatim
// through the same `rulesSaveGlobal`/`rulesSaveRepo` round-trip.

import { useState } from 'react'
import { GLYPH_ACTIONS } from './icons'
import type { RuleEditTarget } from './RuleEditorModal'
import { useT } from '../i18n'

interface Props {
  target: RuleEditTarget
  initialText: string
  /** `file.hash` of the file state this editor was opened from; null when the file was absent. */
  expectedHash: string | null
  onClose: () => void
  /** `approved` mirrors the save result: false when the fixed file is now saved but still pending approval. */
  onSaved: (approved: boolean) => void
  /** The save was refused because the file moved under us: the parent reloads instead of retrying. */
  onConflict: (reason: 'stale' | 'pending') => void
}

export function RulesRawEditorModal({ target, initialText, expectedHash, onClose, onSaved, onConflict }: Props): React.JSX.Element {
  const t = useT()
  const [text, setText] = useState(initialText)
  const [errors, setErrors] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    setSaving(true)
    setErrors([])
    try {
      const res =
        target.kind === 'global'
          ? await window.api.rulesSaveGlobal(text, expectedHash)
          : await window.api.rulesSaveRepo(target.projectDir, text, expectedHash)
      if (res.ok) onSaved(res.approved)
      else if (res.reason === 'stale' || res.reason === 'pending') onConflict(res.reason)
      else setErrors(res.errors)
    } catch (e) {
      window.api.reportError('rules', `save raw file failed: ${String(e)}`)
      setErrors([String(e)])
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal rules-raw-modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>{t('rules.rawJsonEditor')}</h2>
          <button className="icon-btn" title={t('common.close')} onClick={onClose}>
            {GLYPH_ACTIONS.close}
          </button>
        </header>
        <p className="rules-raw-help">{t('rules.rawJsonHelp')}</p>
        <textarea
          className="rules-raw-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={16}
          spellCheck={false}
        />
        {errors.length > 0 && (
          <ul className="rules-save-errors">
            {errors.map((err, i) => (
              <li key={i} className="field-error">
                {err}
              </li>
            ))}
          </ul>
        )}
        <div className="modal-actions">
          <button onClick={onClose}>{t('common.cancel')}</button>
          <button className="primary" disabled={saving} onClick={() => void save()}>
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
