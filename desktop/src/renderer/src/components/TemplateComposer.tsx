import { useEffect, useState } from 'react'
import type { SessionTemplate, TemplateSession } from '@shared/template'
import { TEMPLATE_TYPE, TEMPLATE_VERSION } from '@shared/template'
import type { ModelOption } from '@shared/types'
import { mergeRoleChoices } from '@shared/role'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { EntryCard } from './TemplateEntryCard'

// Template composer (PLAN C18): create/edit a team template WITHOUT spawning
// anything. One card per entry with the advanced-create fields; at most one
// lead (radio semantics), rendered hierarchically: lead top-center, team below.

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
  // Peer role (card 0b9e0b07 lot B): the same operator-global list CreateMenu
  // reads (config.roleChoices), merged with the built-ins the same way.
  const config = useDeck((s) => s.config!)
  const roleChoices = mergeRoleChoices(config.roleChoices ?? [])
  const [name, setName] = useState('')
  const [local, setLocal] = useState(false)
  const [sessions, setSessions] = useState<TemplateSession[]>([emptySession(1)])
  const [agents, setAgents] = useState<string[]>([])
  const [models, setModels] = useState<ModelOption[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.listAgents().then(setAgents, () => undefined)
    void window.api.getLaunchConfig().then((cfg) => setModels(cfg.models), () => undefined)
    if (!path) return
    void window.api.readTemplateFile(path).then((tpl) => {
      if (!tpl) return
      setName(tpl.name ?? '')
      setLocal(path.includes('.claude'))
      if (tpl.sessions.length > 0) setSessions(tpl.sessions.map((s) => ({ ...s })))
    })
  }, [path])

  const update = (idx: number, next: TemplateSession): void =>
    setSessions((all) => all.map((s, i) => (i === idx ? next : s)))
  const remove = (idx: number): void => setSessions((all) => all.filter((_, i) => i !== idx))
  // Radio semantics: crowning one entry demotes every other (single lead).
  const setLead = (idx: number): void =>
    setSessions((all) => all.map((s, i) => ({ ...s, lead: i === idx ? true : undefined })))

  const save = async (): Promise<void> => {
    const clean = sessions.filter((s) => s.name.trim() !== '')
    if (!name.trim() || clean.length === 0) return
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
                models={models}
                roleChoices={roleChoices}
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
                  models={models}
                  roleChoices={roleChoices}
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
            disabled={!name.trim() || sessions.every((s) => !s.name.trim())}
            onClick={() => void save()}
          >
            {t('composer.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
