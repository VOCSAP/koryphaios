import { useEffect, useState } from 'react'
import type { LaunchPreset, ModelOption } from '@shared/types'
import { defaultAnnounceDraft } from '@shared/announce'
import { useDeck } from '../store'
import { useT } from '../i18n'

/**
 * Advanced create popover: pick a subagent, a custom name + colour, a model, a
 * reasoning-effort level, free args, a preset, and (advanced) a different working
 * folder. Builds a single CreateSessionInput and spawns the session.
 */

/** Effort slider stops. Index 0 = Auto (omit --effort), then the CLI levels. */
const EFFORT_LEVELS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const

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

  const [agents, setAgents] = useState<string[]>([])
  const [presets, setPresets] = useState<LaunchPreset[]>([])
  const [models, setModels] = useState<ModelOption[]>([])
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

  const submit = (): void => {
    void createSession({
      name: name.trim() || undefined,
      agent: agent || undefined,
      model: effectiveModel || undefined,
      effort: effortLevel || undefined,
      args: extraArgs.trim() || undefined,
      prompt: prompt.trim() || undefined,
      cwd: folder ?? undefined,
      // Only force a colour when the user explicitly picked one; otherwise the
      // main process assigns the next palette colour at spawn time.
      color: customColor ? color : undefined,
      announce: announce.trim() || undefined
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

        <label className="field">
          <span>{t('create.model')}</span>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">{t('create.modelDefault')}</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
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
            <span>{t('create.workingFolder')}</span>
            <div className="field-row">
              <input
                value={folder ?? ''}
                placeholder={t('create.workingFolderPlaceholder')}
                onChange={(e) => setFolder(e.target.value || null)}
              />
              <button className="icon-btn" onClick={browse} title={t('common.browse')}>
                📁
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
