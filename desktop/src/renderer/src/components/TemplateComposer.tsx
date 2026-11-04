import { useEffect, useState } from 'react'
import type { SessionTemplate, TemplateSession } from '@shared/template'
import { TEMPLATE_TYPE, TEMPLATE_VERSION } from '@shared/template'
import { errorText, useDeck } from '../store'
import { useT } from '../i18n'
import { entryHasInvalidContext, liftEntryLaunchOptions } from '../peer-options'
import { useModelChoices } from '../use-model-choices'
import { EntryCard } from './TemplateEntryCard'

// Template composer (PLAN C18): create/edit a team template WITHOUT spawning
// anything; at most one lead, rendered top-center with the team below.

interface Props {
  /** Template file to edit, or null to compose a fresh one. */
  path: string | null
  onClose: () => void
  /** Called after a successful save (the picker refreshes its list). */
  onSaved: () => void
}

function emptySession(n: number): TemplateSession {
  return { name: `agent-${n}` }
}

export function TemplateComposer({ path, onClose, onSaved }: Props): React.JSX.Element {
  const t = useT()
  const showToast = useDeck((s) => s.showToast)
  const { catalogs, sandboxOn } = useModelChoices()
  const [name, setName] = useState('')
  const [local, setLocal] = useState(false)
  const [sessions, setSessions] = useState<TemplateSession[]>([emptySession(1)])
  const [agents, setAgents] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.listAgents().then(setAgents, (e: unknown) => {
      window.api.reportError('templates', `list agents failed: ${errorText(e)}`)
    })
    if (!path) return
    void window.api.readTemplateFile(path).then((tpl) => {
      if (!tpl) return
      setName(tpl.name ?? '')
      setLocal(path.includes('.claude'))
      if (tpl.sessions.length > 0) setSessions(tpl.sessions.map((s) => liftEntryLaunchOptions({ ...s })))
    })
  }, [path])

  const update = (idx: number, next: TemplateSession): void =>
    setSessions((all) => all.map((s, i) => (i === idx ? next : s)))
  const remove = (idx: number): void => setSessions((all) => all.filter((_, i) => i !== idx))
  // Crowning one entry demotes every other; crowning the lead again clears it.
  const setLead = (idx: number): void =>
    setSessions((all) =>
      all.map((s, i) => ({ ...s, lead: i === idx && !s.lead ? true : undefined }))
    )

  // A blank-named entry is dropped at save, so only kept entries can block it.
  const kept = sessions.filter((s) => s.name.trim() !== '')
  const contextInvalid = kept.some(entryHasInvalidContext)

  const save = async (): Promise<void> => {
    const clean = kept
    if (!name.trim() || clean.length === 0 || contextInvalid) return
    const tpl: SessionTemplate = {
      type: TEMPLATE_TYPE,
      version: TEMPLATE_VERSION,
      name: name.trim(),
      sessions: clean
    }
    try {
      await window.api.writeTemplateFile(name.trim(), local, tpl)
      showToast('toast.templateSaved')
      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const leadIdx = sessions.findIndex((s) => s.lead)

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal tc-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{path ? t('composer.editTitle') : t('composer.createTitle')}</h2>
        <div className="tc-meta">
          <label className="field tc-meta-name">
            <span>{t('composer.templateName')}</span>
            <input value={name} autoFocus onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="roadmap-archived-toggle">
            <input type="checkbox" checked={local} onChange={(e) => setLocal(e.target.checked)} />
            <span>{t('template.localCheckbox')}</span>
          </label>
        </div>

        {error && <div className="roadmap-error">{error}</div>}

        <div className="tc-body">
          {/* Hierarchy: the lead sits alone on top, the team below (PLAN C18). */}
          {leadIdx !== -1 && (
            <div className="tc-lead-row">
              <EntryCard
                session={sessions[leadIdx]!}
                agents={agents}
                catalogs={catalogs}
                sandboxOn={sandboxOn}
                onChange={(next) => update(leadIdx, next)}
                onRemove={() => remove(leadIdx)}
                onLead={() => setLead(leadIdx)}
                t={t}
              />
            </div>
          )}
          <div className="tc-team-row">
            {sessions.map((s, i) =>
              i === leadIdx ? null : (
                <EntryCard
                  key={i}
                  session={s}
                  agents={agents}
                  catalogs={catalogs}
                  sandboxOn={sandboxOn}
                  onChange={(next) => update(i, next)}
                  onRemove={() => remove(i)}
                  onLead={() => setLead(i)}
                  t={t}
                />
              )
            )}
          </div>
          <button
            className="btn"
            onClick={() => setSessions((all) => [...all, emptySession(all.length + 1)])}
          >
            {t('composer.addSession')}
          </button>
        </div>

        <div className="modal-actions">
          <button onClick={onClose}>{t('common.cancel')}</button>
          <button
            className="primary"
            disabled={!name.trim() || kept.length === 0 || contextInvalid}
            onClick={() => void save()}
          >
            {t('composer.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
