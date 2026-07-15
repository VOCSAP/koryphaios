import { useEffect, useState } from 'react'
import type { AppConfig, DisplayMode, LaunchPreset, ModelOption } from '@shared/types'
import { DEFAULT_PALETTE } from '@shared/palette'
import { useDeck } from '../store'
import { useT } from '../i18n'

// VS Code-style settings page: a category tree on the left, the active
// category's fields on the right. Replaces the former SettingsDialog modal and
// is the single configuration surface (also reached via the sidebar gear and
// Edit > Settings…). Changes apply live -- discrete inputs on change, free-text
// inputs on blur -- so switching the language is instant (no Save button).

type Category = 'general' | 'appearance' | 'terminal'

const CATEGORIES: { id: Category; key: string }[] = [
  { id: 'general', key: 'settings.catGeneral' },
  { id: 'appearance', key: 'settings.catAppearance' },
  { id: 'terminal', key: 'settings.catTerminal' }
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
          ✕
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
                  checked={config.helpButton !== false}
                  onChange={(e) => set('helpButton', e.target.checked)}
                />
                <span>{t('settings.helpButton')}</span>
              </label>
              <label className="field">
                <span>{t('settings.helpModel')}</span>
                <select
                  value={config.helpModel}
                  onChange={(e) => set('helpModel', e.target.value)}
                >
                  {['haiku', 'sonnet', 'opus'].map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <small className="field-check-help">{t('settings.helpModelHelp')}</small>
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
                        ✕
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
                    📁
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
        </div>
      </div>
    </div>
  )
}
