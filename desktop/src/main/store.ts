import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AppConfig, SessionDef } from '@shared/types'
import { DEFAULT_PALETTE } from '@shared/palette'
import { APP_STATE_SUBDIR } from './migrate-data-dir'

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
  rememberScopeSecrets: true,
  // Quota auto-resume is opt-in (PLAN C1): off unless the operator enables it.
  autoResumeQuota: false,
  // Team-lead suggestion pattern (PLAN C10): substring matched on agent/name.
  leadPattern: 'team-lead',
  // System notification when a session waits for the operator (PLAN C11).
  notifyAttention: true,
  // Floating "?" help assistant (PLAN C9): shown by default, Haiku for cost.
  helpButton: true,
  helpModel: 'haiku',
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
    writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
  } catch (err) {
    console.error('[store] write failed:', file, err)
  }
}

const configPath = (): string => join(dataDir(), 'config.json')
const sessionsPath = (): string => join(dataDir(), 'sessions.json')

export function loadConfig(): AppConfig {
  return { ...DEFAULT_CONFIG, ...readJson<Partial<AppConfig>>(configPath(), {}) }
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
