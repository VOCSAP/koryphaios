import { useEffect, useState } from 'react'
import type { LaunchPreset, ModelOption } from '@shared/types'
import type { ProviderCatalog } from '@shared/models'
import { defaultAnnounceDraft } from '@shared/announce'
import { mergeRoleChoices, sanitizeRole, TEAM_LEAD_ROLE } from '@shared/role'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { GLYPH_ACTIONS, GLYPH_BADGES } from './icons'
import { ModelPicker } from './ModelPicker'

/**
 * Advanced create popover: pick a subagent, a custom name + colour, a model, a
 * reasoning-effort level, free args, a preset, and (advanced) a different working
 * folder. Builds a single CreateSessionInput and spawns the session.
 */

/** Effort slider stops. Index 0 = Auto (omit --effort), then the CLI levels. */
const EFFORT_LEVELS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Sentinel <option> value opening the free-text role entry. Not a role itself:
 * it can never collide with one, since sanitizeRole() strips the dots.
 */
const ROLE_OTHER = '...other'

/**
 * A model id can take the `[1m]` (1M context window) suffix when it is a
 * concrete, non-Haiku model. Opus and Sonnet aliases and their full ids
 * qualify; Haiku does not support 1M, and the empty "default" choice has no id
 * to append to. Mirrors Claude Code: "Only append [1m] when the underlying
 * model supports 1M context."
 */
function supports1mContext(id: string): boolean {
  const m = id.trim().toLowerCase()
  return m !== '' && !m.includes('haiku')
}

/**
 * Anthropic section of the create-menu picker (C29): the launch-config models
 * (operator-curated, first) merged with the frontier catalog, deduped by id.
 * Forced available: agent sessions run the claude CLI by construction.
 */
function mergeCreateCatalogs(
  models: ModelOption[],
  catalogs: ProviderCatalog[]
): ProviderCatalog[] {
  const frontier = catalogs.find((c) => c.id === 'anthropic')
  const merged = [
    ...models.map((m) => ({ id: m.id, label: m.label })),
    ...(frontier?.models ?? []).filter((fm) => !models.some((m) => m.id === fm.id))
  ]
  return [
    {
      id: 'anthropic',
      name: frontier?.name ?? 'Anthropic',
      kind: 'frontier',
      cli: 'claude',
      available: true,
      models: merged
    }
  ]
}

export interface CreateMenuInitial {
  /** Pre-filled session name. */
  name?: string
  /** Pre-filled initial prompt (e.g. composed from a roadmap item, PLAN C3-M4). */
  prompt?: string
  /** Pre-filled join-announce note (marks it operator-authored: no auto-sync). */
  announce?: string
}

export function CreateMenu({
  onClose,
  initial,
  onCreate
}: {
  onClose: () => void
  /** Optional pre-filled fields (roadmap "launch an agent on this item"). */
  initial?: CreateMenuInitial
  /** Called right after the session is created (before the menu closes). */
  onCreate?: () => void
}): React.JSX.Element {
  const t = useT()
  const createSession = useDeck((s) => s.createSession)
  const sessions = useDeck((s) => s.sessions)
  const config = useDeck((s) => s.config!)
  // Team-lead (PLAN C10): explicit checkbox; the leadPattern match only
  // pre-checks it when the seat is free. The operator always has final say.
  const hasLead = sessions.some((s) => s.lead)
  const [lead, setLead] = useState(false)
  const [leadTouched, setLeadTouched] = useState(false)

  // Peer role (card a2f61172): what this agent DOES. Independent of the laurel
  // above.
  // Card 015c9c97: team-lead is REMOVED from this list -- the laurel checkbox
  // above is the SOLE way to name a team-lead in this panel. It is projected
  // onto `role` only at submit time (see `effectiveRole` below), never by
  // mutating this dropdown's state. mergeRoleChoices/BUILTIN_ROLES stay
  // untouched (TemplateComposer.tsx still lists team-lead there, out of
  // scope for this card).
  const updateConfig = useDeck((s) => s.updateConfig)
  const roleChoices = mergeRoleChoices(config.roleChoices ?? []).filter((r) => r !== TEAM_LEAD_ROLE)
  const [role, setRole] = useState('')
  const [roleOther, setRoleOther] = useState(false)
  const [roleDraft, setRoleDraft] = useState('')

  const [agents, setAgents] = useState<string[]>([])
  const [presets, setPresets] = useState<LaunchPreset[]>([])
  const [models, setModels] = useState<ModelOption[]>([])
  // Unified picker catalogs (C29): the Anthropic section + favorites, since
  // agent sessions always run the claude CLI.
  const [catalogs, setCatalogs] = useState<ProviderCatalog[]>([])
  const [agent, setAgent] = useState('')
  const [name, setName] = useState(initial?.name ?? '')
  const [model, setModel] = useState('')
  // Extended 1M context: appends the `[1m]` suffix to the model id (Claude Code
  // strips it before calling the provider). Only meaningful on a 1M-capable
  // model (Opus / Sonnet, not Haiku) and only when a concrete model is picked.
  const [extended, setExtended] = useState(false)
  const [effortIdx, setEffortIdx] = useState(0)
  const [extraArgs, setExtraArgs] = useState('')
  // Initial prompt, submitted as Claude's positional argument on the fresh
  // launch (PLAN C2). Presets with a `prompt` pre-fill it (last preset wins).
  const [prompt, setPrompt] = useState(initial?.prompt ?? '')
  const [color, setColor] = useState('#4f86ff')
  const [customColor, setCustomColor] = useState(false)
  const [folder, setFolder] = useState<string | null>(null)
  // Worktree branch (PLAN C4): non-empty = spawn in a fresh git worktree on
  // this new branch (under <projectDir>/.worktrees). Mutually exclusive with a
  // custom working folder (the worktree IS the working folder).
  const [worktreeBranch, setWorktreeBranch] = useState('')
  // Join-announce note, pre-filled with the agent/model/effort summary. It tracks
  // those choices until the operator edits it (then it stays as authored). An
  // initial.announce counts as authored from the start.
  const [announce, setAnnounce] = useState(initial?.announce ?? '')
  const [announceTouched, setAnnounceTouched] = useState(!!initial?.announce)

  useEffect(() => {
    void window.api.listAgents().then(setAgents)
    void window.api.getLaunchConfig().then((c) => {
      setPresets(c.presets)
      setModels(c.models)
    })
    void window.api.modelCatalogs().then(setCatalogs)
    // Seed the colour swatch with the real colour the session would receive, so
    // the preview is honest even when the user does not pick a custom colour.
    void window.api.peekNextColor().then(setColor)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Whether the 1M toggle applies to the current pick, and the model id actually
  // submitted (base id, or `<id>[1m]` when extended context is requested).
  const canExtend = supports1mContext(model)
  const use1m = extended && canExtend
  const effectiveModel = use1m ? `${model}[1m]` : model

  // Keep the announce draft synced to the agent/model/effort choices until the
  // operator edits it (then it stays as authored). Uses the effective model so
  // the join note reflects the `[1m]` suffix when extended context is on.
  useEffect(() => {
    if (announceTouched) return
    setAnnounce(defaultAnnounceDraft({ agent, model: effectiveModel, effort: EFFORT_LEVELS[effortIdx] ?? '' }))
  }, [agent, effectiveModel, effortIdx, announceTouched])

  const applyPreset = (p: LaunchPreset): void => {
    setExtraArgs((prev) => [prev.trim(), p.args.trim()].filter(Boolean).join(' '))
    if (p.prompt?.trim()) setPrompt(p.prompt.trim())
  }

  const browse = async (): Promise<void> => {
    const dir = await window.api.pickDirectory()
    if (dir) setFolder(dir)
  }

  // Auto-name preview: the agent name, else "peer". The main process appends the
  // smallest free numeric suffix when this collides with a live session.
  const namePreview = agent.trim() || 'peer'
  const effortLevel = EFFORT_LEVELS[effortIdx]

  // Suggest team-lead while untouched: pattern matches AND the seat is free.
  useEffect(() => {
    if (leadTouched) return
    const pattern = (config.leadPattern ?? '').trim().toLowerCase()
    const candidate = `${agent} ${name}`.toLowerCase()
    setLead(!hasLead && pattern !== '' && candidate.includes(pattern))
  }, [agent, name, hasLead, leadTouched, config.leadPattern])

  /** Commit the free-text role: normalise, remember it for next time, select it. */
  const addRole = (): void => {
    const value = sanitizeRole(roleDraft)
    setRoleOther(false)
    setRoleDraft('')
    if (!value) return
    // Card 015c9c97: team-lead can only be named via the laurel checkbox, not
    // through this free-text escape hatch.
    if (value === TEAM_LEAD_ROLE) return
    setRole(value)
    // Persisted in the operator-GLOBAL config, like modelFavorites. Built-ins
    // and already-known roles are filtered by mergeRoleChoices on read, but
    // guard here too so the stored list does not grow duplicates.
    if (!roleChoices.includes(value)) {
      void updateConfig({ roleChoices: [...(config.roleChoices ?? []), value] })
    }
  }

  // Card 015c9c97: the laurel checkbox is the sole way to name a team-lead --
  // the submitted role is derived from it here, never from the dropdown
  // (which never offers TEAM_LEAD_ROLE as a choice, see roleChoices above).
  const effectiveRole = lead ? TEAM_LEAD_ROLE : role

  const submit = (): void => {
    void createSession({
      name: name.trim() || undefined,
      agent: agent || undefined,
      model: effectiveModel || undefined,
      effort: effortLevel || undefined,
      role: effectiveRole || undefined,
      args: extraArgs.trim() || undefined,
      prompt: prompt.trim() || undefined,
      worktreeBranch: worktreeBranch.trim() || undefined,
      // A worktree session ignores the custom folder: the worktree is the cwd.
      cwd: worktreeBranch.trim() ? undefined : (folder ?? undefined),
      // Only force a colour when the user explicitly picked one; otherwise the
      // main process assigns the next palette colour at spawn time.
      color: customColor ? color : undefined,
      announce: announce.trim() || undefined,
      lead: lead || undefined
    })
    onCreate?.()
    onClose()
  }

  return (
    <div className="popover-backdrop" onMouseDown={onClose}>
      <div className="popover" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{t('create.title')}</h3>

        <label className="field">
          <span>{t('create.agent')}</span>
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">{t('create.agentDefault')}</option>
            {agents.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>

        <div className="field create-name-row">
          <label className="field create-name-field">
            <span>{t('create.name')}</span>
            <input value={name} placeholder={namePreview} onChange={(e) => setName(e.target.value)} />
          </label>
          {/* Colour control: a palette swatch + label painted in the chosen
              colour. Clicking opens the native picker (label wraps the input). */}
          <label className="colour-btn" title={t('create.colourTitle')}>
            <span className="colour-dot" style={{ background: color }} />
            <span style={{ color }}>{t('create.customColour')}</span>
            <input
              type="color"
              className="colour-hidden"
              value={color}
              onChange={(e) => {
                setColor(e.target.value)
                setCustomColor(true)
              }}
            />
          </label>
        </div>

        {/* Peer role (card a2f61172): what this agent DOES, exported to the
            session as CLAUDE_PEERS_ROLE. An OPERATOR gesture only -- no agent
            path sets it. Optional: "no role" is the default and leaves the
            launch strictly as it was before this control existed.
            Card 015c9c97: greyed out whenever the laurel checkbox is checked,
            regardless of its own value -- the checkbox is the only source of
            'team-lead' in this panel (see `effectiveRole` in submit). */}
        <div className="field" title={t('create.roleHelp')} aria-disabled={lead}>
          <span>{t('create.role')}</span>
          <select
            disabled={lead}
            value={roleOther ? ROLE_OTHER : role}
            onChange={(e) => {
              const picked = e.target.value
              if (picked === ROLE_OTHER) {
                setRoleOther(true)
                setRole('')
                return
              }
              setRoleOther(false)
              setRole(picked)
            }}
          >
            <option value="">{t('create.roleNone')}</option>
            {roleChoices.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
            <option value={ROLE_OTHER}>{t('create.roleOther')}</option>
          </select>
          {roleOther && (
            <div className="field-row">
              <input
                autoFocus
                disabled={lead}
                value={roleDraft}
                placeholder={t('create.rolePlaceholder')}
                onChange={(e) => setRoleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addRole()
                }}
              />
              <button className="icon-btn" disabled={lead} onClick={addRole} title={t('create.roleAdd')}>
                {GLYPH_ACTIONS.plus}
              </button>
            </div>
          )}
          {/* One line only: this field sits high in the form, and a 3-line
              note here pushed the whole model block down. The full nuance
              (independence from the laurel) lives in the field's title. */}
          <small>{t('create.roleShort')}</small>
        </div>

        <div className="field">
          <span>{t('create.model')}</span>
          {/* Unified picker (C29): launch-config models first (operator-curated),
              then the frontier Anthropic catalog; favorites pinned below the
              separator. Always shown even if CLI detection failed — without
              claude there would be no sessions at all. */}
          <div className="create-model-picker">
            <div
              className={`mp-model${model === '' ? ' is-selected' : ''}`}
              onClick={() => setModel('')}
            >
              <span className="mp-model-name">{t('create.modelDefault')}</span>
            </div>
            <ModelPicker
              catalogs={mergeCreateCatalogs(models, catalogs)}
              selected={[`anthropic:${model}`]}
              multi={false}
              onlyProviders={['anthropic']}
              onPick={(_key, target) => setModel(target.model)}
            />
          </div>
        </div>

        <label className="field field-check" title={t('create.leadHelp')}>
          <input
            type="checkbox"
            checked={lead}
            onChange={(e) => {
              setLead(e.target.checked)
              setLeadTouched(true)
            }}
          />
          <span>
            {GLYPH_BADGES.laurel} {t('create.lead')}
            {hasLead && !lead ? ` — ${t('create.leadTaken')}` : ''}
          </span>
        </label>

        <label
          className="field field-check"
          title={t('create.extendedContextHelp')}
          aria-disabled={!canExtend}
        >
          <input
            type="checkbox"
            checked={use1m}
            disabled={!canExtend}
            onChange={(e) => setExtended(e.target.checked)}
          />
          <span>{t('create.extendedContext')}</span>
        </label>

        <div className="field">
          <span>
            {t('create.effort')}: <strong>{effortLevel || t('create.effortAuto')}</strong>
          </span>
          <input
            type="range"
            min={0}
            max={EFFORT_LEVELS.length - 1}
            step={1}
            value={effortIdx}
            onChange={(e) => setEffortIdx(Number(e.target.value))}
          />
          <div className="effort-ends">
            <span>{t('create.effortFaster')}</span>
            <span>{t('create.effortSmarter')}</span>
          </div>
        </div>

        {presets.length > 0 && (
          <div className="field">
            <span>{t('create.presets')}</span>
            <div className="preset-row">
              {presets.map((p) => (
                <button key={p.label} className="chip" onClick={() => applyPreset(p)} title={p.args}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <label className="field">
          <span>{t('create.extraArgs')}</span>
          <input
            value={extraArgs}
            placeholder={t('create.extraArgsPlaceholder')}
            onChange={(e) => setExtraArgs(e.target.value)}
          />
        </label>

        <label className="field">
          <span>{t('create.prompt')}</span>
          <textarea
            className="announce-input"
            rows={2}
            value={prompt}
            placeholder={t('create.promptPlaceholder')}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <small>{t('create.promptHelp')}</small>
        </label>

        <label className="field">
          <span>{t('create.announce')}</span>
          <textarea
            className="announce-input"
            rows={2}
            value={announce}
            placeholder={t('create.announcePlaceholder')}
            onChange={(e) => {
              setAnnounce(e.target.value)
              setAnnounceTouched(true)
            }}
          />
          <small>{t('create.announceHelp')}</small>
        </label>

        <details className="advanced">
          <summary>{t('create.advanced')}</summary>
          <div className="field">
            <span>{t('create.worktree')}</span>
            <input
              value={worktreeBranch}
              placeholder={t('create.worktreePlaceholder', { name: namePreview })}
              onChange={(e) => setWorktreeBranch(e.target.value)}
            />
            <small>{t('create.worktreeHelp')}</small>
          </div>
          <div className="field">
            <span>{t('create.workingFolder')}</span>
            <div className="field-row">
              <input
                value={folder ?? ''}
                placeholder={t('create.workingFolderPlaceholder')}
                onChange={(e) => setFolder(e.target.value || null)}
              />
              <button className="icon-btn" onClick={browse} title={t('common.browse')}>
                {GLYPH_ACTIONS.folder}
              </button>
            </div>
            <small>{t('create.workingFolderHelp')}</small>
          </div>
        </details>

        <div className="modal-actions">
          <button onClick={onClose}>{t('common.cancel')}</button>
          <button className="primary" onClick={submit}>
            {t('common.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
