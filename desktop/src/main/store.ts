import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SUPERVISOR_SPAWN_MODES, type AppConfig, type SessionDef } from '@shared/types'
import { writeFileAtomic } from './atomic-write'
import { DEFAULT_PALETTE, sanitizeGlowColor } from '@shared/palette'
import {
  DEFAULT_HELP_TARGET,
  DEFAULT_WAND_TARGET,
  legacyHelpTarget,
  sanitizeTarget
} from '@shared/models'
import { APP_STATE_SUBDIR } from './migrate-data-dir'
import { reportError } from './log'

const DEFAULT_CONFIG: AppConfig = {
  projectDir: homedir(),
  // The `claudepeers` alias on the user's machine. Wrapped in a login/interactive
  // shell (see pty-manager) so the alias resolves.
  peerCommand: 'claudepeers',
  shell: '',
  interactiveShell: false,
  columns: 2,
  displayMode: '2x2',
  gridCols: 2,
  gridRows: 2,
  sidebarWidth: 260,
  theme: 'dark',
  fontSize: 13,
  restoreSessions: true,
  // '' = auto: main/i18n.ts derives en/fr from the OS locale.
  locale: '',
  palette: DEFAULT_PALETTE,
  // '' = theme default (gold): the renderer only overrides --glow when set.
  glowColor: '',
  rememberScopeSecrets: true,
  // Quota auto-resume is opt-in (PLAN C1): off unless the operator enables it.
  autoResumeQuota: false,
  // Team-lead suggestion pattern (PLAN C10): substring matched on agent/name.
  leadPattern: 'team-lead',
  // System notification when a session waits for the operator (PLAN C11).
  notifyAttention: true,
  // Supervisor spawn trust mode (PLAN TS4): hands-free by default -- the
  // consent rule lives in the supervisor's system prompt, the app confirms
  // nothing. 'team-review' / 'full-control' add native approval dialogs.
  supervisorSpawnMode: 'hands-free',
  // Floating "?" help assistant (PLAN C9): shown by default, Haiku for cost.
  helpButton: true,
  helpTarget: DEFAULT_HELP_TARGET,
  wandTarget: DEFAULT_WAND_TARGET,
  // Embedded browser view (PLAN D1): the usual local dev-server address.
  browserUrl: 'http://localhost:3000',
  // Unified model pickers (C29): operator-pinned favorites + local endpoints.
  modelFavorites: [],
  localProviders: []
}

function dataDir(): string {
  // App state lives under a `config/` subfolder of userData so it never
  // collides with the launch `config.json` at the userData root (which is the
  // same folder as the launch-config dir on Windows/Linux). See migrate-data-dir.
  const dir = join(app.getPath('userData'), APP_STATE_SUBDIR)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, value: unknown): void {
  try {
    // Atomic (temp + rename) so a crash mid-write can't truncate config.json —
    // which would silently reset every setting + the encrypted provider keys.
    writeFileAtomic(file, JSON.stringify(value, null, 2))
  } catch (err) {
    // Config/session persistence loss (O6): journal + main.log, not just a
    // console invisible in the packaged app.
    reportError('store', `write failed: ${file}`, err)
  }
}

const configPath = (): string => join(dataDir(), 'config.json')
const sessionsPath = (): string => join(dataDir(), 'sessions.json')

export function loadConfig(): AppConfig {
  // Legacy pre-lot-A configs carry `helpModel: '<alias>'` instead of targets.
  const raw = readJson<Partial<AppConfig> & { helpModel?: string }>(configPath(), {})
  const cfg = { ...DEFAULT_CONFIG, ...raw }
  cfg.helpTarget = sanitizeTarget(
    raw.helpTarget ?? legacyHelpTarget(raw.helpModel),
    DEFAULT_HELP_TARGET
  )
  cfg.wandTarget = sanitizeTarget(raw.wandTarget, DEFAULT_WAND_TARGET)
  // Unknown/absent trust mode (older config, hand-edited file) -> default.
  if (!SUPERVISOR_SPAWN_MODES.includes(cfg.supervisorSpawnMode)) {
    cfg.supervisorSpawnMode = 'hands-free'
  }
  // Hand-edited file: a non-hex glow value becomes a CSS variable, so clamp.
  cfg.glowColor = sanitizeGlowColor(cfg.glowColor)
  delete (cfg as { helpModel?: string }).helpModel
  return cfg
}

export function saveConfig(cfg: AppConfig): void {
  writeJson(configPath(), cfg)
}

export function loadSessions(): SessionDef[] {
  const raw = readJson<SessionDef[]>(sessionsPath(), [])
  return Array.isArray(raw) ? raw : []
}

export function saveSessions(sessions: SessionDef[]): void {
  writeJson(sessionsPath(), sessions)
}

export { DEFAULT_CONFIG }
