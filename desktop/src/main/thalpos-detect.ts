import { join } from 'node:path'
import type { ThalposStatus } from '../shared/types'
import { reportError } from './log'

export const THALPOS_PLUGIN_KEY = 'thalpos@choregos'
export const THALPOS_MIN_CLI_VERSION = '2.1.303'
export const THALPOS_MIN_PLUGIN_VERSION = '0.2.0'
export const THALPOS_DEFAULT_MAX_HOURS = 12

export interface ThalposDetectInput {
  configDir: string
  cliVersion?: string
  // Returns undefined for an absent file and throws on any other I/O error.
  readFile: (path: string) => string | undefined
  report?: (scope: string, message: string, error?: unknown) => void
}

type JsonRead = { kind: 'absent' } | { kind: 'unreadable' } | { kind: 'object'; value: Record<string, unknown> }

const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRelease(version: string): [number, number, number] | undefined {
  const match = RELEASE.exec(version)
  if (!match) return undefined
  const parts: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])]
  return parts.every(Number.isSafeInteger) ? parts : undefined
}

// A development build is spelled '2.1.303-dev', not as a release, so it is refused.
function meetsMinimum(version: string, minimumVersion: string): boolean {
  const current = parseRelease(version)
  const minimum = parseRelease(minimumVersion)
  if (current === undefined || minimum === undefined) return false
  for (let i = 0; i < 3; i++) {
    if (current[i] !== minimum[i]) return current[i]! > minimum[i]!
  }
  return true
}

function readJsonObject(path: string, readFile: ThalposDetectInput['readFile'], report: NonNullable<ThalposDetectInput['report']>): JsonRead {
  try {
    const text = readFile(path)
    if (text === undefined) return { kind: 'absent' }
    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed)) throw new Error('top-level value is not a JSON object')
    return { kind: 'object', value: parsed }
  } catch (error) {
    report('thalpos', `failed to read ${path}`, error)
    return { kind: 'unreadable' }
  }
}

function pluginOptions(settings: Record<string, unknown>): Record<string, unknown> {
  const configs = settings.pluginConfigs
  const entry = isRecord(configs) ? configs[THALPOS_PLUGIN_KEY] : undefined
  const options = isRecord(entry) ? entry.options : undefined
  return isRecord(options) ? options : {}
}

function configuredMaxHours(options: Record<string, unknown>): number {
  const hours = options.max_hours
  return typeof hours === 'number' && Number.isFinite(hours) && hours > 0 ? hours : THALPOS_DEFAULT_MAX_HOURS
}

export async function prewarmAndDetectThalpos(input: {
  prewarm: () => Promise<void>
  detect: () => ThalposStatus
  report: (scope: string, message: string, error?: unknown) => void
}): Promise<ThalposStatus> {
  try {
    await input.prewarm()
  } catch (error) {
    input.report('thalpos', 'failed to prewarm Claude Code version before reading status', error)
  }
  return input.detect()
}

export function detectThalpos(input: ThalposDetectInput): ThalposStatus {
  const { configDir, cliVersion, readFile } = input
  const report = input.report ?? reportError

  const installed = readJsonObject(join(configDir, 'plugins', 'installed_plugins.json'), readFile, report)
  if (installed.kind === 'unreadable') return { usable: false, reason: 'installed-unreadable' }
  const plugins = installed.kind === 'object' ? installed.value.plugins : undefined
  const entries = isRecord(plugins) ? plugins[THALPOS_PLUGIN_KEY] : undefined
  if (!Array.isArray(entries) || entries.length === 0) return { usable: false, reason: 'not-installed' }
  const userEntries = entries.filter((entry): entry is Record<string, unknown> => isRecord(entry) && entry.scope === 'user')
  if (userEntries.length === 0) return { usable: false, reason: 'not-installed' }
  if (!userEntries.some((entry) => typeof entry.version === 'string' && meetsMinimum(entry.version, THALPOS_MIN_PLUGIN_VERSION))) {
    return { usable: false, reason: 'plugin-too-old' }
  }

  const settings = readJsonObject(join(configDir, 'settings.json'), readFile, report)
  if (settings.kind === 'unreadable') return { usable: false, reason: 'settings-unreadable' }
  const enabledPlugins = settings.kind === 'object' ? settings.value.enabledPlugins : undefined
  if (settings.kind !== 'object' || !isRecord(enabledPlugins) || enabledPlugins[THALPOS_PLUGIN_KEY] !== true) {
    return { usable: false, reason: 'disabled' }
  }

  if (cliVersion !== undefined && !meetsMinimum(cliVersion, THALPOS_MIN_CLI_VERSION)) return { usable: false, reason: 'cli-too-old' }

  const options = pluginOptions(settings.value)
  if (options.autostart !== true) return { usable: false, reason: 'autostart-off' }

  return { usable: true, maxHours: configuredMaxHours(options) }
}
