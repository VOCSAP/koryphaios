import type { AppConfig } from '../shared/types'

// 'file' keys have no config:set writer: they come from the config file or the launch context.
export const CONFIG_KEY_ACCESS = {
  projectDir: 'file',
  peerCommand: 'file',
  shell: 'patch',
  interactiveShell: 'patch',
  clodexAutoStart: 'patch',
  clodexProxyArgs: 'patch',
  enabledMods: 'patch',
  columns: 'file',
  displayMode: 'patch',
  gridCols: 'patch',
  gridRows: 'patch',
  sidebarWidth: 'patch',
  sidebarCollapsed: 'patch',
  roadmapFiltersCollapsed: 'patch',
  graphListCollapsed: 'patch',
  pickContextPrompt: 'patch',
  wfLaneHeight: 'patch',
  theme: 'patch',
  fontSize: 'patch',
  locale: 'patch',
  palette: 'patch',
  glowColor: 'patch',
  rememberScopeSecrets: 'patch',
  autoResumeQuota: 'patch',
  leadPattern: 'file',
  notifyAttention: 'patch',
  liveStatusLine: 'patch',
  thalposAutostart: 'patch',
  mobileApprovals: 'patch',
  supervisorSpawnMode: 'patch',
  startSupervisorOnLaunch: 'patch',
  agentSpawnCap: 'patch',
  linkOpenExtensions: 'patch',
  linkOpenExclusions: 'patch',
  joinAnnounceLevel: 'patch',
  helpButton: 'patch',
  normalizeTerminalCopy: 'patch',
  helpTarget: 'patch',
  wandTarget: 'patch',
  browserUrl: 'patch',
  modelFavorites: 'patch',
  roleChoices: 'patch',
  localProviders: 'patch',
  ttsrDisabled: 'patch'
} as const satisfies Record<keyof AppConfig, 'patch' | 'file'>

/** Keeps the keys a config:set may write; a 'file' key passes only with the value already stored. Each refusal is traced through `report`. */
export function restrictConfigPatch(
  patch: Partial<AppConfig>,
  current: AppConfig,
  report: (message: string) => void
): Partial<AppConfig> {
  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    const access = Object.hasOwn(CONFIG_KEY_ACCESS, key) ? CONFIG_KEY_ACCESS[key as keyof AppConfig] : undefined
    if (access === 'patch' || (access === 'file' && value === current[key as keyof AppConfig])) {
      kept[key] = value
    } else {
      report(`rejected config:set key ${JSON.stringify(key.slice(0, 40))} (${access === undefined ? 'unknown' : 'not patchable'})`)
    }
  }
  return kept as Partial<AppConfig>
}
