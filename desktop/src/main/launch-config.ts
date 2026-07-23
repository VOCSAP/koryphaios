// Resolves the command the Deck runs in each session PTY, plus optional launch
// presets. First-wins precedence (DESIGN / PLAN §5):
//   1. project-local <projectDir>/.claude/claude-peers/config.json
//   2. global %APPDATA%\koryphaios\config.json  (XDG equiv on Unix)
//   3. built-in default
//
// Pure node builtins only (no electron) so it is unit-testable and the global
// path is derived from env rather than app.getPath.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULT_LAUNCH_COMMAND =
  'claude --dangerously-load-development-channels server:claude-peers'

/**
 * Built-in model choices (stable Claude Code aliases) used when no local config
 * supplies its own `models` list. Edit the local/global config.json `models`
 * array to track new model ids without rebuilding the app.
 */
export const DEFAULT_MODELS: ModelOption[] = [
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' }
]

export interface ModelOption {
  /** Value passed to `--model` (alias like 'opus' or a full model id). */
  id: string
  /** Human label shown in the dropdown. */
  label: string
}

export interface LaunchPreset {
  label: string
  /** Extra args appended after --session-id on a fresh launch. */
  args: string
  /** Optional initial prompt: pre-fills the create menu's prompt field (PLAN C2). */
  prompt?: string
}

/**
 * Per-machine feature flags (CT3). `magicCompact` gates a PTY-reaching behavior
 * (the Deck typing /magic-compact into an agent's terminal), so it follows the
 * GLOBAL-only trust rule below; `handoff` only influences advisory briefing text
 * and follows normal precedence.
 */
export type MagicCompactMode = 'auto' | 'on' | 'off'
export type HandoffMode = 'file' | 'kleos' | 'off'
export interface FeatureFlags {
  /** magic_compact directive: 'auto' (use plugin when present), 'on', 'off'. */
  magicCompact: MagicCompactMode
  /** How agents are told to persist hand-offs: 'file' (plan file), 'kleos', 'off'. */
  handoff: HandoffMode
}
export const DEFAULT_FEATURES: FeatureFlags = { magicCompact: 'auto', handoff: 'file' }

const MAGIC_MODES: readonly MagicCompactMode[] = ['auto', 'on', 'off']
const HANDOFF_MODES: readonly HandoffMode[] = ['file', 'kleos', 'off']
function asMagic(v: unknown): MagicCompactMode | undefined {
  return typeof v === 'string' && (MAGIC_MODES as readonly string[]).includes(v)
    ? (v as MagicCompactMode)
    : undefined
}
function asHandoff(v: unknown): HandoffMode | undefined {
  return typeof v === 'string' && (HANDOFF_MODES as readonly string[]).includes(v)
    ? (v as HandoffMode)
    : undefined
}

export interface LaunchConfig {
  launchCommand: string
  presets: LaunchPreset[]
  /** Selectable models for the create dropdown. Defaults to DEFAULT_MODELS. */
  models: ModelOption[]
  /**
   * Optional command run (in the background) inside a freshly created worktree
   * (PLAN C4), e.g. "bun install". Empty = no hook.
   */
  worktreeInit?: string
  /** Per-machine feature flags (CT3); resolved separately via resolveFeatures. */
  features?: Partial<FeatureFlags>
}

export function globalConfigDir(env: NodeJS.ProcessEnv): string {
  // "koryphaios" since the v0.7 rename; the desk->koryphaios migration
  // (migrate-data-dir.ts) copies the legacy claude-peers-desk root over at
  // boot, so this module can point straight at the new home.
  if (platform() === 'win32') {
    return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'koryphaios')
  }
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'koryphaios')
}

export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalConfigDir(env), 'config.json')
}

export function localConfigPath(projectDir: string): string {
  return join(projectDir, '.claude', 'claude-peers', 'config.json')
}

function isPreset(p: unknown): p is LaunchPreset {
  return (
    !!p &&
    typeof p === 'object' &&
    typeof (p as LaunchPreset).label === 'string' &&
    typeof (p as LaunchPreset).args === 'string'
  )
}

function isModel(m: unknown): m is ModelOption {
  return (
    !!m &&
    typeof m === 'object' &&
    typeof (m as ModelOption).id === 'string' &&
    typeof (m as ModelOption).label === 'string' &&
    !!(m as ModelOption).id.trim()
  )
}

/** Read + validate one config file. Missing or malformed => null (treated as absent). */
function readConfigFile(file: string): Partial<LaunchConfig> | null {
  try {
    if (!existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
    if (!raw || typeof raw !== 'object') return null
    const out: Partial<LaunchConfig> = {}
    if (typeof raw.launchCommand === 'string' && raw.launchCommand.trim()) {
      out.launchCommand = raw.launchCommand.trim()
    }
    if (Array.isArray(raw.presets)) {
      out.presets = raw.presets.filter(isPreset)
    }
    if (Array.isArray(raw.models)) {
      out.models = raw.models.filter(isModel)
    }
    if (typeof raw.worktreeInit === 'string' && raw.worktreeInit.trim()) {
      out.worktreeInit = raw.worktreeInit.trim()
    }
    if (raw.features && typeof raw.features === 'object') {
      const f = raw.features as Record<string, unknown>
      const feats: Partial<FeatureFlags> = {}
      const m = asMagic(f.magicCompact)
      if (m) feats.magicCompact = m
      const h = asHandoff(f.handoff)
      if (h) feats.handoff = h
      if (Object.keys(feats).length > 0) out.features = feats
    }
    return out
  } catch {
    return null
  }
}

export function resolveLaunchConfig(
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env
): LaunchConfig {
  const merged: LaunchConfig = {
    launchCommand: DEFAULT_LAUNCH_COMMAND,
    presets: [],
    models: DEFAULT_MODELS
  }
  // global first, then local (local wins).
  for (const src of [readConfigFile(globalConfigPath(env)), readConfigFile(localConfigPath(projectDir))]) {
    if (!src) continue
    if (src.launchCommand) merged.launchCommand = src.launchCommand
    if (src.presets) merged.presets = src.presets
    // Only override the default model list when the file supplies a non-empty one.
    if (src.models && src.models.length > 0) merged.models = src.models
    if (src.worktreeInit) merged.worktreeInit = src.worktreeInit
  }
  return merged
}

/** The launchCommand a PROJECT config supplies, or null (PLAN C19 gating). */
export function projectLaunchCommand(projectDir: string): string | null {
  return readConfigFile(localConfigPath(projectDir))?.launchCommand ?? null
}

/** The launchCommand ignoring any project config: global file, else default. */
export function globalLaunchCommand(env: NodeJS.ProcessEnv = process.env): string {
  return readConfigFile(globalConfigPath(env))?.launchCommand ?? DEFAULT_LAUNCH_COMMAND
}

/**
 * The worktreeInit hook a PROJECT config supplies, or null (B5 gating). A
 * project-sourced worktreeInit runs through a shell on worktree creation, so —
 * exactly like `projectLaunchCommand` — it must pass the one-time C19 operator
 * approval before it is honored.
 */
export function projectWorktreeInit(projectDir: string): string | null {
  return readConfigFile(localConfigPath(projectDir))?.worktreeInit ?? null
}

/** The worktreeInit ignoring any project config: global file, else undefined. */
export function globalWorktreeInit(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return readConfigFile(globalConfigPath(env))?.worktreeInit
}

/**
 * Resolve the effective per-machine feature flags (CT3). Trust rules differ per
 * flag:
 *  - `handoff` only shapes advisory briefing text (never reaches a shell/PTY),
 *    so it follows normal precedence: a project-local value wins over global.
 *  - `magicCompact` gates the Deck typing a command into an agent's terminal, so
 *    it is decided by the GLOBAL config only; a project-local (clonable, hence
 *    hostile) value may only RESTRICT it to 'off', never enable it. This mirrors
 *    the launchCommand / worktreeInit gating (project config can restrict, not
 *    grant, shell-reaching behavior).
 */
export function resolveFeatures(
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env
): FeatureFlags {
  const global = readConfigFile(globalConfigPath(env))?.features
  const local = readConfigFile(localConfigPath(projectDir))?.features

  const handoff = local?.handoff ?? global?.handoff ?? DEFAULT_FEATURES.handoff

  let magicCompact = global?.magicCompact ?? DEFAULT_FEATURES.magicCompact
  if (local?.magicCompact === 'off') magicCompact = 'off' // local may only restrict

  return { magicCompact, handoff }
}

/** Create the project-local config on demand (UI action). No-op if it exists. */
export function createLocalConfig(projectDir: string): string {
  const file = localConfigPath(projectDir)
  if (existsSync(file)) return file
  mkdirSync(dirname(file), { recursive: true })
  const template: LaunchConfig = {
    launchCommand: DEFAULT_LAUNCH_COMMAND,
    presets: [],
    models: DEFAULT_MODELS
  }
  writeFileSync(file, JSON.stringify(template, null, 2), 'utf-8')
  return file
}

/** Persist the global launch config (Settings dialog, M5). */
export function saveGlobalConfig(cfg: LaunchConfig, env: NodeJS.ProcessEnv = process.env): string {
  const file = globalConfigPath(env)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf-8')
  return file
}
