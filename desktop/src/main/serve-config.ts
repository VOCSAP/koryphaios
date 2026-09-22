import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { commandHash, resolveApprovedLaunchCommand } from './launch-approval'
import { reportError } from './log'
import { resolveWithin } from './explorer-service'

const SERVE_FILE = ['.claude', 'claude-peers', 'serve.json']
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/

export const SERVE_CONFIG_FIELD_NAMES = {
  root: ['version', 'name', 'actions', 'primary'],
  action: ['name', 'cwd', 'command', 'port', 'url', 'health', 'readyTimeoutSec', 'env', 'inheritEnv']
} as const

type ServeActionFieldName = (typeof SERVE_CONFIG_FIELD_NAMES.action)[number]

// Exclude only fields that cannot alter the executed process or its environment.
export const SERVE_OUTSIDE_APPROVAL_FIELDS = ['name', 'url', 'health', 'readyTimeoutSec'] as const satisfies readonly ServeActionFieldName[]

function deriveServeApprovalFields(): ServeActionFieldName[] {
  const fields = SERVE_CONFIG_FIELD_NAMES.action
  const outsideApproval = new Set<ServeActionFieldName>(SERVE_OUTSIDE_APPROVAL_FIELDS)
  if (outsideApproval.size !== SERVE_OUTSIDE_APPROVAL_FIELDS.length || [...outsideApproval].some((field) => !fields.includes(field))) {
    throw new Error('serve outside-approval fields must be declared action fields')
  }
  return fields.filter((field) => !outsideApproval.has(field))
}

export const SERVE_APPROVAL_FIELDS = deriveServeApprovalFields()

export interface ServeAction {
  name: string
  cwd: string
  command: string
  port: 'auto' | number
  url: string
  health: string
  readyTimeoutSec: number
  env: Record<string, string>
  inheritEnv: string[]
}

export interface ServeConfig {
  version: 1
  name?: string
  actions: [ServeAction]
  primary?: string
}

export type ServeConfigReadResult = { config: ServeConfig } | { error: string }

export interface ServeApprovalPrompt {
  command: string
  cwd: string
  env: Record<string, string>
}

export type ServeApprovalResult =
  | { config: ServeConfig; prompted: boolean }
  | { error: 'refused'; prompted: true }

class ServeConfigValidationError extends Error {
  constructor(readonly field: string, message: string) {
    super(`${field}: ${message}`)
  }
}

function reject(field: string, message: string): never {
  throw new ServeConfigValidationError(field, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) reject(field, 'must be an object')
  return value
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) reject(field, 'must be a non-empty string')
  return value
}

function assertKnownFields(value: Record<string, unknown>, fields: readonly string[]): void {
  const allowed = new Set<string>(fields)
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) reject(field, 'unknown field')
  }
}

function parsePort(value: unknown): 'auto' | number {
  if (value === undefined) return 'auto'
  if (value === 'auto') return value
  if (typeof value !== 'number') reject('port', 'must be "auto" or an integer')
  if (Number.isNaN(value)) reject('port', 'must not be NaN')
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    reject('port', 'must be an integer from 1024 to 65535')
  }
  return value
}

function parseReadyTimeout(value: unknown): number {
  if (value === undefined) return 30
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isInteger(value)) {
    reject('readyTimeoutSec', 'must be an integer from 1 to 600')
  }
  if (value < 1 || value > 600) reject('readyTimeoutSec', 'must be an integer from 1 to 600')
  return value
}

function assertAllowedEnvName(name: string, field: string): void {
  if (!ENV_NAME.test(name)) reject(field, `invalid variable name: ${name}`)
  if (name === 'PORT' || name === 'HOST') reject(field, `reserved variable: ${name}`)
}

function parseEnv(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  const env = requireRecord(value, 'env')
  const result: Record<string, string> = {}
  for (const [name, entry] of Object.entries(env)) {
    assertAllowedEnvName(name, 'env')
    if (typeof entry !== 'string') reject('env', `value for ${name} must be a string`)
    result[name] = entry
  }
  return result
}

function parseInheritedEnv(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) reject('inheritEnv', 'must be an array')
  return value.map((name) => {
    if (typeof name !== 'string') reject('inheritEnv', 'must contain environment variable names')
    assertAllowedEnvName(name, 'inheritEnv')
    return name
  })
}

async function parseAction(value: unknown, projectDir: string): Promise<ServeAction> {
  const action = requireRecord(value, 'actions[0]')
  assertKnownFields(action, SERVE_CONFIG_FIELD_NAMES.action)
  const name = requireText(action.name, 'name')
  const declaredCwd = requireText(action.cwd, 'cwd')
  if (isAbsolute(declaredCwd)) reject('cwd', 'must be relative to the project')
  let cwd: string
  try {
    cwd = await resolveWithin(projectDir, declaredCwd)
  } catch (error) {
    reject('cwd', error instanceof Error ? error.message : String(error))
  }
  const command = requireText(action.command, 'command')
  const url = requireText(action.url, 'url')
  const health = action.health === undefined ? url : requireText(action.health, 'health')

  return {
    name,
    cwd,
    command,
    port: parsePort(action.port),
    url,
    health,
    readyTimeoutSec: parseReadyTimeout(action.readyTimeoutSec),
    env: parseEnv(action.env),
    inheritEnv: parseInheritedEnv(action.inheritEnv)
  }
}

export async function validateServeConfig(raw: unknown, projectDir: string): Promise<ServeConfig> {
  const root = requireRecord(raw, 'root')
  assertKnownFields(root, SERVE_CONFIG_FIELD_NAMES.root)
  if (root.version !== 1) reject('version', 'must be 1')
  const name = root.name === undefined ? undefined : requireText(root.name, 'name')
  if (!Array.isArray(root.actions)) reject('actions', 'must be an array')
  if (root.actions.length !== 1) {
    reject('actions', root.actions.length > 1 ? 'compound actions are not supported' : 'exactly one action is required')
  }
  const action = await parseAction(root.actions[0], projectDir)
  const primary = root.primary === undefined ? undefined : requireText(root.primary, 'primary')
  if (primary !== undefined && primary !== action.name) {
    reject('primary', 'must name the only action')
  }
  return {
    version: 1,
    ...(name === undefined ? {} : { name }),
    actions: [action],
    ...(primary === undefined ? {} : { primary })
  }
}

export async function readServeConfig(projectDir: string): Promise<ServeConfigReadResult> {
  let text: string
  try {
    text = await readFile(join(projectDir, ...SERVE_FILE), 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { error: 'missing' }
    }
    reportError('serve-config', 'could not read serve.json', error)
    return { error: 'read' }
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    reportError('serve-config', 'invalid serve.json', error)
    return { error: 'invalid JSON' }
  }

  try {
    return { config: await validateServeConfig(raw, projectDir) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    reportError('serve-config', `rejected serve.json: ${message}`, error)
    return { error: message }
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function serveApprovalPayload(config: ServeConfig): string {
  const action = config.actions[0]
  return canonicalJson(Object.fromEntries(SERVE_APPROVAL_FIELDS.map((field) => [field, action[field]])))
}

export function serveApprovalHash(config: ServeConfig): string {
  return commandHash(serveApprovalPayload(config))
}

export function resolveApprovedServeConfig(opts: {
  config: ServeConfig
  projectKey: string
  approvalsFile: string
  confirm: (details: ServeApprovalPrompt) => boolean
}): ServeApprovalResult {
  const action = opts.config.actions[0]
  const decision = resolveApprovedLaunchCommand({
    projectKey: `${opts.projectKey}::serve`,
    projectCommand: serveApprovalPayload(opts.config),
    fallback: '',
    approvalsFile: opts.approvalsFile,
    confirm: () => opts.confirm({ command: action.command, cwd: action.cwd, env: action.env })
  })
  if (decision.source === 'project') {
    return { config: opts.config, prompted: decision.prompted }
  }
  return { error: 'refused', prompted: true }
}
