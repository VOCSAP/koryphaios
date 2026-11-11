import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractParenBody } from './_braced-body'
import { detectThalpos, prewarmAndDetectThalpos, THALPOS_DEFAULT_MAX_HOURS, THALPOS_PLUGIN_KEY } from '../desktop/src/main/thalpos-detect'

const CONFIG_DIR = join('cfg', 'claude')
const SETTINGS = join(CONFIG_DIR, 'settings.json')
const INSTALLED = join(CONFIG_DIR, 'plugins', 'installed_plugins.json')

const withOptions = (options: unknown): Record<string, unknown> => ({ pluginConfigs: { [THALPOS_PLUGIN_KEY]: { options } } })
const enabledSettings = (extra: Record<string, unknown> = withOptions({ autostart: true })): string =>
  JSON.stringify({ enabledPlugins: { [THALPOS_PLUGIN_KEY]: true }, ...extra })
const installedList = JSON.stringify({ version: 2, plugins: { [THALPOS_PLUGIN_KEY]: [{ scope: 'user', version: '0.2.0' }] } })

interface Harness {
  detect: (cliVersion?: string) => ReturnType<typeof detectThalpos>
  reports: { scope: string; message: string; error?: unknown }[]
  reads: string[]
}

function harness(files: Record<string, string | Error>): Harness {
  const reports: Harness['reports'] = []
  const reads: string[] = []
  return {
    reports,
    reads,
    detect: (cliVersion) =>
      detectThalpos({
        configDir: CONFIG_DIR,
        cliVersion,
        readFile: (path) => {
          reads.push(path)
          const file = files[path]
          if (file instanceof Error) throw file
          return file
        },
        report: (scope, message, error) => reports.push({ scope, message, error })
      })
  }
}

describe('prewarmAndDetectThalpos', () => {
  test('waits for the Claude version prewarm before detecting', async () => {
    let releasePrewarm: () => void = () => {}
    const prewarm = new Promise<void>((resolve) => { releasePrewarm = resolve })
    let detected = 0
    const result = prewarmAndDetectThalpos({
      prewarm: () => prewarm,
      detect: () => {
        detected++
        return { usable: true, maxHours: 12 }
      },
      report: () => {}
    })

    await Promise.resolve()
    expect(detected).toBe(0)
    releasePrewarm()
    await expect(result).resolves.toEqual({ usable: true, maxHours: 12 })
    expect(detected).toBe(1)
  })

  test('reports a rejected Claude version prewarm and still detects', async () => {
    const reports: Array<[string, string, unknown]> = []
    const result = await prewarmAndDetectThalpos({
      prewarm: async () => { throw new Error('prewarm failed') },
      detect: () => ({ usable: true, maxHours: 12 }),
      report: (scope, message, error) => reports.push([scope, message, error])
    })

    expect(result).toEqual({ usable: true, maxHours: 12 })
    expect(reports).toHaveLength(1)
    expect(reports[0]?.[0]).toBe('thalpos')
    expect(reports[0]?.[1]).toContain('prewarm')
    expect(reports[0]?.[2]).toBeInstanceOf(Error)
  })
})

describe('thalpos:status IPC wiring', () => {
  test('waits for the Claude version prewarm before detecting and reports failures', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'desktop', 'src', 'main', 'ipc.ts'), 'utf8')
    const anchor = "regHandle('thalpos:status',"
    const handlerStart = source.indexOf(anchor)
    expect(handlerStart, 'thalpos:status handler must be registered once').toBeGreaterThanOrEqual(0)
    expect(source.indexOf(anchor, handlerStart + anchor.length), 'thalpos:status handler must be registered once').toBe(-1)

    const handler = extractParenBody(source, source.indexOf('(', handlerStart), true)
    const call = 'prewarmAndDetectThalpos('
    const callStart = handler.indexOf(call)
    expect(callStart, 'thalpos:status must prewarm before detecting').toBeGreaterThanOrEqual(0)
    const input = extractParenBody(handler, handler.indexOf('(', callStart), true)

    expect(input, 'thalpos:status must provide the Claude version prewarm').toMatch(/\bprewarm\s*:\s*\(\)\s*=>\s*prewarmClaudeVersion\(/)
    expect(input, 'thalpos:status must provide Thalpos detection').toMatch(/\bdetect\s*:\s*getThalposStatus\b/)
    expect(input, 'thalpos:status must report rejected prewarms').toMatch(/\breport\s*:\s*reportError\b/)
  })
})

describe('detectThalpos: enabled in the user settings', () => {
  test('usable when enabled, installed and the CLI is recent enough; reads the two files under configDir', () => {
    const h = harness({ [SETTINGS]: enabledSettings(), [INSTALLED]: installedList })
    expect(h.detect('2.1.303')).toEqual({ usable: true, maxHours: THALPOS_DEFAULT_MAX_HOURS })
    expect(h.reads).toEqual([INSTALLED, SETTINGS])
  })

  test.each([
    ['false', { [THALPOS_PLUGIN_KEY]: false }],
    ['absent key', { 'other@choregos': true }],
    ['string "true"', { [THALPOS_PLUGIN_KEY]: 'true' }],
    ['number 1', { [THALPOS_PLUGIN_KEY]: 1 }],
    ['enabledPlugins not an object', 'thalpos']
  ])('disabled when the value is %s', (_label, enabledPlugins) => {
    const h = harness({ [SETTINGS]: JSON.stringify({ enabledPlugins }), [INSTALLED]: installedList })
    expect(h.detect('2.1.303')).toEqual({ usable: false, reason: 'disabled' })
  })

  test('disabled without a report when settings.json is absent', () => {
    const h = harness({ [INSTALLED]: installedList })
    expect(h.detect()).toEqual({ usable: false, reason: 'disabled' })
    expect(h.reports).toEqual([])
  })

  test('disabled when the settings top level is not an object, reported as unreadable', () => {
    const h = harness({ [SETTINGS]: '[]', [INSTALLED]: installedList })
    expect(h.detect()).toEqual({ usable: false, reason: 'settings-unreadable' })
    expect(h.reports).toHaveLength(1)
  })
})

describe('detectThalpos: installed', () => {
  test.each([
    ['key missing', JSON.stringify({ plugins: { 'other@choregos': [{}] } })],
    ['empty entry list', JSON.stringify({ plugins: { [THALPOS_PLUGIN_KEY]: [] } })],
    ['entry not a list', JSON.stringify({ plugins: { [THALPOS_PLUGIN_KEY]: {} } })],
    ['plugins not an object', JSON.stringify({ plugins: [] })]
  ])('not-installed when %s', (_label, installed) => {
    const h = harness({ [SETTINGS]: enabledSettings(), [INSTALLED]: installed })
    expect(h.detect('2.1.303')).toEqual({ usable: false, reason: 'not-installed' })
  })

  test('not-installed when installed_plugins.json is absent, without a report', () => {
    const h = harness({ [SETTINGS]: enabledSettings() })
    expect(h.detect()).toEqual({ usable: false, reason: 'not-installed' })
    expect(h.reports).toEqual([])
  })

  test('installed list is read before disabled settings', () => {
    const h = harness({ [SETTINGS]: JSON.stringify({ enabledPlugins: {} }), [INSTALLED]: installedList })
    expect(h.detect()).toEqual({ usable: false, reason: 'disabled' })
    expect(h.reads).toEqual([INSTALLED, SETTINGS])
  })

  test('a missing installation is reported before missing settings', () => {
    const h = harness({})
    expect(h.detect()).toEqual({ usable: false, reason: 'not-installed' })
    expect(h.reads).toEqual([INSTALLED])
    expect(h.reports).toEqual([])
  })

  test('a project-scope installation alone is not installed for the global setting', () => {
    const projectInstall = JSON.stringify({ version: 2, plugins: { [THALPOS_PLUGIN_KEY]: [{ scope: 'project', version: '0.2.0' }] } })
    const h = harness({ [SETTINGS]: enabledSettings(), [INSTALLED]: projectInstall })
    expect(h.detect()).toEqual({ usable: false, reason: 'not-installed' })
  })

  test('an old user installation reports plugin-too-old', () => {
    const oldUserInstall = JSON.stringify({ version: 2, plugins: { [THALPOS_PLUGIN_KEY]: [{ scope: 'user', version: '0.1.0' }] } })
    const h = harness({ [SETTINGS]: enabledSettings(), [INSTALLED]: oldUserInstall })
    expect(h.detect()).toEqual({ usable: false, reason: 'plugin-too-old' })
  })

  test('a current user installation is usable', () => {
    const h = harness({ [SETTINGS]: enabledSettings(), [INSTALLED]: installedList })
    expect(h.detect()).toEqual({ usable: true, maxHours: THALPOS_DEFAULT_MAX_HOURS })
  })

  test('a user installation at 0.10.0 is usable', () => {
    const installed = JSON.stringify({ version: 2, plugins: { [THALPOS_PLUGIN_KEY]: [{ scope: 'user', version: '0.10.0' }] } })
    const h = harness({ [SETTINGS]: enabledSettings(), [INSTALLED]: installed })
    expect(h.detect()).toEqual({ usable: true, maxHours: THALPOS_DEFAULT_MAX_HOURS })
  })

  test.each([
    ['old then current', ['0.1.0', '0.2.0']],
    ['current then old', ['0.2.0', '0.1.0']]
  ])('a user installation list is usable when %s', (_label, versions) => {
    const entries = versions.map((version) => ({ scope: 'user', version }))
    const installed = JSON.stringify({ version: 2, plugins: { [THALPOS_PLUGIN_KEY]: entries } })
    const h = harness({ [SETTINGS]: enabledSettings(), [INSTALLED]: installed })
    expect(h.detect()).toEqual({ usable: true, maxHours: THALPOS_DEFAULT_MAX_HOURS })
  })

  test.each([
    ['absent', {}],
    ['number', { version: 2 }],
    ['array', { version: ['0.2.0'] }],
    ['null', { version: null }],
    ['short', { version: '0.2' }],
    ['pre-release', { version: '0.2.0-dev' }],
    ['prefixed', { version: 'v0.2.0' }]
  ])('a user installation with a %s version is plugin-too-old', (_label, version) => {
    const installed = JSON.stringify({ version: 2, plugins: { [THALPOS_PLUGIN_KEY]: [{ scope: 'user', ...version }] } })
    const h = harness({ [SETTINGS]: enabledSettings(), [INSTALLED]: installed })
    expect(h.detect()).toEqual({ usable: false, reason: 'plugin-too-old' })
  })
})

describe('detectThalpos: CLI version', () => {
  test.each([
    ['2.1.303', true],
    ['2.1.304', true],
    ['2.2.0', true],
    ['3.0.0', true],
    ['2.1.302', false],
    ['2.0.999', false],
    ['1.9.999', false],
    ['2.1.303-dev', false],
    ['garbage', false],
    ['', false]
  ])('version %p usable=%p', (version, usable) => {
    const h = harness({ [SETTINGS]: enabledSettings(), [INSTALLED]: installedList })
    const result = h.detect(version)
    expect(result.usable).toBe(usable)
    if (!usable) expect(result).toEqual({ usable: false, reason: 'cli-too-old' })
  })

  test('version check is skipped when no version is given', () => {
    const h = harness({ [SETTINGS]: enabledSettings(), [INSTALLED]: installedList })
    expect(h.detect(undefined).usable).toBe(true)
  })
})

describe('detectThalpos: max_hours', () => {
  const withHours = (hours: unknown): Harness =>
    harness({
      [SETTINGS]: enabledSettings(withOptions({ autostart: true, max_hours: hours })),
      [INSTALLED]: installedList
    })

  test.each([
    [5, 5],
    [0.5, 0.5],
    [0, THALPOS_DEFAULT_MAX_HOURS],
    [-3, THALPOS_DEFAULT_MAX_HOURS],
    ['5', THALPOS_DEFAULT_MAX_HOURS],
    [null, THALPOS_DEFAULT_MAX_HOURS]
  ])('max_hours %p gives %p', (configured, expected) => {
    expect(withHours(configured).detect()).toEqual({ usable: true, maxHours: expected })
  })

  test('default max_hours when the options carry autostart only', () => {
    const h = harness({ [SETTINGS]: enabledSettings(), [INSTALLED]: installedList })
    expect(h.detect()).toEqual({ usable: true, maxHours: THALPOS_DEFAULT_MAX_HOURS })
  })
})

describe('detectThalpos: autostart consent', () => {
  test.each([
    ['false', withOptions({ autostart: false })],
    ['absent option', withOptions({ max_hours: 5 })],
    ['string "true"', withOptions({ autostart: 'true' })],
    ['number 1', withOptions({ autostart: 1 })],
    ['options not an object', withOptions('x')],
    ['entry without options', { pluginConfigs: { [THALPOS_PLUGIN_KEY]: {} } }],
    ['pluginConfigs not an object', { pluginConfigs: 'x' }],
    ['no pluginConfigs', {}]
  ])('autostart-off when the option is %s', (_label, extra) => {
    const h = harness({ [SETTINGS]: enabledSettings(extra), [INSTALLED]: installedList })
    expect(h.detect('2.1.303')).toEqual({ usable: false, reason: 'autostart-off' })
  })

  test('an old CLI is reported before the missing consent', () => {
    const h = harness({ [SETTINGS]: enabledSettings(withOptions({ autostart: false })), [INSTALLED]: installedList })
    expect(h.detect('2.1.302')).toEqual({ usable: false, reason: 'cli-too-old' })
  })

  test('a missing install is reported before the missing consent', () => {
    const h = harness({ [SETTINGS]: enabledSettings(withOptions({ autostart: false })) })
    expect(h.detect()).toEqual({ usable: false, reason: 'not-installed' })
  })
})

describe('detectThalpos: unreadable files are reported, never swallowed', () => {
  test('invalid JSON in settings.json: settings-unreadable and one report naming the path', () => {
    const h = harness({ [SETTINGS]: '{ not json', [INSTALLED]: installedList })
    expect(h.detect()).toEqual({ usable: false, reason: 'settings-unreadable' })
    expect(h.reports).toHaveLength(1)
    expect(h.reports[0]!.scope).toBe('thalpos')
    expect(h.reports[0]!.message).toContain(SETTINGS)
    expect(h.reports[0]!.error).toBeInstanceOf(Error)
  })

  test('I/O error on settings.json is reported with the original error', () => {
    const failure = new Error('EACCES')
    const h = harness({ [SETTINGS]: failure, [INSTALLED]: installedList })
    expect(h.detect()).toEqual({ usable: false, reason: 'settings-unreadable' })
    expect(h.reports[0]!.error).toBe(failure)
  })

  test('invalid JSON in installed_plugins.json: installed-unreadable and one report naming the path', () => {
    const h = harness({ [SETTINGS]: enabledSettings(), [INSTALLED]: 'nope' })
    expect(h.detect('2.1.303')).toEqual({ usable: false, reason: 'installed-unreadable' })
    expect(h.reports).toHaveLength(1)
    expect(h.reports[0]!.message).toContain(INSTALLED)
  })
})
