import { useEffect, useState } from 'react'
import type { SessionTemplate, TemplateSession } from '@shared/template'
import { TEMPLATE_TYPE, TEMPLATE_VERSION } from '@shared/template'
import type { ModelOption } from '@shared/types'
import { GLYPH_ACTIONS, GLYPH_BADGES } from './icons'
import { useDeck } from '../store'
import { useT, type TFn } from '../i18n'

// Template composer (PLAN C18): create/edit a team template WITHOUT spawning
// anything. One card per entry with the advanced-create fields; at most one
// lead (radio semantics), rendered hierarchically: lead top-center, team below.

const EFFORT_LEVELS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const

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

function EntryCard({
  session,
  agents,
  models,
  onChange,
  onRemove,
  onLead,
  t
}: {
  session: TemplateSession
  agents: string[]
  models: ModelOption[]
  onChange: (next: TemplateSession) => void
  onRemove: () => void
  onLead: () => void
  t: TFn
}): React.JSX.Element {
  const set = (patch: Partial<TemplateSession>): void => onChange({ ...session, ...patch })
  return (
    <div className={`tc-card${session.lead ? ' tc-card-lead' : ''}`}>
      <div className="tc-card-head">
        <input
          type="color"
          className="swatch"
          value={session.color || '#4f86ff'}
          onChange={(e) => set({ color: e.target.value })}
        />
        <input
          className="tc-name"
          value={session.name}
          placeholder={t('composer.name')}
          onChange={(e) => set({ name: e.target.value })}
        />
        <label className="tc-lead-toggle" title={t('create.leadHelp')}>
          <input type="radio" checked={!!session.lead} onChange={onLead} />
          <span>{GLYPH_BADGES.laurel}</span>
        </label>
        <button className="row-btn row-btn-danger tc-remove" title={t('common.delete')} onClick={onRemove}>
          {GLYPH_ACTIONS.close}
        </button>
      </div>
      <div className="tc-grid">
        <label className="field">
          <span>{t('create.agent')}</span>
          <select value={session.agent ?? ''} onChange={(e) => set({ agent: e.target.value || undefined })}>
            <option value="">{t('create.agentDefault')}</option>
            {agents.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('create.model')}</span>
          <select value={session.model ?? ''} onChange={(e) => set({ model: e.target.value || undefined })}>
            <option value="">{t('create.modelDefault')}</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('create.effort')}</span>
          <select value={session.effort ?? ''} onChange={(e) => set({ effort: e.target.value || undefined })}>
            {EFFORT_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l || t('create.effortAuto')}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('composer.worktree')}</span>
          <input
            value={session.worktreeBranch ?? ''}
            placeholder={t('worktrees.branchPlaceholder')}
            onChange={(e) => set({ worktreeBranch: e.target.value || undefined })}
          />
        </label>
      </div>
      <label className="field">
        <span>{t('create.extraArgs')}</span>
        <input value={session.args ?? ''} onChange={(e) => set({ args: e.target.value || undefined })} />
      </label>
      <label className="field">
        <span>{t('create.prompt')}</span>
        <textarea
          rows={2}
          value={session.prompt ?? ''}
          onChange={(e) => set({ prompt: e.target.value || undefined })}
        />
      </label>
      <label className="field">
        <span>{t('create.announce')}</span>
        <input
          value={session.announce ?? ''}
          onChange={(e) => set({ announce: e.target.value || undefined })}
        />
      </label>
    </div>
  )
}

export function TemplateComposer({ path, onClose, onSaved }: Props): React.JSX.Element {
  const t = useT()
  const showToast = useDeck((s) => s.showToast)
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
