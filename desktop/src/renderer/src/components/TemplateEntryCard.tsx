import type { TemplateSession } from '@shared/template'
import type { ProviderCatalog } from '@shared/models'
import { GLYPH_ACTIONS, GLYPH_BADGES } from './icons'
import type { TFn } from '../i18n'
import {
  isBridgePick,
  launchFlagsInArgs,
  modelFieldsOf,
  modelStateOf,
  type ModelPick
} from '../peer-options'
import {
  AgentField,
  ClodexContextField,
  EffortField,
  ExtendedContextField,
  ModelField,
  RoleField,
  type FieldLock
} from './PeerOptionFields'

/**
 * Its own module, not exported alongside TemplateComposer from the same file:
 * bun's mock.module freezes a specifier's export surface to exactly what the
 * first-registered factory returns for the rest of the process, so a later
 * import from a mocked specifier would get this export as undefined.
 */
export function EntryCard({
  session,
  agents,
  catalogs,
  sandboxOn,
  onChange,
  onRemove,
  onLead,
  t
}: {
  session: TemplateSession
  agents: string[]
  /** Already merged by mergeCreateCatalogs. */
  catalogs: ProviderCatalog[]
  sandboxOn: boolean
  onChange: (next: TemplateSession) => void
  onRemove: () => void
  /** The parent keeps at most one lead. */
  onLead: () => void
  t: TFn
}): React.JSX.Element {
  const set = (patch: Partial<TemplateSession>): void => onChange({ ...session, ...patch })
  const { pick, extended } = modelStateOf(session)
  const isBridge = isBridgePick(pick)
  const inArgs = launchFlagsInArgs(session.args)
  const lockFor = (named: boolean): FieldLock | undefined =>
    named ? { label: t('composer.definedInArgsShort'), note: t('composer.definedInArgs') } : undefined
  const pickModel = (next: ModelPick): void => {
    const fields = modelFieldsOf(next, extended)
    set({
      model: fields.model,
      bridge: fields.bridge,
      clodexContextTokens: fields.bridge ? session.clodexContextTokens : undefined
    })
  }
  return (
    <div className={`tc-card${session.lead ? ' tc-card-lead' : ''}`}>
      <div className="tc-card-head">
        <input
          type="color"
          className="swatch"
          value={session.color || '#4f86ff'}
          title={t('create.colourTitle')}
          aria-label={t('create.customColour')}
          onChange={(e) => set({ color: e.target.value })}
        />
        {session.color && (
          <button
            type="button"
            className="chip"
            title={t('create.colourAutoTitle')}
            onClick={() => set({ color: undefined })}
          >
            {t('create.colourAuto')}
          </button>
        )}
        <input
          className="tc-name"
          value={session.name}
          placeholder={t('composer.name')}
          onChange={(e) => set({ name: e.target.value })}
        />
        <label className="tc-lead-toggle" title={t('create.leadHelp')}>
          <input
            type="checkbox"
            checked={!!session.lead}
            aria-label={t('create.lead')}
            onChange={onLead}
          />
          <span>{GLYPH_BADGES.laurel}</span>
        </label>
        <button
          className="row-btn row-btn-danger tc-remove"
          title={t('common.delete')}
          aria-label={t('common.delete')}
          onClick={onRemove}
        >
          {GLYPH_ACTIONS.close}
        </button>
      </div>
      <div className="tc-grid">
        <AgentField
          agents={agents}
          value={session.agent ?? ''}
          lock={lockFor(inArgs.agent)}
          onChange={(agent) => set({ agent: agent || undefined })}
        />
        <RoleField
          value={session.role ?? ''}
          disabled={!!session.lead}
          onChange={(role) => set({ role: role || undefined })}
        />
      </div>
      <ModelField
        catalogs={catalogs}
        pick={pick}
        sandboxOn={sandboxOn}
        compact
        lock={lockFor(inArgs.model)}
        onPick={pickModel}
      />
      <ExtendedContextField
        pick={pick}
        extended={extended}
        locked={inArgs.model}
        onChange={(next) => set({ model: modelFieldsOf(pick, next).model })}
      />
      {isBridge && (
        <ClodexContextField
          value={session.clodexContextTokens}
          onChange={(tokens) => set({ clodexContextTokens: tokens })}
        />
      )}
      <EffortField value={session.effort ?? ''} onChange={(effort) => set({ effort: effort || undefined })} />
      <label className="field">
        <span>{t('create.extraArgs')}</span>
        <input
          value={session.args ?? ''}
          placeholder={t('create.extraArgsPlaceholder')}
          onChange={(e) => set({ args: e.target.value || undefined })}
        />
      </label>
      <label className="field">
        <span>{t('create.prompt')}</span>
        <textarea
          rows={2}
          value={session.prompt ?? ''}
          placeholder={t('create.promptPlaceholder')}
          onChange={(e) => set({ prompt: e.target.value || undefined })}
        />
      </label>
      <label className="field">
        <span>{t('create.announce')}</span>
        <input
          value={session.announce ?? ''}
          placeholder={t('create.announcePlaceholder')}
          onChange={(e) => set({ announce: e.target.value || undefined })}
        />
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
  )
}
