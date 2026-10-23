import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { detectRateLimit } from '../desktop/src/main/quota'
import { createXtermScreen, inspectInjectGuard } from '../desktop/src/main/xterm-screen'
import { classifyAssistantBlock, GUARD_SAFE_BORDER } from '../desktop/mods/prosopon/hooks/layout'
import { modsFingerprint, type ModFile } from '../shared/mods-fingerprint'
import { isBunTestFile, LOCK_PATH, MODS_DIR, PLUGINS, readPluginAtCommit, writePlugins, type ModsLock } from '../scripts/sync-mods'

const esc = String.fromCharCode(27)

function filesUnder(root: string): ModFile[] {
  return readdirSync(root, { recursive: true, withFileTypes: true }).flatMap((entry) => {
    const absolute = join(entry.parentPath, entry.name)
    if (entry.isDirectory()) return []
    if (!entry.isFile()) throw new Error(`${absolute}: neither a directory nor a regular file, the fingerprint cannot cover it`)
    return [{ path: relative(root, absolute).split('\\').join('/'), bytes: new Uint8Array(readFileSync(absolute)) }]
  })
}

const lock: ModsLock = JSON.parse(readFileSync(LOCK_PATH, 'utf-8'))

describe('pinned choregos copy', () => {

  test('pins a full commit and locks every plugin directory present', () => {
    expect(lock.commit).toMatch(/^[0-9a-f]{40}$/)
    const directories = readdirSync(MODS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    expect(directories.sort()).toEqual(Object.keys(lock.plugins).sort())
  })

  test.each(Object.keys(lock.plugins))(
    'the %s copy on disk matches its locked fingerprint and version',
    (plugin) => {
      const files = filesUnder(join(MODS_DIR, plugin))
      const locked = lock.plugins[plugin]!
      expect(modsFingerprint(files), `${plugin} drifted from choregos@${lock.commit}: re-run scripts/sync-mods.ts, never edit the copy`).toBe(
        locked.fingerprint
      )
      expect(JSON.parse(readFileSync(join(MODS_DIR, plugin, '.claude-plugin', 'plugin.json'), 'utf-8')).version).toBe(locked.version)
    }
  )

  test('holds no file a bare bun test would collect', () => {
    const collected = filesUnder(MODS_DIR).map((file) => file.path).filter(isBunTestFile)
    expect(collected).toEqual([])
  })

  test('recognizes the test file shapes bun discovers in a nested directory', () => {
    expect(isBunTestFile('tests/contract.test.tsx')).toBe(true)
    expect(isBunTestFile('hooks/x_spec.ts')).toBe(true)
    expect(isBunTestFile('hooks/layout.ts')).toBe(false)
    expect(isBunTestFile('hooks/register.tsx')).toBe(false)
  })
})

describe('sync script against a choregos fixture repository', () => {
  let repo: string

  function run(args: string[], input?: string): string {
    const result = spawnSync('git', ['-C', repo, ...args], {
      input,
      encoding: 'utf-8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
    })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr || result.error?.message}`)
    return result.stdout.trim()
  }

  const objects = new Map<string, string>()
  const stored = (args: string[], input: string): string => {
    const key = `${args.join(' ')}\0${input}`
    if (!objects.has(key)) objects.set(key, run(args, input))
    return objects.get(key)!
  }

  // Built with mktree: `git add` refuses a .git segment, and a hostile upstream is not bound by that.
  function commitOf(files: Record<string, string>): string {
    type Dir = Map<string, Dir | string>
    const root: Dir = new Map()
    for (const [path, content] of Object.entries(files)) {
      const segments = path.split('/')
      let dir = root
      for (const segment of segments.slice(0, -1)) {
        if (!dir.has(segment)) dir.set(segment, new Map())
        dir = dir.get(segment) as Dir
      }
      dir.set(segments.at(-1)!, stored(['hash-object', '-w', '--stdin'], content))
    }
    const treeOf = (dir: Dir): string =>
      stored(
        ['mktree'],
        [...dir].map(([name, child]) => (typeof child === 'string' ? `100644 blob ${child}\t${name}` : `040000 tree ${treeOf(child)}\t${name}`)).join('\n') + '\n'
      )
    return run(['commit-tree', treeOf(root), '-m', 'fixture'])
  }

  const BASE = {
    LICENSE: 'MIT',
    'plugins/p/.claude-plugin/plugin.json': '{"version":"1.0.0"}',
    'plugins/p/hooks/hooks.json': '{}',
    'plugins/p/README.md': '# p'
  }

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'kory-mods-repo-'))
    run(['init', '-q'])
  })
  afterAll(() => rmSync(repo, { recursive: true, force: true }))

  test('copies the distributable files and the root LICENSE, never tests/', () => {
    const commit = commitOf({ ...BASE, 'plugins/p/tests/helper.ts': 'export {}' })
    expect(readPluginAtCommit(repo, commit, 'p').map((file) => file.path).sort()).toEqual([
      '.claude-plugin/plugin.json',
      'LICENSE',
      'README.md',
      'hooks/hooks.json'
    ])
  })

  test.each([
    ['plugins/p/.gitattributes', /segment '\.gitattributes'/],
    ['plugins/p/.gitmodules', /segment '\.gitmodules'/],
    ['plugins/p/.git/config', /segment '\.git'/],
    ['plugins/p/.git/hooks/pre-commit', /segment '\.git'/],
    ['plugins/p/hooks/.git/config', /segment '\.git'/],
    ['plugins/p/hooks/.gitattributes', /segment '\.gitattributes'/],
    ['plugins/p/hooks\\evil.ts', /backslash/],
    ['plugins/p/package.json', /distributable/],
    ['plugins/p/scripts/run.sh', /distributable/],
    ['plugins/p/tsconfig.json', /engine writes/],
    ['plugins/p/.claude-plugin/types/.gitignore', /engine writes/],
    ['plugins/p/.claude-plugin/types/tsconfig.json', /engine writes/],
    ['plugins/p/.claude-plugin/types/claude-code/index.d.ts', /engine writes/],
    ['plugins/p/Tsconfig.json', /engine writes/],
    ['plugins/p/.claude-plugin/Types/claude-code/index.d.ts', /engine writes/],
    ['plugins/p/.CLAUDE-PLUGIN/types/.gitignore', /engine writes/]
  ])('refuses %s', (path, reason) => {
    const commit = commitOf({ ...BASE, [path]: 'x' })
    expect(() => readPluginAtCommit(repo, commit, 'p')).toThrow(reason)
  })

  test('keeps a file whose name merely starts like an engine path', () => {
    const commit = commitOf({ ...BASE, 'plugins/p/.claude-plugin/types.md': 'x' })
    expect(readPluginAtCommit(repo, commit, 'p').map((file) => file.path)).toContain('.claude-plugin/types.md')
  })

  test.each(['../x', 'Prosopon', 'a/b', '', '-x', 'x'.repeat(65)])('refuses the plugin name %j before reading the repository', (plugin) => {
    expect(() => readPluginAtCommit(repo, 'HEAD', plugin)).toThrow(/does not match/)
  })

  test('the plugins the script syncs are exactly the plugins the lock pins', () => {
    expect([...PLUGINS].sort(), 'PLUGINS in scripts/sync-mods.ts and the plugins of choregos.lock.json must name the same set: a plugin only in the lock is never refreshed, one only in PLUGINS is never pinned').toEqual(
      Object.keys(lock.plugins).sort()
    )
  })

  test('the committed lock preserves the plugin load order', () => {
    expect(Object.keys(lock.plugins)).toEqual([...PLUGINS])
  })

  test('the sync order makes Mitos the outer render hook before Prosopon', () => {
    expect(PLUGINS).toEqual(['mitos', 'prosopon'])
  })

  test('a run over a commit holding every locked plugin replaces each copy and rewrites each lock entry', () => {
    const names = Object.keys(lock.plugins)
    const upstream: Record<string, string> = { LICENSE: 'MIT' }
    names.forEach((name, index) => {
      upstream[`plugins/${name}/.claude-plugin/plugin.json`] = `{"version":"7.${index}.0"}`
      upstream[`plugins/${name}/hooks/hooks.json`] = `{"plugin":"${name}"}`
      upstream[`plugins/${name}/README.md`] = `# ${name}`
    })
    const commit = commitOf(upstream)

    const layout = mkdtempSync(join(tmpdir(), 'kory-mods-sync-'))
    try {
      mkdirSync(join(layout, 'scripts'))
      mkdirSync(join(layout, 'shared'))
      copyFileSync(join(import.meta.dir, '..', 'scripts', 'sync-mods.ts'), join(layout, 'scripts', 'sync-mods.ts'))
      copyFileSync(join(import.meta.dir, '..', 'shared', 'mods-fingerprint.ts'), join(layout, 'shared', 'mods-fingerprint.ts'))
      const modsDir = join(layout, 'desktop', 'mods')
      for (const name of names) {
        mkdirSync(join(modsDir, name), { recursive: true })
        writeFileSync(join(modsDir, name, 'stale.txt'), 'previous copy')
      }

      const result = spawnSync(process.execPath, [join(layout, 'scripts', 'sync-mods.ts'), '--repo', repo, '--commit', commit], { encoding: 'utf-8' })
      expect(result.status, `sync-mods exited ${result.status}: ${result.stderr}`).toBe(0)

      const written: ModsLock = JSON.parse(readFileSync(join(modsDir, 'choregos.lock.json'), 'utf-8'))
      expect(written.commit).toBe(commit)
      expect(Object.keys(written.plugins).sort(), 'every plugin present upstream and in the previous lock must get a lock entry').toEqual([...names].sort())
      expect(
        readdirSync(modsDir).filter((entry) => entry !== 'choregos.lock.json').sort(),
        'the script must leave one directory per locked plugin and no staging leftover'
      ).toEqual([...names].sort())
      names.forEach((name, index) => {
        const files = filesUnder(join(modsDir, name))
        expect(files.map((file) => file.path).sort(), `${name}: the previous copy must be replaced, not merged into`).toEqual([
          '.claude-plugin/plugin.json',
          'LICENSE',
          'README.md',
          'hooks/hooks.json'
        ])
        expect(written.plugins[name], `${name}: its lock entry must carry the version and the fingerprint of the files written`).toEqual({
          version: `7.${index}.0`,
          fingerprint: modsFingerprint(files)
        })
      })
    } finally {
      rmSync(layout, { recursive: true, force: true })
    }
  })
})

describe('copy writer', () => {
  let modsDir: string
  const file = (path: string): ModFile => ({ path, bytes: new TextEncoder().encode(path) })

  beforeAll(() => {
    modsDir = mkdtempSync(join(tmpdir(), 'kory-mods-out-'))
  })
  afterAll(() => rmSync(modsDir, { recursive: true, force: true }))

  test('leaves every existing copy untouched when one target is refused', () => {
    for (const plugin of ['a', 'b']) {
      mkdirSync(join(modsDir, plugin), { recursive: true })
      writeFileSync(join(modsDir, plugin, 'keep.txt'), 'old')
    }
    expect(() =>
      writePlugins(modsDir, [
        { plugin: 'a', files: [file('hooks/x.ts')] },
        { plugin: 'b', files: [file('hooks/A.ts'), file('hooks/a.ts')] }
      ])
    ).toThrow(/case is folded/)
    expect(readdirSync(modsDir).sort()).toEqual(['a', 'b'])
    expect(readdirSync(join(modsDir, 'a'))).toEqual(['keep.txt'])
    expect(readdirSync(join(modsDir, 'b'))).toEqual(['keep.txt'])
  })

  test('replaces a copy whole and leaves no staging directory', () => {
    writePlugins(modsDir, [{ plugin: 'a', files: [file('hooks/x.ts')] }])
    expect(existsSync(join(modsDir, 'a', 'keep.txt'))).toBe(false)
    expect(readFileSync(join(modsDir, 'a', 'hooks', 'x.ts'), 'utf-8')).toBe('hooks/x.ts')
    expect(readdirSync(modsDir).sort()).toEqual(['a', 'b'])
  })

  test('clears a residual retired directory before swapping a copy in', () => {
    const residual = join(modsDir, `.a.retired-${process.pid}`)
    mkdirSync(residual)
    writeFileSync(join(residual, 'stale.txt'), 'stale')
    writePlugins(modsDir, [{ plugin: 'a', files: [file('hooks/z.ts')] }])
    expect(readdirSync(modsDir).sort()).toEqual(['a', 'b'])
    expect(readdirSync(join(modsDir, 'a', 'hooks'))).toEqual(['z.ts'])
  })

  const failingStagingRename = (failRollback: boolean) => (from: string, to: string) => {
    if (basename(from).startsWith('.b.staging-')) throw new Error('injected swap failure')
    if (failRollback && basename(from).startsWith('.b.retired-')) throw new Error('injected rollback failure')
    renameSync(from, to)
  }

  test('restores the previous copy and removes the staging directory when the swap fails', () => {
    expect(() => writePlugins(modsDir, [{ plugin: 'b', files: [file('hooks/y.ts')] }], failingStagingRename(false))).toThrow(
      'injected swap failure'
    )
    expect(readdirSync(modsDir).sort()).toEqual(['a', 'b'])
    expect(readdirSync(join(modsDir, 'b'))).toEqual(['keep.txt'])
    expect(readFileSync(join(modsDir, 'b', 'keep.txt'), 'utf-8')).toBe('old')
  })

  test('reports both failures when the previous copy cannot be restored either', () => {
    let thrown: unknown
    try {
      writePlugins(modsDir, [{ plugin: 'b', files: [file('hooks/y.ts')] }], failingStagingRename(true))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors.map((error: Error) => error.message)).toEqual(['injected swap failure', 'injected rollback failure'])
    expect(readdirSync(modsDir).some((name) => name.startsWith('.b.staging-'))).toBe(false)
    expect(readdirSync(modsDir).some((name) => name.startsWith('.b.retired-'))).toBe(true)
  })
})

describe('copy file walker', () => {
  test('refuses a link it cannot fingerprint', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-mods-walk-'))
    try {
      mkdirSync(join(root, 'target'))
      writeFileSync(join(root, 'target', 'f.ts'), 'x')
      symlinkSync(join(root, 'target'), join(root, 'link'), 'junction')
      expect(() => filesUnder(root)).toThrow(/neither a directory nor a regular file/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('copy fingerprint', () => {
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
  const lf = [
    { path: 'hooks/layout.ts', bytes: encode('export const a = 1\nexport const b = 2\n') },
    { path: 'README.md', bytes: encode('# p\n') }
  ]

  test('is the same for an LF and a CRLF checkout', () => {
    const crlf = lf.map((file) => ({ path: file.path, bytes: encode(new TextDecoder().decode(file.bytes).replaceAll('\n', '\r\n')) }))
    expect(modsFingerprint(crlf)).toBe(modsFingerprint(lf))
  })

  test('changes when one byte changes', () => {
    const edited = [{ path: lf[0]!.path, bytes: encode('export const a = 2\nexport const b = 2\n') }, lf[1]!]
    expect(modsFingerprint(edited)).not.toBe(modsFingerprint(lf))
  })

  test('does not let a file name and content that imitate the separator collide with two files', () => {
    const nul = String.fromCharCode(0)
    const two = [
      { path: 'a', bytes: encode('X') },
      { path: 'b', bytes: encode('Y') }
    ]
    const one = [{ path: 'a', bytes: encode(`X${nul}b${nul}Y`) }]
    expect(modsFingerprint(one)).not.toBe(modsFingerprint(two))
  })

  test('does not move a byte between a path and its content', () => {
    expect(modsFingerprint([{ path: 'ab', bytes: encode('c') }])).not.toBe(modsFingerprint([{ path: 'a', bytes: encode('bc') }]))
  })

  test('changes when a file is renamed', () => {
    const renamed = [{ path: 'hooks/layout2.ts', bytes: lf[0]!.bytes }, lf[1]!]
    expect(modsFingerprint(renamed)).not.toBe(modsFingerprint(lf))
  })
})

describe('prosopon frame against the real injection guard', () => {
  const BORDER_GLYPHS: Record<string, { tl: string; tr: string; bl: string; br: string; h: string; v: string }> = {
    single: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' },
    round: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' }
  }
  const glyphsOf = (style: string) => {
    if (!Object.hasOwn(BORDER_GLYPHS, style)) throw new Error(`no glyph table for border style '${style}'`)
    return BORDER_GLYPHS[style]!
  }

  const BODIES = [
    'A plain answer. '.repeat(11),
    '1. a\n2. b',
    'Choose:\n❯ 1. oui',
    '╭──╮\n╰──╯',
    `See https://example.com/${'a'.repeat(150)}`
  ]

  function frameRows(style: string, body: string, cols: number): string[] {
    const g = glyphsOf(style)
    const inner = cols - 4
    const rows = body.split('\n').flatMap((line) => {
      const chars = [...line]
      const chunks: string[] = []
      for (let i = 0; i < chars.length; i += inner) chunks.push(chars.slice(i, i + inner).join(''))
      return chunks.length ? chunks : ['']
    })
    return [
      `${g.tl}${g.h.repeat(cols - 2)}${g.tr}`,
      ...rows.map((row) => `${g.v} ${row}${' '.repeat(inner - [...row].length)} ${g.v}`),
      `${g.bl}${g.h.repeat(cols - 2)}${g.br}`
    ]
  }

  async function inspectScreen(data: string, cols: number, rows: number) {
    const screen = createXtermScreen({ cols, rows, reportError: () => undefined })
    screen.feed(data)
    await screen.drain()
    const read = screen.read()
    screen.dispose()
    if (read.status !== 'ready') throw new Error(`xterm screen unavailable: ${read.reason}`)
    return inspectInjectGuard(read.snapshot)
  }

  function transcript(style: string, cols: number): string {
    const rows = BODIES.flatMap((body) => frameRows(style, body, cols))
    return rows.map((row, y) => `${esc}[${y + 2};1H${row}`).join('')
  }

  const SYNTHETIC_ROWS = 40
  const syntheticComposer = (cols: number): string => {
    const horizontal = '─'
    return `${esc}[37;1H${horizontal.repeat(cols)}${esc}[38;1H❯${esc}[39;1H${horizontal.repeat(cols)}${esc}[38;3H`
  }

  test('frames every sample body with the copy classifier', () => {
    for (const body of BODIES) expect(classifyAssistantBlock(body, false), body).toBe('frame')
  })

  test.each([40, 80, 120])('keeps a synthetic composer clear under prosopon frames at %i columns', async (cols) => {
    expect(await inspectScreen(transcript(GUARD_SAFE_BORDER, cols) + syntheticComposer(cols), cols, SYNTHETIC_ROWS)).toEqual({ state: 'clear' })
  })

  test.each([40, 80, 120])('rejects the same grid drawn with round corners at %i columns', async (cols) => {
    expect(await inspectScreen(transcript('round', cols) + syntheticComposer(cols), cols, SYNTHETIC_ROWS)).toEqual({
      state: 'modal',
      rule: 'dialog',
      line: 2
    })
  })

  test('keeps a captured composer clear under prosopon frames', async () => {
    const fixture: { data: string }[] = JSON.parse(
      readFileSync(join(import.meta.dir, 'pty-harness', 'fixtures', 'composer-2.1.283-reduced.json'), 'utf-8')
    )
    const captured = fixture.filter((chunk) => !chunk.data.startsWith('\n########## ')).map((chunk) => chunk.data).join('')
    const frame = frameRows(GUARD_SAFE_BORDER, BODIES[2]!, 120)
    const drawn = frame.map((row, y) => `${esc}[${y + 2};1H${row}`).join('')
    expect(await inspectScreen(captured + drawn + `${esc}[15;3H`, 120, 40)).toEqual({ state: 'clear' })
  })

  test('leaves every quota message the detector reads in stock rendering', () => {
    const now = Date.now()
    const messages = [
      "⎿  You've hit your limit · resets 10:30pm (Europe/London)",
      '⎿  5-hour limit reached ∙ resets 2pm',
      '⎿  weekly limit reached, resets in 2 hours',
      "⎿  You've hit your limit — try later",
      '⎿  Limit reached (resets 8m)'
    ]
    for (const message of messages) {
      expect(detectRateLimit(message, now), message).not.toBeNull()
      expect(classifyAssistantBlock(message, false), message).toBe('stock')
    }
  })
})
