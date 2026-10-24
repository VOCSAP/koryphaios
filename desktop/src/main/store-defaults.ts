import { homedir } from 'node:os'
import type { AppConfig } from '../shared/types'
import { DEFAULT_PALETTE } from '../shared/palette'
import {
  DEFAULT_DEMO_TARGET,
  DEFAULT_HELP_TARGET,
  DEFAULT_WAND_TARGET
} from '../shared/models'
import { SPAWN_CAP } from './spawn-cap'
import { DEFAULT_LINK_EXCLUSIONS, DEFAULT_LINK_EXTENSIONS } from '../shared/link-policy'

export const DEFAULT_CONFIG: AppConfig = {
  projectDir: homedir(),
  peerCommand: 'claudepeers',
  shell: '',
  interactiveShell: false,
  clodexAutoStart: true,
  clodexProxyArgs: '',
  enabledMods: {},
  columns: 2,
  displayMode: '2x2',
  gridCols: 2,
  gridRows: 2,
  sidebarWidth: 260,
  sidebarCollapsed: false,
  roadmapFiltersCollapsed: false,
  graphListCollapsed: false,
  pickContextPrompt: true,
  wfLaneHeight: 240,
  theme: 'dark',
  fontSize: 13,
  locale: '',
  palette: DEFAULT_PALETTE,
  glowColor: '',
  rememberScopeSecrets: true,
  autoResumeQuota: false,
  leadPattern: 'team-lead',
  notifyAttention: true,
  liveStatusLine: true,
  mobileApprovals: false,
  supervisorSpawnMode: 'hands-free',
  startSupervisorOnLaunch: true,
  agentSpawnCap: SPAWN_CAP,
  linkOpenExtensions: [...DEFAULT_LINK_EXTENSIONS],
  linkOpenExclusions: [...DEFAULT_LINK_EXCLUSIONS],
  joinAnnounceLevel: 'off',
  helpButton: true,
  normalizeTerminalCopy: true,
  helpTarget: DEFAULT_HELP_TARGET,
  wandTarget: DEFAULT_WAND_TARGET,
  demoTarget: DEFAULT_DEMO_TARGET,
  browserUrl: 'http://localhost:3000',
  modelFavorites: [],
  localProviders: [],
  roleChoices: [],
  ttsrDisabled: []
}
