import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  JOIN_ANNOUNCE_LEVELS,
  SUPERVISOR_SPAWN_MODES,
  type AppConfig,
  type SessionDef
} from '@shared/types'
import { writeFileAtomic } from './atomic-write'
import { sanitizeGlowColor } from '@shared/palette'
import {
  DEFAULT_DEMO_TARGET,
  DEFAULT_HELP_TARGET,
  DEFAULT_WAND_TARGET,
  legacyHelpTarget,
  sanitizeClodexAutoStart,
  sanitizeClodexProxyArgs,
  sanitizeUtilityTarget
} from '@shared/models'
import { APP_STATE_SUBDIR } from './migrate-data-dir'
import { reportError } from './log'
import { WF_LANE_H_DEFAULT, WF_LANE_H_MIN } from '@shared/workflow'
import { sanitizeTtsrDisabled } from './ttsr-toggles'
import { SPAWN_CAP, sanitizeSpawnCap } from './spawn-cap'
import { linkListsFromStored } from '@shared/link-policy'
import { DEFAULT_CONFIG } from './store-defaults'

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
  // Utility inferences spawn the plain CLI: sanitizeUtilityTarget also refuses
  // a bridge provider, which the spawned binary would ignore.
  cfg.helpTarget = sanitizeUtilityTarget(
    raw.helpTarget ?? legacyHelpTarget(raw.helpModel),
    DEFAULT_HELP_TARGET
  )
  cfg.wandTarget = sanitizeUtilityTarget(raw.wandTarget, DEFAULT_WAND_TARGET)
  // The demo bridge is claude-only (--mcp-config): a hand-edited non-claude
  // target would silently run without browser tools — clamp it back.
  cfg.demoTarget = sanitizeUtilityTarget(raw.demoTarget, DEFAULT_DEMO_TARGET)
  if (cfg.demoTarget.cli !== 'claude') cfg.demoTarget = { ...DEFAULT_DEMO_TARGET }
  // Unknown/absent trust mode (older config, hand-edited file) -> default.
  if (!SUPERVISOR_SPAWN_MODES.includes(cfg.supervisorSpawnMode)) {
    cfg.supervisorSpawnMode = 'hands-free'
  }
  const agentSpawnCap = sanitizeSpawnCap(raw.agentSpawnCap)
  if (agentSpawnCap === null && raw.agentSpawnCap !== undefined) {
    reportError('store', `invalid agentSpawnCap (${String(raw.agentSpawnCap).slice(0, 40)}) in config.json, using ${SPAWN_CAP}`)
  }
  cfg.agentSpawnCap = agentSpawnCap ?? SPAWN_CAP
  // What a terminal link may launch is not decided by a stray value in the file.
  Object.assign(cfg, linkListsFromStored(raw, (message) => reportError('store', message)))
  // Unknown/absent join-announce level (older config, hand-edited file) -> default.
  if (!JOIN_ANNOUNCE_LEVELS.includes(cfg.joinAnnounceLevel)) {
    cfg.joinAnnounceLevel = 'off'
  }
  // Hand-edited file: a non-hex glow value becomes a CSS variable, so clamp.
  cfg.glowColor = sanitizeGlowColor(cfg.glowColor)
  // Whether Kory spawns a process is not decided by a stray string in the file.
  cfg.clodexAutoStart = sanitizeClodexAutoStart(
    raw.clodexAutoStart,
    DEFAULT_CONFIG.clodexAutoStart
  )
  cfg.clodexProxyArgs = sanitizeClodexProxyArgs(
    raw.clodexProxyArgs,
    DEFAULT_CONFIG.clodexProxyArgs
  )
  // Corrupt/hand-edited value -> floor to the default; the real ceiling is
  // viewport-relative (renderer-only knowledge), clamped there on seed.
  if (!Number.isFinite(cfg.wfLaneHeight) || cfg.wfLaneHeight < WF_LANE_H_MIN) {
    cfg.wfLaneHeight = WF_LANE_H_DEFAULT
  }
  // Whether a spawn carries --settings is not decided by a stray string in the file.
  if (typeof cfg.liveStatusLine !== 'boolean') cfg.liveStatusLine = DEFAULT_CONFIG.liveStatusLine
  if (typeof cfg.normalizeTerminalCopy !== 'boolean') cfg.normalizeTerminalCopy = DEFAULT_CONFIG.normalizeTerminalCopy
  // Hand-edited file: only well-formed toggle keys survive.
  cfg.ttsrDisabled = sanitizeTtsrDisabled(raw.ttsrDisabled)
  delete (cfg as { helpModel?: string }).helpModel
  return cfg
}

export function saveConfig(cfg: AppConfig): void {
  writeJson(configPath(), cfg)
}

export function saveSessions(sessions: SessionDef[]): void {
  writeJson(sessionsPath(), sessions)
}

export { DEFAULT_CONFIG }
