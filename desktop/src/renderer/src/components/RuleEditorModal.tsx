// Voir/Éditer/Ajouter modal for one guard rule (Settings > Rules). Kory rules
// open read-only ('view'); global and repo rules open editable ('edit') or
// blank ('add'). Saving never PATCHes the rule in place: it rebuilds the whole
// file text for the target source (`existingRules` minus the original id, plus
// the draft) and hands it to `rulesSaveGlobal`/`rulesSaveRepo`, which is also
// where the real validation happens -- this form only narrows the choices it
// can offer (tools available for an event, fields compatible with the chosen
// tools) so a doomed combination is rare, not impossible.

import { useEffect, useMemo, useState } from 'react'
import {
  TTSR_EVENTS,
  TTSR_MODES,
  TTSR_TOOLS,
  type TtsrEvent,
  type TtsrField,
  type TtsrMode,
  type TtsrRule,
  type TtsrTool
} from '@shared/ttsr-types'
import type { TtsrTestResult } from '@shared/types'
import { GLYPH_ACTIONS } from './icons'
import { useT } from '../i18n'

export type RuleEditTarget = { kind: 'global' } | { kind: 'repo'; projectDir: string }

/** Same compatibility table as the shared validator (ttsr-rules.ts FIELD_TOOLS),
 * duplicated here for the narrowing only -- the save round-trip is what
 * actually enforces it, so a drift here only costs an extra error message,
 * never a rule that silently accepts an incompatible field. */
const TEXT_TOOLS: readonly TtsrTool[] = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']
const FIELD_TOOLS: Record<TtsrField, readonly TtsrTool[]> = {
  added: TEXT_TOOLS,
  file_path: TEXT_TOOLS,
  command: ['Bash'],
  output: ['Bash']
}
const ALL_FIELDS: readonly TtsrField[] = ['added', 'file_path', 'command', 'output']

const MESSAGE_MAX = 400

function availableTools(event: TtsrEvent): readonly TtsrTool[] {
  return event === 'PostToolUse' ? ['Bash'] : TTSR_TOOLS
}

function availableFields(event: TtsrEvent, tools: TtsrTool[]): TtsrField[] {
  return ALL_FIELDS.filter((f) => {
    if (f === 'output' && event !== 'PostToolUse') return false
    if (tools.length === 0) return false
    return tools.every((t) => FIELD_TOOLS[f].includes(t))
  })
}

interface Props {
  mode: 'view' | 'edit' | 'add'
  target: RuleEditTarget
  /** The rule as it currently exists in the file; null in 'add' mode. */
  rule: TtsrRule | null
  /** Every OTHER rule already in the target file's rules array (raw, unqualified). */
  existingRules: TtsrRule[]
  onClose: () => void
  onSaved: () => void
  /** Present only in 'edit' mode: asks the parent for a delete confirmation. */
  onDeleteRequested?: () => void
}

export function RuleEditorModal({ mode, target, rule, existingRules, onClose, onSaved, onDeleteRequested }: Props): React.JSX.Element {
  const t = useT()
  const readOnly = mode === 'view'

  const [id, setId] = useState(rule?.id ?? '')
  const [event, setEvent] = useState<TtsrEvent>(rule?.event ?? 'PreToolUse')
  const [tools, setTools] = useState<TtsrTool[]>(rule?.tools ?? ['Edit'])
  const [field, setField] = useState<TtsrField>(rule?.field ?? 'added')
  const [pathsText, setPathsText] = useState((rule?.paths ?? []).join('\n'))
  const [pattern, setPattern] = useState(rule?.pattern ?? '')
  const [flags, setFlags] = useState(rule?.flags ?? '')
  const [ruleMode, setRuleMode] = useState<TtsrMode>(rule?.mode ?? 'deny')
  const [message, setMessage] = useState(rule?.message ?? '')

  const [sampleText, setSampleText] = useState('')
  const [filePath, setFilePath] = useState('')
  const [testResult, setTestResult] = useState<TtsrTestResult | null>(null)
  const [testing, setTesting] = useState(false)

  const [saveErrors, setSaveErrors] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const toolChoices = availableTools(event)
  const fieldChoices = useMemo(() => availableFields(event, tools), [event, tools])

  // Keep the current selection inside what the event/tools pair still allows,
  // instead of letting the draft silently drift into a combination the save
  // round-trip is guaranteed to reject.
  useEffect(() => {
    if (readOnly) return
    const allowed = availableTools(event)
    setTools((prev) => {
      const kept = prev.filter((tl) => allowed.includes(tl))
      return kept.length > 0 ? kept : [allowed[0]!]
    })
    if (event === 'PostToolUse' && ruleMode === 'deny') setRuleMode('warn')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only `event` drives this narrowing
  }, [event, readOnly])

  useEffect(() => {
    if (readOnly) return
    if (!fieldChoices.includes(field) && fieldChoices.length > 0) setField(fieldChoices[0]!)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the choice set drives this narrowing
  }, [fieldChoices, field, readOnly])

  const toggleTool = (tl: TtsrTool, checked: boolean): void => {
    setTools((prev) => {
      if (checked) return prev.includes(tl) ? prev : [...prev, tl]
      const next = prev.filter((x) => x !== tl)
      return next.length > 0 ? next : prev // never leave the draft with zero tools
    })
  }

  const buildDraft = (): TtsrRule => {
    const draft: TtsrRule = {
      id: id.trim(),
      event,
      tools: [...tools],
      field,
      pattern,
      mode: ruleMode,
      message
    }
    const paths = pathsText
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
    if (paths.length > 0) draft.paths = paths
    if (flags.trim().length > 0) draft.flags = flags.trim()
    return draft
  }

  const runTest = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      const draft = buildDraft()
      const opts = filePath.trim().length > 0 ? { filePath: filePath.trim() } : undefined
      const result = await window.api.rulesTest(draft, sampleText, opts)
      setTestResult(result)
    } catch (e) {
      window.api.reportError('rules', `rulesTest failed: ${String(e)}`)
    } finally {
      setTesting(false)
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setSaveErrors([])
    try {
      const draft = buildDraft()
      const originalId = rule?.id ?? null
      const others = originalId !== null ? existingRules.filter((r) => r.id !== originalId) : existingRules
      const text = JSON.stringify({ version: 1, rules: [...others, draft] }, null, 2) + '\n'
      const res = target.kind === 'global' ? await window.api.rulesSaveGlobal(text) : await window.api.rulesSaveRepo(target.projectDir, text)
      if (res.ok) {
        onSaved()
      } else {
        setSaveErrors(res.errors)
      }
    } catch (e) {
      window.api.reportError('rules', `save rule failed: ${String(e)}`)
      setSaveErrors([String(e)])
    } finally {
      setSaving(false)
    }
  }

  const title = mode === 'view' ? t('rules.modalTitleView') : mode === 'add' ? t('rules.modalTitleAdd') : t('rules.modalTitleEdit')

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal rules-modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" title={t('common.close')} onClick={onClose}>
            {GLYPH_ACTIONS.close}
          </button>
        </header>

        <label className="field">
          <span>{t('rules.fieldId')}</span>
          <input value={id} readOnly={readOnly} onChange={(e) => setId(e.target.value)} placeholder="no-emoji-ui" />
        </label>

        <label className="field">
          <span>{t('rules.fieldEvent')}</span>
          <select value={event} disabled={readOnly} onChange={(e) => setEvent(e.target.value as TtsrEvent)}>
            {TTSR_EVENTS.map((ev) => (
              <option key={ev} value={ev}>
                {ev === 'PreToolUse' ? t('rules.eventPre') : t('rules.eventPost')}
              </option>
            ))}
          </select>
        </label>

        <div className="field">
          <span>{t('rules.fieldTools')}</span>
          <div className="rules-tools-row">
            {toolChoices.map((tl) => (
              <label key={tl} className="field-check rules-tool-check">
                <input
                  type="checkbox"
                  checked={tools.includes(tl)}
                  disabled={readOnly}
                  onChange={(e) => toggleTool(tl, e.target.checked)}
                />
                <span>{tl}</span>
              </label>
            ))}
          </div>
        </div>

        <label className="field">
          <span>{t('rules.fieldField')}</span>
          <select value={field} disabled={readOnly} onChange={(e) => setField(e.target.value as TtsrField)}>
            {fieldChoices.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>{t('rules.fieldPaths')}</span>
          <textarea
            value={pathsText}
            readOnly={readOnly}
            onChange={(e) => setPathsText(e.target.value)}
            placeholder={'desktop/src/renderer/**\n!desktop/src/renderer/**/*.test.ts'}
            rows={3}
          />
          <small>{t('rules.fieldPathsHelp')}</small>
        </label>

        <label className="field">
          <span>{t('rules.fieldPattern')}</span>
          <input value={pattern} readOnly={readOnly} onChange={(e) => setPattern(e.target.value)} />
        </label>

        <label className="field">
          <span>{t('rules.fieldFlags')}</span>
          <input value={flags} readOnly={readOnly} onChange={(e) => setFlags(e.target.value)} placeholder="imsu" />
        </label>

        <label className="field">
          <span>{t('rules.fieldMode')}</span>
          <select value={ruleMode} disabled={readOnly} onChange={(e) => setRuleMode(e.target.value as TtsrMode)}>
            {TTSR_MODES.map((m) => (
              <option key={m} value={m} disabled={m === 'deny' && event === 'PostToolUse'}>
                {m === 'deny' ? t('rules.modeDeny') : t('rules.modeWarn')}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>{t('rules.fieldMessage')}</span>
          <textarea
            value={message}
            readOnly={readOnly}
            maxLength={MESSAGE_MAX}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
          />
          <small>{t('rules.messageCounter', { count: message.length, max: MESSAGE_MAX })}</small>
        </label>

        {saveErrors.length > 0 && (
          <ul className="rules-save-errors">
            {saveErrors.map((err, i) => (
              <li key={i} className="field-error">
                {err}
              </li>
            ))}
          </ul>
        )}

        <div className="rules-test-zone">
          <h3>{t('rules.testTitle')}</h3>
          <label className="field">
            <span>{t('rules.testSampleText')}</span>
            <textarea value={sampleText} onChange={(e) => setSampleText(e.target.value)} rows={3} />
          </label>
          <label className="field">
            <span>{t('rules.testFilePath')}</span>
            <input value={filePath} onChange={(e) => setFilePath(e.target.value)} placeholder="desktop/src/renderer/App.tsx" />
          </label>
          <div>
            <button className="btn" disabled={testing || pattern.trim().length === 0} onClick={() => void runTest()}>
              {t('rules.testRun')}
            </button>
          </div>
          {testResult !== null && (
            <div className="rules-test-result">
              {!testResult.ok ? (
                <ul className="rules-save-errors">
                  {testResult.errors.map((err, i) => (
                    <li key={i} className="field-error">
                      {err}
                    </li>
                  ))}
                </ul>
              ) : testResult.timedOut ? (
                <span className="rules-test-timedout">{t('rules.testTimedOut')}</span>
              ) : testResult.matched ? (
                <span className="rules-test-matched">
                  {t('rules.testMatch')}
                  {testResult.pathMatched === false ? ` — ${t('rules.testPathNotMatched')}` : ''}
                </span>
              ) : (
                <span>{t('rules.testNoMatch')}</span>
              )}
            </div>
          )}
        </div>

        <div className="modal-actions rules-modal-actions">
          {mode === 'edit' && onDeleteRequested !== undefined && (
            <button className="btn danger" onClick={onDeleteRequested}>
              {t('rules.deleteRule')}
            </button>
          )}
          <button onClick={onClose}>{t('common.cancel')}</button>
          {!readOnly && (
            <button className="primary" disabled={saving || id.trim().length === 0 || pattern.trim().length === 0} onClick={() => void save()}>
              {t('common.save')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
