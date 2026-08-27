import type { TemplateSession } from '@shared/template'
import type { ModelOption } from '@shared/types'
import { GLYPH_ACTIONS, GLYPH_BADGES } from './icons'
import type { TFn } from '../i18n'

const EFFORT_LEVELS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** Extracted from TemplateComposer.tsx into its OWN module (entry-card-
 * isolation lot, on top of card 0b9e0b07 lot B) so it is immune BY
 * CONSTRUCTION to tests/desktop-templates-composer-seed.test.ts's
 * `mock.module('.../TemplateComposer.tsx', () => ({ TemplateComposer: stub }))`.
 * bun's `mock.module` freezes the SPECIFIER's export surface to exactly the
 * keys the first-registered factory returns, for the rest of the process --
 * merely exporting EntryCard alongside TemplateComposer from the SAME file
 * never protected it, since any later import of that specifier in the same
 * process got `EntryCard: undefined` from the frozen, TemplateComposer-only
 * factory. This card is a pure, prop-driven component -- no `useDeck` call
 * anywhere inside it -- so mounting it standalone in a test needs no store
 * mock at all, and now no immunity-defeating shared specifier either. */
export function EntryCard({
  session,
  agents,
  models,
  roleChoices,
  onChange,
  onRemove,
  onLead,
  t
}: {
  session: TemplateSession
  agents: string[]
  models: ModelOption[]
  roleChoices: string[]
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
        {/* Peer role (card 0b9e0b07 lot B): closed select, no free-text "Other…"
            add flow -- matches this card's own agent/model fields above, which
            are equally closed lists here, unlike CreateMenu's advanced picker.
            Travels through the template in BOTH scopes (lot A arbitration,
            shared/types.ts SessionDef.role): no local/global gate needed. */}
        <label className="field">
          <span>{t('create.role')}</span>
          <select value={session.role ?? ''} onChange={(e) => set({ role: e.target.value || undefined })}>
            <option value="">{t('create.roleNone')}</option>
            {roleChoices.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
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
