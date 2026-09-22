import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDeckLog } from '../desktop/src/main/log.ts'
import {
  SERVE_APPROVAL_FIELDS,
  SERVE_CONFIG_FIELD_NAMES,
  SERVE_OUTSIDE_APPROVAL_FIELDS,
  readServeConfig,
  resolveApprovedServeConfig,
  serveApprovalHash,
  type ServeConfig,
  type ServeConfigReadResult,
  validateServeConfig
} from '../desktop/src/main/serve-config.ts'

const projects: string[] = []
const logsDir = mkdtempSync(join(tmpdir(), 'cp-serve-logs-'))

function createProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'cp-serve-config-'))
  mkdirSync(join(project, '.claude', 'claude-peers'), { recursive: true })
  mkdirSync(join(project, 'web'), { recursive: true })
  projects.push(project)
  return project
}

function servePath(project: string): string {
  return join(project, '.claude', 'claude-peers', 'serve.json')
}

function validServeJson(): Record<string, unknown> {
  return {
    version: 1,
    name: 'Web server',
    actions: [
      {
        name: 'web',
        cwd: 'web',
        command: 'bun run dev -- --host ${HOST} --port ${PORT}',
        port: 'auto',
        url: 'http://${HOST}:${PORT}/',
        health: 'http://${HOST}:${PORT}/health',
        readyTimeoutSec: 30,
        env: { BROWSER: 'none', NODE_ENV: 'development' },
        inheritEnv: ['PATH', 'HOME']
      }
    ],
    primary: 'web'
  }
}

function writeServeJson(project: string, value: unknown): void {
  writeFileSync(servePath(project), JSON.stringify(value), 'utf-8')
}

function errorOf(result: ServeConfigReadResult): string {
  if ('error' in result) return result.error
  throw new Error('expected serve config rejection')
}

function actionOf(fixture: Record<string, unknown>): Record<string, unknown> {
  return (fixture.actions as Array<Record<string, unknown>>)[0]!
}

async function validConfig(project: string) {
  writeServeJson(project, validServeJson())
  const result = await readServeConfig(project)
  if ('error' in result) throw new Error(result.error)
  return result.config
}

beforeAll(() => {
  initDeckLog(logsDir)
})

afterEach(() => {
  for (const project of projects.splice(0)) {
    rmSync(project, { recursive: true, force: true })
  }
})

afterAll(() => {
  rmSync(logsDir, { recursive: true, force: true })
})

test('accepts a complete v1 serve.json and resolves the action cwd', async () => {
  const project = createProject()
  const config = await validConfig(project)

  expect(config.version).toBe(1)
  expect(config.actions).toHaveLength(1)
  expect(config.actions[0]!.cwd).toBe(realpathSync(join(project, 'web')))
  expect(config.actions[0]!.port).toBe('auto')
})

test('rejects ../x and absolute cwd values', async () => {
  const project = createProject()
  const escapeTarget = join(project, '..', 'outside')
  mkdirSync(escapeTarget)

  try {
    const traversing = validServeJson()
    actionOf(traversing).cwd = '../outside'
    await expect(validateServeConfig(traversing, project)).rejects.toThrow('cwd')

    const absolute = validServeJson()
    actionOf(absolute).cwd = join(project, 'web')
    await expect(validateServeConfig(absolute, project)).rejects.toThrow('cwd')
  } finally {
    rmSync(escapeTarget, { recursive: true, force: true })
  }
})

test('returns missing without logging an error and reports read JSON validation failures', async () => {
  const project = createProject()

  expect(await readServeConfig(project)).toEqual({ error: 'missing' })
  mkdirSync(servePath(project))
  expect(await readServeConfig(project)).toEqual({ error: 'read' })
  rmSync(servePath(project), { recursive: true, force: true })
  writeFileSync(servePath(project), '{broken', 'utf-8')
  expect(errorOf(await readServeConfig(project))).toContain('invalid JSON')
  const invalid = validServeJson()
  invalid.version = '1'
  writeServeJson(project, invalid)
  expect(errorOf(await readServeConfig(project))).toContain('version')

  const log = readFileSync(join(logsDir, 'main.log'), 'utf-8')
  expect(log).not.toContain('[serve-config] serve.json is missing')
  expect(log).toContain('[serve-config] could not read serve.json')
  expect(log).toContain('[serve-config] invalid serve.json')
  expect(log).toContain('[serve-config] rejected serve.json: version: must be 1')
})

test('rejects an invalid type for every declared field', async () => {
  const wrongRootValue: Record<string, unknown> = {
    version: '1',
    name: 1,
    actions: {},
    primary: 1
  }
  const wrongActionValue: Record<string, unknown> = {
    name: 1,
    cwd: 1,
    command: 1,
    port: {},
    url: 1,
    health: 1,
    readyTimeoutSec: '30',
    env: [],
    inheritEnv: {}
  }

  for (const field of SERVE_CONFIG_FIELD_NAMES.root) {
    const project = createProject()
    const fixture = validServeJson()
    fixture[field] = wrongRootValue[field] ?? null
    writeServeJson(project, fixture)
    expect(errorOf(await readServeConfig(project))).toContain(field)
  }

  for (const field of SERVE_CONFIG_FIELD_NAMES.action) {
    const project = createProject()
    const fixture = validServeJson()
    const actions = fixture.actions as Array<Record<string, unknown>>
    actions[0]![field] = wrongActionValue[field] ?? null
    writeServeJson(project, fixture)
    expect(errorOf(await readServeConfig(project))).toContain(field)
  }
})

test('rejects constrained values that retain their structural types', async () => {
  const invalidCases: Array<{
    field: string
    mutate: (fixture: Record<string, unknown>) => void
  }> = [
    { field: 'port', mutate: (fixture) => { actionOf(fixture).port = 1023 } },
    { field: 'port', mutate: (fixture) => { actionOf(fixture).port = 65_536 } },
    { field: 'port', mutate: (fixture) => { actionOf(fixture).port = 8_080.5 } },
    { field: 'readyTimeoutSec', mutate: (fixture) => { actionOf(fixture).readyTimeoutSec = 0 } },
    { field: 'readyTimeoutSec', mutate: (fixture) => { actionOf(fixture).readyTimeoutSec = 601 } },
    { field: 'readyTimeoutSec', mutate: (fixture) => { actionOf(fixture).readyTimeoutSec = 1.5 } },
    { field: 'env', mutate: (fixture) => { actionOf(fixture).env = { lower: 'value' } } },
    { field: 'env', mutate: (fixture) => { actionOf(fixture).env = { PORT: '5000' } } },
    { field: 'env', mutate: (fixture) => { actionOf(fixture).env = { HOST: '127.0.0.1' } } },
    { field: 'env', mutate: (fixture) => { actionOf(fixture).env = { NAME: 1 } } },
    { field: 'inheritEnv', mutate: (fixture) => { actionOf(fixture).inheritEnv = ['lower'] } },
    { field: 'inheritEnv', mutate: (fixture) => { actionOf(fixture).inheritEnv = ['PORT'] } },
    { field: 'inheritEnv', mutate: (fixture) => { actionOf(fixture).inheritEnv = ['HOST'] } },
    { field: 'primary', mutate: (fixture) => { fixture.primary = 'api' } }
  ]

  for (const invalidCase of invalidCases) {
    const project = createProject()
    const fixture = validServeJson()
    invalidCase.mutate(fixture)
    writeServeJson(project, fixture)
    expect(errorOf(await readServeConfig(project))).toContain(invalidCase.field)
  }
})

test('applies defaults when optional fields are absent', async () => {
  const project = createProject()
  const fixture = validServeJson()
  delete fixture.name
  delete fixture.primary
  const action = actionOf(fixture)
  delete action.port
  delete action.health
  delete action.readyTimeoutSec
  delete action.env
  delete action.inheritEnv

  const config = await validateServeConfig(fixture, project)
  expect(config.name).toBeUndefined()
  expect(config.primary).toBeUndefined()
  expect(config.actions[0]!.port).toBe('auto')
  expect(config.actions[0]!.health).toBe(config.actions[0]!.url)
  expect(config.actions[0]!.readyTimeoutSec).toBe(30)
  expect(config.actions[0]!.env).toEqual({})
  expect(config.actions[0]!.inheritEnv).toEqual([])
})

test('rejects NaN, compound actions, and unknown fields without returning a subset', async () => {
  const project = createProject()
  const nanFixture = validServeJson()
  const nanActions = nanFixture.actions as Array<Record<string, unknown>>
  nanActions[0]!.port = Number.NaN
  await expect(validateServeConfig(nanFixture, project)).rejects.toThrow('port')

  const compoundFixture = validServeJson()
  const compoundActions = compoundFixture.actions as Array<Record<string, unknown>>
  compoundActions.push({ ...compoundActions[0]!, name: 'api' })
  writeServeJson(project, compoundFixture)
  expect(errorOf(await readServeConfig(project))).toContain('actions')

  const rootUnknown = validServeJson()
  rootUnknown.typo = true
  writeServeJson(project, rootUnknown)
  expect(errorOf(await readServeConfig(project))).toContain('typo')

  const actionUnknown = validServeJson()
  const actionUnknownActions = actionUnknown.actions as Array<Record<string, unknown>>
  actionUnknownActions[0]!.typo = true
  writeServeJson(project, actionUnknown)
  expect(errorOf(await readServeConfig(project))).toContain('typo')
})

test('derives approval fields from the closed outside-approval set', () => {
  expect(SERVE_OUTSIDE_APPROVAL_FIELDS).toEqual(['name', 'url', 'health', 'readyTimeoutSec'])
  expect(SERVE_APPROVAL_FIELDS).toEqual(
    SERVE_CONFIG_FIELD_NAMES.action.filter((field) => !SERVE_OUTSIDE_APPROVAL_FIELDS.includes(field))
  )
})

test('keeps execution-neutral fields outside approval', async () => {
  const project = createProject()
  const config = await validConfig(project)
  const action = config.actions[0]!
  const reordered: ServeConfig = {
    ...config,
    actions: [{ ...action, env: { NODE_ENV: 'development', BROWSER: 'none' } }]
  }
  const changedName: ServeConfig = {
    ...config,
    primary: 'preview',
    actions: [{ ...action, name: 'preview' }]
  }
  const changedUrl: ServeConfig = {
    ...config,
    actions: [{ ...action, url: 'http://${HOST}:${PORT}/preview' }]
  }
  const changedHealth: ServeConfig = {
    ...config,
    actions: [{ ...action, health: 'http://${HOST}:${PORT}/ready' }]
  }
  const changedTimeout: ServeConfig = {
    ...config,
    actions: [{ ...action, readyTimeoutSec: 45 }]
  }
  const changedEnv: ServeConfig = {
    ...config,
    actions: [{ ...action, env: { ...action.env, MODE: 'preview' } }]
  }

  expect(serveApprovalHash(reordered)).toBe(serveApprovalHash(config))
  expect(serveApprovalHash(changedName)).toBe(serveApprovalHash(config))
  expect(serveApprovalHash(changedUrl)).toBe(serveApprovalHash(config))
  expect(serveApprovalHash(changedHealth)).toBe(serveApprovalHash(config))
  expect(serveApprovalHash(changedTimeout)).toBe(serveApprovalHash(config))
  expect(serveApprovalHash(changedEnv)).not.toBe(serveApprovalHash(config))
})

test('requires one explicit approval before exposing a repository serve config', async () => {
  const project = createProject()
  const config = await validConfig(project)
  const action = config.actions[0]!
  const approvalsFile = join(project, 'launch-approvals.json')
  let prompt: { command: string; cwd: string; env: Record<string, string> } | undefined

  const refused = resolveApprovedServeConfig({
    config,
    projectKey: 'github.com/acme/web',
    approvalsFile,
    confirm: (details) => {
      prompt = details
      return false
    }
  })
  expect(refused).toEqual({ error: 'refused', prompted: true })
  expect(prompt).toEqual({ command: action.command, cwd: action.cwd, env: action.env })

  const approved = resolveApprovedServeConfig({
    config,
    projectKey: 'github.com/acme/web',
    approvalsFile,
    confirm: () => true
  })
  expect('config' in approved).toBe(true)
  expect(approved.prompted).toBe(true)

  const changedTimeout: ServeConfig = {
    ...config,
    actions: [{ ...action, readyTimeoutSec: 45 }]
  }
  const retainedApproval = resolveApprovedServeConfig({
    config: changedTimeout,
    projectKey: 'github.com/acme/web',
    approvalsFile,
    confirm: () => {
      throw new Error('ready timeout must not require a new approval')
    }
  })
  expect('config' in retainedApproval).toBe(true)
  expect(retainedApproval.prompted).toBe(false)
})

test('canonicalizes a symlinked project prefix before accepting cwd', async () => {
  const outer = mkdtempSync(join(tmpdir(), 'cp-serve-link-'))
  const realProject = join(outer, 'project')
  const linkedProject = join(outer, 'via-link')
  mkdirSync(join(realProject, '.claude', 'claude-peers'), { recursive: true })
  mkdirSync(join(realProject, 'web'), { recursive: true })
  symlinkSync(realProject, linkedProject, 'junction')

  try {
    writeServeJson(linkedProject, validServeJson())
    const config = await validConfig(linkedProject)
    expect(config.actions[0]!.cwd).toBe(realpathSync(join(realProject, 'web')))
  } finally {
    rmSync(outer, { recursive: true, force: true })
  }
})
