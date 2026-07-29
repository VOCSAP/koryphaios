import { useEffect, useState } from 'react'
import { NotificationChannels } from './NotificationChannels'
import type { AppConfig, DisplayMode, LaunchPreset, ModelOption } from '@shared/types'
import { targetKey, type LocalProviderConfig, type ProviderCatalog } from '@shared/models'
import { ModelPicker } from './ModelPicker'
import { DEFAULT_GLOW, DEFAULT_PALETTE } from '@shared/palette'
import { GLYPH_ACTIONS } from './icons'
import { graphId } from '@shared/graph'
import { useDeck } from '../store'
import { useT } from '../i18n'

// VS Code-style settings page: a category tree on the left, the active
// category's fields on the right. Replaces the former SettingsDialog modal and
// is the single configuration surface (also reached via the sidebar gear and
// Edit > Settings…). Changes apply live -- discrete inputs on change, free-text
// inputs on blur -- so switching the language is instant (no Save button).

type Category = 'general' | 'appearance' | 'terminal' | 'models'

const CATEGORIES: { id: Category; key: string }[] = [
  { id: 'general', key: 'settings.catGeneral' },
  { id: 'appearance', key: 'settings.catAppearance' },
  { id: 'terminal', key: 'settings.catTerminal' },
  { id: 'models', key: 'settings.catModels' }
]

const DISPLAY_MODE_KEYS: { value: DisplayMode; key: string }[] = [
  { value: '1x1', key: 'mode.1x1' },
  { value: '1x2', key: 'mode.1x2' },
  { value: '2x2', key: 'mode.2x2' },
  { value: 'custom', key: 'mode.custom' }
]

export function SettingsView(): React.JSX.Element {
  const t = useT()
  const config = useDeck((s) => s.config!)
  const availableLocales = useDeck((s) => s.availableLocales)
  const updateConfig = useDeck((s) => s.updateConfig)
  const openSettings = useDeck((s) => s.openSettings)

  const [active, setActive] = useState<Category>('general')

  // Free-text fields are buffered locally and committed on blur (avoids a config
  // round-trip per keystroke). Seeded from config; resynced if it changes under us.
  const [projectDir, setProjectDir] = useState(config.projectDir)
  const [shell, setShell] = useState(config.shell)
  useEffect(() => setProjectDir(config.projectDir), [config.projectDir])
  useEffect(() => setShell(config.shell), [config.shell])

  // launchCommand lives in the (global) launch config, not AppConfig. presets +
  // models are carried through unchanged so saving the command preserves them.
  const [launchCommand, setLaunchCommand] = useState('')
  const [presets, setPresets] = useState<LaunchPreset[]>([])
  const [models, setModels] = useState<ModelOption[]>([])
  const [worktreeInit, setWorktreeInit] = useState<string | undefined>(undefined)
  useEffect(() => {
    void window.api.getLaunchConfig().then((c) => {
      setLaunchCommand(c.launchCommand)
      setPresets(c.presets)
      setModels(c.models)
      setWorktreeInit(c.worktreeInit)
    })
  }, [])

  const set = <K extends keyof AppConfig>(key: K, value: AppConfig[K]): void => {
    void updateConfig({ [key]: value } as Partial<AppConfig>)
  }

  const browse = async (): Promise<void> => {
    const dir = await window.api.pickDirectory()
    if (dir) {
      setProjectDir(dir)
      set('projectDir', dir)
    }
  }

  // Models category (C29): local providers buffered locally (committed on
  // blur / add / delete), plus the live catalog for the detection status.
  const [providers, setProviders] = useState<LocalProviderConfig[]>(config.localProviders ?? [])
  useEffect(() => setProviders(config.localProviders ?? []), [config.localProviders])
  const [catalogs, setCatalogs] = useState<ProviderCatalog[] | null>(null)
  useEffect(() => {
    if (active === 'models' && catalogs === null) {
      void window.api.modelCatalogs().then(setCatalogs)
    }
  }, [active, catalogs])

  const commitProviders = (next: LocalProviderConfig[]): void => {
    setProviders(next)
    set('localProviders', next)
    setCatalogs(null) // re-discover on next look
  }

  const editProvider = (id: string, patch: Partial<LocalProviderConfig>): void => {
    setProviders((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }

  const saveLaunchCommand = (): void => {
    // worktreeInit is carried through unchanged so saving the command never
    // drops a hook configured in the global config file (PLAN C4).
    void window.api.saveLaunchConfig({
      launchCommand: launchCommand.trim(),
      presets,
      models,
      worktreeInit
    })
  }

  const close = (): void => openSettings(false)

  return (
    <div className="settings-view">
      <header className="settings-head">
        <h2>{t('settings.title')}</h2>
        <button className="icon-btn" title={t('common.close')} onClick={close}>
          {GLYPH_ACTIONS.close}
        </button>
      </header>

      <div className="settings-body">
        <nav className="settings-tree">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              className={`settings-tree-item${active === c.id ? ' is-active' : ''}`}
              onClick={() => setActive(c.id)}
            >
              {t(c.key)}
            </button>
          ))}
        </nav>

        <div className="settings-panel">
          {active === 'general' && (
            <>
              <label className="field">
                <span>{t('settings.language')}</span>
                <select value={config.locale} onChange={(e) => set('locale', e.target.value)}>
                  <option value="">{t('settings.languageAuto')}</option>
                  {availableLocales.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field field-check">
                <input
                  type="checkbox"
                  checked={config.restoreSessions}
                  onChange={(e) => set('restoreSessions', e.target.checked)}
                />
                <span>{t('settings.restoreSessions')}</span>
              </label>

              <label className="field field-check">
                <input
                  type="checkbox"
                  checked={config.rememberScopeSecrets}
                  onChange={(e) => set('rememberScopeSecrets', e.target.checked)}
                />
                <span>{t('settings.rememberScope')}</span>
              </label>
              <small className="field-check-help">{t('settings.rememberScopeHelp')}</small>

              <label className="field field-check">
                <input
                  type="checkbox"
                  checked={config.autoResumeQuota}
                  onChange={(e) => set('autoResumeQuota', e.target.checked)}
                />
                <span>{t('settings.autoResumeQuota')}</span>
              </label>
              <small className="field-check-help">{t('settings.autoResumeQuotaHelp')}</small>

              <label className="field field-check">
                <input
                  type="checkbox"
                  checked={config.notifyAttention !== false}
                  onChange={(e) => set('notifyAttention', e.target.checked)}
                />
                <span>{t('settings.notifyAttention')}</span>
              </label>

              <label className="field field-check">
                <input
                  type="checkbox"
                  checked={config.mobileApprovals === true}
                  onChange={(e) => set('mobileApprovals', e.target.checked)}
                />
                <span>{t('settings.mobileApprovals')}</span>
              </label>
              <small className="field-check-help">{t('settings.mobileApprovalsHelp')}</small>
              <div className="field">
                <span>{t('notifications.title')}</span>
              </div>
              <NotificationChannels t={t} enabled={config.mobileApprovals === true} />

              <label className="field field-check">
                <input
                  type="checkbox"
                  checked={config.helpButton !== false}
                  onChange={(e) => set('helpButton', e.target.checked)}
                />
                <span>{t('settings.helpButton')}</span>
              </label>
              <small className="field-check-help">{t('settings.helpModelHint')}</small>

              <div className="field">
                <span>{t('settings.spawnMode')}</span>
              </div>
              {(['hands-free', 'team-review', 'full-control'] as const).map((mode) => (
                <div key={mode}>
                  <label className="field field-check">
                    <input
                      type="radio"
                      name="supervisor-spawn-mode"
                      checked={(config.supervisorSpawnMode ?? 'hands-free') === mode}
                      onChange={() => set('supervisorSpawnMode', mode)}
                    />
                    <span>
                      {mode === 'hands-free'
                        ? t('settings.spawnModeHandsFree')
                        : mode === 'team-review'
                          ? t('settings.spawnModeTeamReview')
                          : t('settings.spawnModeFullControl')}
                    </span>
                  </label>
                  <small className="field-check-help">
                    {mode === 'hands-free'
                      ? t('settings.spawnModeHandsFreeHelp')
                      : mode === 'team-review'
                        ? t('settings.spawnModeTeamReviewHelp')
                        : t('settings.spawnModeFullControlHelp')}
                  </small>
                </div>
              ))}
            </>
          )}

          {active === 'appearance' && (
            <>
              <div className="field-grid">
                <label className="field">
                  <span>{t('settings.theme')}</span>
                  <select
                    value={config.theme}
                    onChange={(e) => set('theme', e.target.value as AppConfig['theme'])}
                  >
                    <option value="dark">{t('settings.themeDark')}</option>
                    <option value="light">{t('settings.themeLight')}</option>
                  </select>
                </label>

                <label className="field">
                  <span>{t('settings.fontSize')}</span>
                  <input
                    type="number"
                    min={8}
                    max={32}
                    value={config.fontSize}
                    onChange={(e) => set('fontSize', Math.max(8, Number(e.target.value) || 13))}
                  />
                </label>

                <label className="field">
                  <span>{t('settings.displayMode')}</span>
                  <select
                    value={config.displayMode}
                    onChange={(e) => set('displayMode', e.target.value as DisplayMode)}
                  >
                    {DISPLAY_MODE_KEYS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {t(m.key)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="field">
                <span>{t('settings.glowColor')}</span>
                <div className="palette-row">
                  <span className="palette-swatch">
                    <input
                      type="color"
                      value={config.glowColor || DEFAULT_GLOW}
                      onChange={(e) => set('glowColor', e.target.value)}
                    />
                  </span>
                  <button className="chip" onClick={() => set('glowColor', '')}>
                    {t('settings.glowReset')}
                  </button>
                </div>
                <small>{t('settings.glowHelp')}</small>
              </div>

              <div className="field">
                <span>{t('settings.palette')}</span>
                <div className="palette-row">
                  {config.palette.map((c, i) => (
                    <span key={i} className="palette-swatch">
                      <input
                        type="color"
                        value={c}
                        onChange={(e) =>
                          set(
                            'palette',
                            config.palette.map((x, j) => (j === i ? e.target.value : x))
                          )
                        }
                      />
                      <button
                        className="palette-remove"
                        title={t('settings.paletteRemove')}
                        onClick={() =>
                          set(
                            'palette',
                            config.palette.filter((_, j) => j !== i)
                          )
                        }
                      >
                        {GLYPH_ACTIONS.close}
                      </button>
                    </span>
                  ))}
                  <button
                    className="chip"
                    onClick={() => set('palette', [...config.palette, '#888888'])}
                  >
                    {t('settings.paletteAdd')}
                  </button>
                  <button className="chip" onClick={() => set('palette', [...DEFAULT_PALETTE])}>
                    {t('settings.paletteReset')}
                  </button>
                </div>
                <small>{t('settings.paletteHelp')}</small>
              </div>
            </>
          )}

          {active === 'terminal' && (
            <>
              <label className="field">
                <span>{t('settings.projectDir')}</span>
                <div className="field-row">
                  <input
                    value={projectDir}
                    onChange={(e) => setProjectDir(e.target.value)}
                    onBlur={() => set('projectDir', projectDir)}
                  />
                  <button className="icon-btn" onClick={browse} title={t('common.browse')}>
                    {GLYPH_ACTIONS.folder}
                  </button>
                </div>
                <small>{t('settings.projectDirHelp')}</small>
              </label>

              <label className="field">
                <span>{t('settings.launchCommand')}</span>
                <input
                  value={launchCommand}
                  onChange={(e) => setLaunchCommand(e.target.value)}
                  onBlur={saveLaunchCommand}
                />
                <small>{t('settings.launchCommandHelp')}</small>
              </label>

              <label className="field">
                <span>{t('settings.shellOverride')}</span>
                <input
                  value={shell}
                  placeholder={t('settings.shellPlaceholder')}
                  onChange={(e) => setShell(e.target.value)}
                  onBlur={() => set('shell', shell)}
                />
                <small>{t('settings.shellHelp')}</small>
              </label>

              <label className="field field-check">
                <input
                  type="checkbox"
                  checked={config.interactiveShell}
                  onChange={(e) => set('interactiveShell', e.target.checked)}
                />
                <span>{t('settings.interactiveShell')}</span>
              </label>
            </>
          )}

          {active === 'models' && (
            <>
              {/* Frontier detection status (D11): a provider is offered in the
                  pickers only when its CLI is installed. Lists are curated in
                  code (shared/models.ts) — no reliable dynamic listing exists
                  for the OAuth CLIs. */}
              <div className="field">
                <span>{t('settings.modelsDetection')}</span>
                <div className="settings-detect-row">
                  {(catalogs ?? [])
                    .filter((c) => c.kind === 'frontier')
                    .map((c) => (
                      <span
                        key={c.id}
                        className={`settings-detect${c.available ? ' is-ok' : ''}`}
                      >
                        <span
                          role="img"
                          aria-label={t(
                            c.available ? 'settings.modelsDetected' : 'settings.modelsMissing'
                          )}
                        >
                          {c.available ? GLYPH_ACTIONS.check : GLYPH_ACTIONS.close}
                        </span>{' '}
                        {c.name} ({c.cli})
                      </span>
                    ))}
                  {catalogs === null && <span>{t('graph.running')}</span>}
                  <button
                    className="icon-btn"
                    title={t('settings.modelsRefresh')}
                    onClick={() => {
                      setCatalogs(null)
                      void window.api.modelCatalogs(true).then(setCatalogs)
                    }}
                  >
                    {GLYPH_ACTIONS.refresh}
                  </button>
                </div>
                <small>{t('settings.modelsDetectionHelp')}</small>
              </div>

              {/* Utility-inference targets (lot A): help+digest and the
                  roadmap context wand each pick any catalog model. */}
              <div className="field">
                <span>{t('settings.helpModel')}</span>
                <small>{t('settings.helpModelHelp')}</small>
                <ModelPicker
                  catalogs={catalogs ?? []}
                  selected={[targetKey(config.helpTarget)]}
                  multi={false}
                  onPick={(_key, target) => set('helpTarget', target)}
                />
              </div>
              <div className="field">
                <span>{t('settings.wandModel')}</span>
                <small>{t('settings.wandModelHelp')}</small>
                <ModelPicker
                  catalogs={catalogs ?? []}
                  selected={[targetKey(config.wandTarget)]}
                  multi={false}
                  onPick={(_key, target) => set('wandTarget', target)}
                />
              </div>

              <div className="field">
                <span>{t('settings.localProviders')}</span>
                <small>{t('settings.localProvidersHelp')}</small>
                {providers.map((p) => {
                  const discovered = catalogs?.find((c) => c.id === p.id)
                  return (
                    <div key={p.id} className="settings-provider-row">
                      <input
                        className="settings-provider-name"
                        placeholder={t('settings.providerName')}
                        value={p.name}
                        onChange={(e) => editProvider(p.id, { name: e.target.value })}
                        onBlur={() => commitProviders(providers)}
                      />
                      <input
                        className="settings-provider-url"
                        placeholder="http://localhost:11434"
                        value={p.baseUrl}
                        onChange={(e) => editProvider(p.id, { baseUrl: e.target.value })}
                        onBlur={() => commitProviders(providers)}
                      />
                      {/* Transient field (C29): `apiKey` is only sent when the
                          operator types here; the stored key never comes back
                          (safeStorage at rest, `hasKey` marker only). */}
                      <input
                        className="settings-provider-key"
                        type="password"
                        placeholder={p.hasKey ? '••••••••' : t('settings.providerKey')}
                        value={p.apiKey ?? ''}
                        onChange={(e) => editProvider(p.id, { apiKey: e.target.value })}
                        onBlur={() => commitProviders(providers)}
                      />
                      {p.hasKey && !p.apiKey && (
                        <button
                          className="icon-btn"
                          title={t('settings.providerKeyClear')}
                          onClick={() =>
                            commitProviders(
                              providers.map((x) => (x.id === p.id ? { ...x, apiKey: '' } : x))
                            )
                          }
                        >
                          ⊘
                        </button>
                      )}
                      <span className="settings-provider-count">
                        {discovered
                          ? t('settings.providerModels', { count: discovered.models.length })
                          : '…'}
                      </span>
                      <button
                        className="icon-btn"
                        title={t('common.delete')}
                        onClick={() => commitProviders(providers.filter((x) => x.id !== p.id))}
                      >
                        {GLYPH_ACTIONS.trash}
                      </button>
                    </div>
                  )
                })}
                <div>
                  <button
                    className="primary"
                    onClick={() =>
                      commitProviders([
                        ...providers,
                        { id: graphId(), name: '', baseUrl: 'http://localhost:11434' }
                      ])
                    }
                  >
                    {t('settings.addProvider')}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
