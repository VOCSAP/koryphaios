import { useState } from 'react'
import type { ProviderCatalog } from '@shared/models'
import { CLODEX_PROVIDER_ID, favKey } from '@shared/models'
import { mergeRoleChoices, sanitizeRole, TEAM_LEAD_ROLE } from '@shared/role'
import { useDeck } from '../store'
import { useT } from '../i18n'
import {
  CONTEXT_DEFAULT_TOKENS,
  CONTEXT_SLIDER_MAX_K,
  CONTEXT_SLIDER_MIN_K,
  EFFORT_LEVELS,
  canExtendPick,
  formatContextK,
  isContextInvalid,
  parseContextK,
  sliderKOf,
  type ModelPick
} from '../peer-options'
import { GLYPH_ACTIONS } from './icons'
import { ModelPicker } from './ModelPicker'

/** Cannot collide with a role: sanitizeRole() strips the dots. */
const ROLE_OTHER = '...other'

/** A control a flag in the launch args has taken over: disabled, naming where the value lives. */
export interface FieldLock {
  label: string
  note: string
}

export function AgentField({
  agents,
  value,
  lock,
  onChange
}: {
  agents: string[]
  value: string
  lock?: FieldLock
  onChange: (agent: string) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <label className="field">
      <span>{t('create.agent')}</span>
      <select value={lock ? '' : value} disabled={!!lock} onChange={(e) => onChange(e.target.value)}>
        <option value="">{lock ? lock.label : t('create.agentDefault')}</option>
        {agents.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>
      {lock && <small>{lock.note}</small>}
    </label>
  )
}

/**
 * team-lead is never offered: the lead marker is the only way to name one. A
 * stored role missing from the list (legacy template, removed custom role)
 * stays listed so opening an entry does not blank it.
 */
export function RoleField({
  value,
  disabled,
  onChange
}: {
  value: string
  disabled: boolean
  onChange: (role: string) => void
}): React.JSX.Element {
  const t = useT()
  const config = useDeck((s) => s.config!)
  const updateConfig = useDeck((s) => s.updateConfig)
  const [other, setOther] = useState(false)
  const [draft, setDraft] = useState('')
  const known = mergeRoleChoices(config.roleChoices ?? []).filter((r) => r !== TEAM_LEAD_ROLE)
  const choices = value && !known.includes(value) ? [...known, value] : known

  const addRole = (): void => {
    const next = sanitizeRole(draft)
    setOther(false)
    setDraft('')
    if (!next || next === TEAM_LEAD_ROLE) return
    onChange(next)
    if (!known.includes(next)) void updateConfig({ roleChoices: [...(config.roleChoices ?? []), next] })
  }

  return (
    <div className="field" title={t('create.roleHelp')} aria-disabled={disabled}>
      <span>{t('create.role')}</span>
      <select
        disabled={disabled}
        value={other ? ROLE_OTHER : value}
        onChange={(e) => {
          const picked = e.target.value
          if (picked === ROLE_OTHER) {
            setOther(true)
            onChange('')
            return
          }
          setOther(false)
          onChange(picked)
        }}
      >
        <option value="">{t('create.roleNone')}</option>
        {choices.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
        <option value={ROLE_OTHER}>{t('create.roleOther')}</option>
      </select>
      {other && (
        <div className="field-row">
          <input
            autoFocus
            disabled={disabled}
            value={draft}
            placeholder={t('create.rolePlaceholder')}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addRole()
            }}
          />
          <button className="icon-btn" disabled={disabled} onClick={addRole} title={t('create.roleAdd')}>
            {GLYPH_ACTIONS.plus}
          </button>
        </div>
      )}
      <small>{t('create.roleShort')}</small>
    </div>
  )
}

function pickLabel(catalogs: ProviderCatalog[], pick: ModelPick): string {
  const catalog = catalogs.find((c) => c.id === (pick.providerId ?? 'anthropic'))
  const entry = catalog?.models.find((m) => m.id === pick.model)
  return entry?.label ?? pick.model
}

/** `compact` folds the picker behind a button naming the current choice: a card has no room for the open list. */
export function ModelField({
  catalogs,
  pick,
  sandboxOn,
  compact,
  lock,
  onPick
}: {
  catalogs: ProviderCatalog[]
  pick: ModelPick
  sandboxOn: boolean
  compact?: boolean
  lock?: FieldLock
  onPick: (pick: ModelPick) => void
}): React.JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const choose = (next: ModelPick): void => {
    onPick(next)
    setOpen(false)
  }
  const bridged = pick.providerId === CLODEX_PROVIDER_ID
  const bridgeName = catalogs.find((c) => c.id === CLODEX_PROVIDER_ID)?.name
  const list = (
    <div className="create-model-picker">
      <div
        className={`mp-model${pick.model === '' ? ' is-selected' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => choose({ model: '' })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            choose({ model: '' })
          }
        }}
      >
        <span className="mp-model-name">{t('create.modelDefault')}</span>
      </div>
      <ModelPicker
        catalogs={catalogs}
        selected={[favKey(pick.providerId ?? 'anthropic', pick.model)]}
        multi={false}
        onlyProviders={['anthropic', CLODEX_PROVIDER_ID]}
        excludeKinds={sandboxOn ? ['bridge'] : undefined}
        onPick={(_key, target) => choose({ model: target.model, providerId: target.providerId })}
      />
    </div>
  )
  if (lock) {
    return (
      <div className="field">
        <span>{t('create.model')}</span>
        <button type="button" className="mp-current" disabled>
          <span className="mp-model-name">{lock.label}</span>
        </button>
        <small>{lock.note}</small>
      </div>
    )
  }
  return (
    <div className="field">
      <span>{t('create.model')}</span>
      {compact ? (
        <>
          <button
            type="button"
            className="mp-current"
            aria-expanded={open}
            title={t('create.modelPick')}
            onClick={() => setOpen((o) => !o)}
          >
            <span className="mp-model-name">
              {pick.model === '' ? t('create.modelDefault') : pickLabel(catalogs, pick)}
            </span>
            {bridged && <span className="mp-provider-kind">{bridgeName ?? CLODEX_PROVIDER_ID}</span>}
            <span className={`mp-arrow${open ? ' is-open' : ''}`}>›</span>
          </button>
          {open && <div className="mp-panel">{list}</div>}
        </>
      ) : (
        list
      )}
    </div>
  )
}

export function ExtendedContextField({
  pick,
  extended,
  locked,
  onChange
}: {
  pick: ModelPick
  extended: boolean
  locked?: boolean
  onChange: (extended: boolean) => void
}): React.JSX.Element {
  const t = useT()
  const canExtend = canExtendPick(pick) && !locked
  return (
    <label className="field field-check" title={t('create.extendedContextHelp')} aria-disabled={!canExtend}>
      <input
        type="checkbox"
        checked={extended && canExtend}
        disabled={!canExtend}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{t('create.extendedContext')}</span>
    </label>
  )
}

export function EffortField({
  value,
  onChange
}: {
  value: string
  onChange: (effort: string) => void
}): React.JSX.Element {
  const t = useT()
  const idx = Math.max(0, EFFORT_LEVELS.indexOf(value as (typeof EFFORT_LEVELS)[number]))
  return (
    <div className="field">
      <span>
        {t('create.effort')}: <strong>{value || t('create.effortAuto')}</strong>
      </span>
      <input
        type="range"
        min={0}
        max={EFFORT_LEVELS.length - 1}
        step={1}
        value={idx}
        aria-label={t('create.effort')}
        onChange={(e) => onChange(EFFORT_LEVELS[Number(e.target.value)] ?? '')}
      />
      <div className="effort-ends">
        <span>{t('create.effortFaster')}</span>
        <span>{t('create.effortSmarter')}</span>
      </div>
    </div>
  )
}

/** `value` undefined is the default; an unparsable text goes up as NaN (see parseContextK). */
export function ClodexContextField({
  value,
  onChange
}: {
  value: number | undefined
  onChange: (tokens: number) => void
}): React.JSX.Element {
  const t = useT()
  // null mirrors `value`; a string is the text being typed.
  const [draft, setDraft] = useState<string | null>(null)
  const invalid = isContextInvalid(value)
  const shown = draft ?? formatContextK(value === undefined ? CONTEXT_DEFAULT_TOKENS : value)
  return (
    <div className="field">
      <span>{t('create.contextSize')}</span>
      <div className="ctx-row">
        <input
          type="range"
          min={CONTEXT_SLIDER_MIN_K}
          max={CONTEXT_SLIDER_MAX_K}
          step={1}
          value={sliderKOf(value)}
          aria-label={t('create.contextSize')}
          onChange={(e) => {
            setDraft(null)
            onChange(Number(e.target.value) * 1000)
          }}
        />
        <input
          className="ctx-number"
          inputMode="decimal"
          value={shown}
          aria-label={`${t('create.contextSize')} (${t('create.contextSizeUnit')})`}
          aria-invalid={invalid || undefined}
          onChange={(e) => {
            setDraft(e.target.value)
            onChange(parseContextK(e.target.value))
          }}
          onBlur={() => {
            if (!invalid) setDraft(null)
          }}
        />
        <span className="ctx-unit">{t('create.contextSizeUnit')}</span>
      </div>
      {invalid ? (
        <small className="field-error">
          {t('create.contextSizeInvalid', { min: CONTEXT_SLIDER_MIN_K, max: CONTEXT_SLIDER_MAX_K })}
        </small>
      ) : (
        <small>{t('create.contextSizeHelp')}</small>
      )}
    </div>
  )
}
