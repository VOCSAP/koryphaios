import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ENGINE_JSX, enabledModsFromLock, ensureModWorkingCopy, loadModsLock, type WorkingCopyRequest } from '../desktop/src/main/mods-working-copy'
import * as modsWorkingCopy from '../desktop/src/main/mods-working-copy'
import { modsFingerprint, type ModFile } from '../shared/mods-fingerprint'

const scratchDirs: string[] = []
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kory-mods-wc-'))
  scratchDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
const BASE: Record<string, string> = {
  LICENSE: 'MIT\n',
  README: '# p\n',
  '.claude-plugin/plugin.json': '{"version":"1.0.0"}\n',
  'hooks/hooks.json': '{}\n',
  'hooks/register.ts': 'export {}\nexport const a = 1\n'
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    const target = join(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text)
  }
}

function fingerprintOf(files: Record<string, string>): string {
  const mods: ModFile[] = Object.entries(files).map(([path, text]) => ({ path, bytes: encode(text) }))
  return modsFingerprint(mods)
}

interface Fixture {
  distDir: string
  workRoot: string
  plugin: string
  fingerprint: string
  lock: Map<string, string>
  dir: string
  request: (overrides?: Partial<WorkingCopyRequest>) => WorkingCopyRequest
}

function fixture(files: Record<string, string> = BASE, plugin = 'p'): Fixture {
  const root = scratch()
  const distDir = join(root, 'dist')
  const workRoot = join(root, 'work')
  writeTree(join(distDir, plugin), files)
  const fingerprint = fingerprintOf(files)
  const lock = new Map([[plugin, fingerprint]])
  return {
    distDir,
    workRoot,
    plugin,
    fingerprint,
    lock,
    dir: join(workRoot, plugin, fingerprint),
    request: (overrides = {}) => ({ distDir, workRoot, plugin, lock, ...overrides })
  }
}

const ENGINE_ROOT_TSCONFIG = '{\n  "extends": "./.claude-plugin/types/tsconfig.json"\n}\n'
function typesTsconfig(patch: (parsed: Record<string, any>) => void = () => undefined): string {
  const parsed = {
    compilerOptions: {
      target: 'es2023',
      lib: ['es2023'],
      module: 'esnext',
      moduleResolution: 'bundler',
      strict: true,
      noUncheckedIndexedAccess: true,
      noEmit: true,
      skipLibCheck: true,
      jsx: ENGINE_JSX,
      jsxFactory: 'h',
      jsxFragmentFactory: 'Fragment',
      typeRoots: ['.'],
      types: ['claude-code', 'claude-code-tools', 'claude-code-mcp']
    },
    include: ['../../hooks', '../../types', '../../tests']
  } as Record<string, any>
  patch(parsed)
  return JSON.stringify(parsed, null, 2) + '\n'
}

function writeEngineOutput(dir: string, tsconfig = typesTsconfig()): void {
  writeTree(dir, {
    'tsconfig.json': ENGINE_ROOT_TSCONFIG,
    '.claude-plugin/types/tsconfig.json': tsconfig,
    '.claude-plugin/types/.gitignore': '*\n',
    '.claude-plugin/types/claude-code/index.d.ts': 'declare const marker: 1\n'
  })
}

async function ensureOk(request: WorkingCopyRequest) {
  const outcome = await ensureModWorkingCopy(request)
  if (!outcome.ok) throw new Error(`expected a working copy, got ${outcome.reason}: ${outcome.message}`)
  return outcome
}

function filesOf(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1).split('\\').join('/'))
    .sort()
}

describe('working copy materialization', async () => {
  test('materializes a conforming distributed copy, then reuses it without recopying', async () => {
    const f = fixture()
    const first = await ensureOk(f.request())
    expect(first).toMatchObject({ dir: f.dir, reused: false, drifted: null })
    expect(filesOf(f.dir)).toEqual(Object.keys(BASE).sort())

    const marker = join(f.dir, '.claude-plugin', 'types', 'copied-once.d.ts')
    mkdirSync(dirname(marker), { recursive: true })
    writeFileSync(marker, 'sentinel')
    const second = await ensureOk(f.request())
    expect(second).toMatchObject({ dir: f.dir, reused: true, drifted: null })
    expect(readFileSync(marker, 'utf-8'), 'a recopy would have replaced the directory and lost the sentinel').toBe('sentinel')
  })

  test('hashes a CRLF checkout of the distributed copy to the locked fingerprint', async () => {
    const f = fixture()
    for (const path of Object.keys(BASE)) {
      const target = join(f.distDir, f.plugin, path)
      writeFileSync(target, readFileSync(target, 'utf-8').replaceAll('\n', '\r\n'))
    }
    expect((await ensureOk(f.request())).reused).toBe(false)
  })

  test('keeps the copy when the engine writes its tsconfig.json and types, in the extends form', async () => {
    const f = fixture()
    await ensureOk(f.request())
    writeEngineOutput(f.dir)
    const sentinel = join(f.dir, '.claude-plugin', 'types', 'claude-code', 'index.d.ts')
    expect(await ensureOk(f.request())).toMatchObject({ reused: true, drifted: null })
    expect(readFileSync(sentinel, 'utf-8'), 'the engine output must not trigger a recopy').toBe('declare const marker: 1\n')
    expect(readdirSync(join(f.workRoot, f.plugin))).toEqual([f.fingerprint])
  })

  test('recognizes engine paths whatever their case, as NTFS and APFS fold it', async () => {
    const f = fixture()
    await ensureOk(f.request())
    writeTree(f.dir, { 'Tsconfig.json': ENGINE_ROOT_TSCONFIG, '.claude-plugin/Types/claude-code/index.d.ts': 'declare const marker: 1\n' })
    expect(await ensureOk(f.request())).toMatchObject({ reused: true, drifted: null })
    expect(readdirSync(join(f.workRoot, f.plugin))).toEqual([f.fingerprint])
  })

  test('keeps two locked versions of one plugin in two directories', async () => {
    const f = fixture()
    await ensureOk(f.request())
    const v2 = { ...BASE, 'hooks/register.ts': 'export const a = 2\n' }
    writeTree(join(f.distDir, f.plugin), v2)
    const second = await ensureOk(f.request({ lock: new Map([[f.plugin, fingerprintOf(v2)]]) }))
    expect(second.dir).not.toBe(f.dir)
    expect(readdirSync(join(f.workRoot, f.plugin)).sort()).toEqual([f.fingerprint, fingerprintOf(v2)].sort())
    expect(readFileSync(join(f.dir, 'hooks', 'register.ts'), 'utf-8')).toBe(BASE['hooks/register.ts']!)
  })

  test('lets a concurrent materialization win, without retrying onto its directory, and removes its own staging', async () => {
    const f = fixture()
    let raced = false
    let stagingRenames = 0
    const outcome = await ensureOk(
      f.request({
        rename: async (from, to) => {
          if (from.includes('.staging-')) {
            stagingRenames++
            if (!raced) {
              raced = true
              await ensureOk(f.request())
            }
          }
          renameSync(from, to)
        }
      })
    )
    expect(raced).toBe(true)
    expect(stagingRenames, 'a rename onto an existing directory fails for good: retrying it only waits').toBe(1)
    expect(outcome).toMatchObject({ dir: f.dir, reused: true })
    expect(filesOf(f.dir)).toEqual(Object.keys(BASE).sort())
    expect(readdirSync(join(f.workRoot, f.plugin)), 'the loser must not leave its staging behind').toEqual([f.fingerprint])
  })

  test('refuses when the concurrent winner left a directory that does not conform', async () => {
    const f = fixture()
    let raced = false
    const outcome = await ensureModWorkingCopy(
      f.request({
        rename: async (from, to) => {
          if (!raced && from.includes('.staging-')) {
            raced = true
            await ensureOk(f.request())
            writeTree(f.dir, { '.mcp.json': '{}' })
          }
          renameSync(from, to)
        }
      })
    )
    expect(outcome).toMatchObject({ ok: false, reason: 'materialize' })
    expect(readFileSync(join(f.dir, '.mcp.json'), 'utf-8')).toBe('{}')
    expect(readdirSync(join(f.workRoot, f.plugin)), 'the loser removes its staging and moves nothing aside').toEqual([f.fingerprint])
  })

  test('refuses when the plugin parent becomes a junction after staging rename', async () => {
    const f = fixture()
    const outside = scratch()
    const parent = join(f.workRoot, f.plugin)
    const parked = `${parent}.parked`
    const outcome = await ensureModWorkingCopy(
      f.request({
        rename: async (from, to) => {
          renameSync(from, to)
          if (from.includes('.staging-')) {
            renameSync(parent, parked)
            symlinkSync(outside, parent, 'junction')
          }
        }
      })
    )

    expect(outcome).toMatchObject({ ok: false, reason: 'unsafe-parent' })
    expect(readdirSync(outside), 'the renamed copy must not be accepted through the replacement junction').toEqual([])
  })

  test('refuses a replaced parent between staging retries and identifies the abandoned staging directory', async () => {
    const f = fixture()
    const outside = scratch()
    const parent = join(f.workRoot, f.plugin)
    const parked = `${parent}.parked`
    const staging = `${f.dir}.staging-fixed`
    let attempts = 0
    const outcome = await ensureModWorkingCopy(
      f.request({
        nonce: () => 'fixed',
        rename: (from, to) => {
          attempts++
          if (attempts === 1) throw Object.assign(new Error('EPERM injected'), { code: 'EPERM' })
          renameSync(from, to)
        },
        wait: () => {
          renameSync(parent, parked)
          symlinkSync(outside, parent, 'junction')
        }
      })
    )

    expect(outcome).toMatchObject({ ok: false, reason: 'unsafe-parent', message: expect.stringContaining(staging) })
    expect(attempts).toBe(1)
    expect(existsSync(join(parked, `${f.fingerprint}.staging-fixed`))).toBe(true)
    expect(readdirSync(outside), 'the retry must not write through the replacement junction').toEqual([])
  })

  test('ignores an abandoned staging directory', async () => {
    const f = fixture()
    const abandoned = join(f.workRoot, f.plugin, `${f.fingerprint}.staging-dead`)
    writeTree(abandoned, { 'half.txt': 'x' })
    expect((await ensureOk(f.request())).reused).toBe(false)
    expect(readFileSync(join(abandoned, 'half.txt'), 'utf-8')).toBe('x')
  })

  test('verifies a prepared copy without repairing drift (mutation: use ensureModWorkingCopy)', async () => {
    const f = fixture()
    await ensureOk(f.request())
    writeTree(f.dir, { '.mcp.json': '{}' })
    const verify = (modsWorkingCopy as unknown as { verifyModWorkingCopy: (request: WorkingCopyRequest) => unknown }).verifyModWorkingCopy
    expect(verify(f.request())).toMatchObject({ ok: false })
    expect(readFileSync(join(f.dir, '.mcp.json'), 'utf-8')).toBe('{}')
  })

  test('retries a staging rename that fails transiently with EPERM', async () => {
    const f = fixture()
    let refused = 0
    const waits: number[] = []
    const outcome = await ensureOk(
      f.request({
        rename: async (from, to) => {
          if (refused < 2) {
            refused++
            throw Object.assign(new Error('EPERM injected'), { code: 'EPERM' })
          }
          renameSync(from, to)
        },
        wait: async (delay) => {
          waits.push(delay)
        }
      })
    )
    expect(refused).toBe(2)
    expect(waits).toEqual([10, 20])
    expect(outcome).toMatchObject({ dir: f.dir, reused: false })
  })

  test('reports a refused staging rename as a failed materialization, without retrying it, and leaves no working copy', async () => {
    const f = fixture()
    let attempts = 0
    const outcome = await ensureModWorkingCopy(
      f.request({
        rename: () => {
          attempts++
          throw new Error('injected')
        }
      })
    )
    expect(outcome).toMatchObject({ ok: false, reason: 'materialize' })
    expect(attempts).toBe(1)
    expect(existsSync(f.dir)).toBe(false)
    expect(readdirSync(join(f.workRoot, f.plugin)), 'the staging it wrote is its own and is removed').toEqual([])
  })
})

describe('distributed copy verification', async () => {
  test('refuses a distributed copy that no longer matches its lock, and writes nothing', async () => {
    const f = fixture()
    writeFileSync(join(f.distDir, f.plugin, 'hooks', 'register.ts'), 'export const evil = 1\n')
    expect(await ensureModWorkingCopy(f.request())).toMatchObject({ ok: false, reason: 'distributed-drift' })
    expect(existsSync(f.workRoot)).toBe(false)
  })

  test('refuses a distributed copy holding a file the lock does not know', async () => {
    const f = fixture()
    writeTree(join(f.distDir, f.plugin), { 'bin/x': '#!/bin/sh\n' })
    expect(await ensureModWorkingCopy(f.request())).toMatchObject({ ok: false, reason: 'distributed-drift' })
  })

  test.each(['file', 'directory'] as const)('refuses a distributed copy holding a link to a %s', async (kind) => {
    const f = fixture()
    const outside = scratch()
    writeFileSync(join(outside, 'target.ts'), 'export {}')
    const link = join(f.distDir, f.plugin, 'hooks', 'link')
    if (kind === 'file') symlinkSync(join(outside, 'target.ts'), link)
    else symlinkSync(outside, link, 'junction')
    expect(await ensureModWorkingCopy(f.request())).toMatchObject({ ok: false, reason: 'distributed-drift', message: expect.stringContaining('link') })
    expect(existsSync(join(outside, 'target.ts'))).toBe(true)
  })

  test('refuses a distributed copy that is absent', async () => {
    const f = fixture()
    rmSync(join(f.distDir, f.plugin), { recursive: true })
    expect(await ensureModWorkingCopy(f.request())).toMatchObject({ ok: false, reason: 'io' })
  })
})

describe('working copy drift', async () => {
  const driftCases: [string, (dir: string) => void][] = [
    ['an extra .mcp.json', (dir) => writeTree(dir, { '.mcp.json': '{}' })],
    ['an extra bin/x', (dir) => writeTree(dir, { 'bin/x': 'run' })],
    ['an extra agents/x.md', (dir) => writeTree(dir, { 'agents/x.md': '# agent' })],
    ['an extra settings.json', (dir) => writeTree(dir, { 'settings.json': '{}' })],
    ['an extra hook file', (dir) => writeTree(dir, { 'hooks/extra.ts': 'export {}' })],
    ['an edited hook', (dir) => writeFileSync(join(dir, 'hooks', 'register.ts'), 'export const evil = 1\n')],
    ['a missing file', (dir) => rmSync(join(dir, 'README'))],
    ['a root tsconfig.json of another content', (dir) => writeTree(dir, { 'tsconfig.json': '{"compilerOptions":{"jsxImportSource":"x"}}\n' })],
    ['a root tsconfig.json that extends elsewhere', (dir) => writeTree(dir, { 'tsconfig.json': '{\n  "extends": "../elsewhere/tsconfig.json"\n}\n' })],
    ['a Tsconfig.json of another content, whatever its case', (dir) => writeTree(dir, { 'Tsconfig.json': '{"compilerOptions":{"jsxImportSource":"x"}}\n' })],
    ['a script under .claude-plugin/Types, whatever its case', (dir) => writeTree(dir, { '.claude-plugin/Types/claude-code/index.js': 'export {}' })],
    ['a script under .claude-plugin/types', (dir) => writeTree(dir, { '.claude-plugin/types/claude-code/index.js': 'export {}' })],
    ['a plugin manifest edited under .claude-plugin', (dir) => writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), '{"version":"9.9.9"}\n')]
  ]

  test.each(driftCases)('moves aside a working copy with %s and builds a fresh one', async (_label, corrupt) => {
    const f = fixture()
    await ensureOk(f.request())
    corrupt(f.dir)
    const outcome = await ensureOk(f.request())
    expect(outcome.reused).toBe(false)
    expect(outcome.drifted).toMatch(new RegExp(`${f.fingerprint}\\.drift-[0-9a-f]+$`))
    expect(existsSync(outcome.drifted!), 'the drifted directory is kept, never deleted').toBe(true)
    expect(filesOf(f.dir)).toEqual(Object.keys(BASE).sort())
    expect(await ensureOk(f.request())).toMatchObject({ reused: true, drifted: null })
  })

  const typesCases: [string, (parsed: Record<string, any>) => void][] = [
    ['paths', (parsed) => (parsed.compilerOptions.paths = { '*': ['../../evil/*'] })],
    ['baseUrl', (parsed) => (parsed.compilerOptions.baseUrl = '../..')],
    ['jsxImportSource', (parsed) => (parsed.compilerOptions.jsxImportSource = 'evil')],
    ['an extends inside compilerOptions', (parsed) => (parsed.compilerOptions.extends = '../../evil.json')],
    ['an extends at the top level', (parsed) => (parsed.extends = '../../evil.json')],
    ['an unknown compilerOptions key', (parsed) => (parsed.compilerOptions.somethingNew = true)],
    ['an unknown top-level key', (parsed) => (parsed.files = ['../../x.ts'])],
    ['jsx react-jsx, whose runtime resolves through ancestor node_modules', (parsed) => (parsed.compilerOptions.jsx = 'react-jsx')],
    ['jsx react-jsxdev', (parsed) => (parsed.compilerOptions.jsx = 'react-jsxdev')],
    ['jsx preserve', (parsed) => (parsed.compilerOptions.jsx = 'preserve')],
    ['another jsxFactory', (parsed) => (parsed.compilerOptions.jsxFactory = 'React.createElement')],
    ['another jsxFragmentFactory', (parsed) => (parsed.compilerOptions.jsxFragmentFactory = 'Frag')],
    ['another typeRoots', (parsed) => (parsed.compilerOptions.typeRoots = ['../../evil'])],
    ['another include', (parsed) => (parsed.include = ['../../hooks', '../../evil'])],
    ['no include', (parsed) => delete parsed.include]
  ]

  test.each(typesCases)('treats a types/tsconfig.json with %s as drift', async (_label, patch) => {
    const f = fixture()
    await ensureOk(f.request())
    writeEngineOutput(f.dir, typesTsconfig(patch))
    const outcome = await ensureOk(f.request())
    expect(outcome.reused).toBe(false)
    expect(outcome.drifted).not.toBeNull()
  })

  test('treats a types/tsconfig.json that is not JSON as drift', async () => {
    const f = fixture()
    await ensureOk(f.request())
    writeEngineOutput(f.dir, '{ not json')
    expect(await ensureOk(f.request()).drifted).not.toBeNull()
  })

  test.each(['file', 'directory'] as const)('treats a link to a %s inside the working copy as drift and never follows it', async (kind) => {
    const f = fixture()
    await ensureOk(f.request())
    const outside = scratch()
    writeFileSync(join(outside, 'keep.txt'), 'keep')
    if (kind === 'file') symlinkSync(join(outside, 'keep.txt'), join(f.dir, 'hooks', 'link.ts'))
    else symlinkSync(outside, join(f.dir, 'hooks', 'linkdir'), 'junction')
    const outcome = await ensureOk(f.request())
    expect(outcome.drifted).not.toBeNull()
    expect(readFileSync(join(outside, 'keep.txt'), 'utf-8')).toBe('keep')
    expect(filesOf(f.dir)).toEqual(Object.keys(BASE).sort())
  })

  test('treats a working copy that is a link as drift', async () => {
    const f = fixture()
    const outside = scratch()
    writeTree(outside, BASE)
    mkdirSync(dirname(f.dir), { recursive: true })
    symlinkSync(outside, f.dir, 'junction')
    const outcome = await ensureOk(f.request())
    expect(outcome.drifted).not.toBeNull()
    expect(existsSync(join(outside, 'LICENSE'))).toBe(true)
  })

  test('loads nothing and deletes nothing when the drifted directory cannot be moved aside', async () => {
    const f = fixture()
    await ensureOk(f.request())
    writeTree(f.dir, { '.mcp.json': '{}' })
    const outcome = await ensureModWorkingCopy(
      f.request({
        rename: async (from, to) => {
          if (from === f.dir) throw new Error('EBUSY injected')
          renameSync(from, to)
        }
      })
    )
    expect(outcome).toMatchObject({ ok: false, reason: 'drift-rename', drifted: null })
    expect(readFileSync(join(f.dir, '.mcp.json'), 'utf-8')).toBe('{}')
    expect(filesOf(f.dir)).toEqual([...Object.keys(BASE), '.mcp.json'].sort())
    expect(readdirSync(join(f.workRoot, f.plugin))).toEqual([f.fingerprint])
  })

  test('reuses the directory a concurrent Deck already repaired when the move aside fails', async () => {
    const f = fixture()
    await ensureOk(f.request())
    writeTree(f.dir, { '.mcp.json': '{}' })
    const outcome = await ensureOk(
      f.request({
        rename: async (from, to) => {
          if (from === f.dir) {
            renameSync(f.dir, `${f.dir}.drift-other`)
            await ensureOk(f.request())
            throw new Error('ENOENT injected: another Deck moved it first')
          }
          renameSync(from, to)
        }
      })
    )
    expect(outcome).toMatchObject({ dir: f.dir, reused: true })
  })

  test('refuses a parent replaced by a link while moving drift aside without writing through it', async () => {
    const f = fixture()
    const outside = scratch()
    await ensureOk(f.request())
    writeTree(f.dir, { '.mcp.json': '{}' })
    const parent = join(f.workRoot, f.plugin)
    const parked = `${parent}.parked`

    const outcome = await ensureModWorkingCopy(
      f.request({
        rename: async (from, to) => {
          renameSync(from, to)
          if (from === f.dir) {
            renameSync(parent, parked)
            symlinkSync(outside, parent, 'junction')
          }
        }
      })
    )

    expect(outcome).toMatchObject({ ok: false, reason: 'unsafe-parent' })
    expect(readdirSync(outside), 'no staging copy may be written through the replaced parent').toEqual([])
  })
})

describe('segment validation before any join', async () => {
  test.each(['../x', 'Prosopon', 'a/b', 'a\\b', '', '-x', 'x'.repeat(65), 'p\0'])('refuses the plugin name %j', async (plugin) => {
    const f = fixture()
    const lock = new Map([[plugin, f.fingerprint]])
    expect(await ensureModWorkingCopy(f.request({ plugin, lock }))).toMatchObject({ ok: false, reason: 'plugin-name' })
    expect(existsSync(f.workRoot)).toBe(false)
  })

  test.each([
    ['uppercase', 'A'.repeat(64)],
    ['too short', 'a'.repeat(63)],
    ['too long', 'a'.repeat(65)],
    ['a path', '../../etc/' + 'a'.repeat(54)],
    ['empty', '']
  ])('refuses a locked fingerprint that is %s', async (_label, fingerprint) => {
    const f = fixture()
    expect(await ensureModWorkingCopy(f.request({ lock: new Map([[f.plugin, fingerprint]]) }))).toMatchObject({ ok: false, reason: 'fingerprint' })
    expect(existsSync(f.workRoot)).toBe(false)
  })

  test('refuses a plugin that is not in the lock, including an Object.prototype name', async () => {
    const f = fixture()
    for (const plugin of ['other', 'constructor']) {
      expect(await ensureModWorkingCopy(f.request({ plugin }))).toMatchObject({ ok: false, reason: 'not-locked' })
    }
  })

  test.each(['tsconfig.json', 'jsconfig.json', 'package.json', 'bunfig.toml', 'node_modules'])('refuses a %s in the plugin directory, the work root or its parent', async (name) => {
    for (const holder of ['plugin directory', 'work root', 'parent of the work root']) {
      const f = fixture()
      const at = { 'plugin directory': join(f.workRoot, f.plugin), 'work root': f.workRoot, 'parent of the work root': dirname(f.workRoot) }[holder]!
      mkdirSync(at, { recursive: true })
      if (name === 'node_modules') mkdirSync(join(at, name))
      else writeFileSync(join(at, name), '{}')
      expect(await ensureModWorkingCopy(f.request()), `${name} in the ${holder}`).toMatchObject({ ok: false, reason: 'unsafe-parent' })
    }
  })

  test('refuses a plugin directory in the work root that is a link', async () => {
    const f = fixture()
    const outside = scratch()
    mkdirSync(f.workRoot)
    symlinkSync(outside, join(f.workRoot, f.plugin), 'junction')
    expect(await ensureModWorkingCopy(f.request())).toMatchObject({ ok: false, reason: 'unsafe-parent' })
    expect(readdirSync(outside)).toEqual([])
  })
})

describe('enabled mods', async () => {
  test('ignores a non-object activation map (mutation: omit the record check)', async () => {
    expect(enabledModsFromLock(null, new Map([['prosopon', 'a'.repeat(64)]]))).toEqual([])
  })

  test('keeps only true locked plugin names (mutation: remove lock and boolean filters)', async () => {
    const lock = new Map([
      ['prosopon', 'a'.repeat(64)],
      ['disabled', 'b'.repeat(64)],
      ['string', 'c'.repeat(64)],
      ['number', 'd'.repeat(64)],
      ['../x', 'e'.repeat(64)],
      ['Prosopon', 'f'.repeat(64)],
      ["a".repeat(65), '0'.repeat(64)]
    ])
    const enabled: Record<string, unknown> = {
      prosopon: true,
      unknown: true,
      disabled: false,
      string: 'true',
      number: 1,
      '../x': true,
      Prosopon: true,
      ["a".repeat(65)]: true
    }

    expect(enabledModsFromLock(enabled, lock)).toEqual(['prosopon'])
  })
})

test('uses UTF-8 bytes for an accented path length (mutation: use path code-unit length)', async () => {
  expect(modsFingerprint([{ path: 'hooks/é.ts', bytes: encode('x') }])).toBe(
    'd5e737fd87b3d511a55cade223b1daa3a031797a11f47d28ed6cd5a49f802489'
  )
})

describe('lock file', async () => {
  const lockFile = (plugins: unknown) => {
    const dir = scratch()
    writeFileSync(join(dir, 'choregos.lock.json'), JSON.stringify({ repo: 'r', commit: 'c', plugins }))
    return dir
  }
  const good = 'a'.repeat(64)

  test('reads the plugin names and fingerprints it holds', async () => {
    expect([...loadModsLock(lockFile({ p: { version: '1', fingerprint: good } })).entries()]).toEqual([['p', good]])
  })

  test.each([
    ['a path-shaped name', { '../x': { version: '1', fingerprint: good } }],
    ['an uppercase name', { P: { version: '1', fingerprint: good } }],
    ['a fingerprint outside the pattern', { p: { version: '1', fingerprint: 'F'.repeat(64) } }],
    ['a missing fingerprint', { p: { version: '1' } }],
    ['no plugins object', 'nope']
  ])('refuses a lock with %s', (_label, plugins) => {
    expect(() => loadModsLock(lockFile(plugins))).toThrow()
  })

  test('loads the lock shipped under desktop/mods and materializes its plugins from the real distributed copy', async () => {
    const distDir = join(import.meta.dir, '..', 'desktop', 'mods')
    const lock = loadModsLock(distDir)
    expect([...lock.keys()].length).toBeGreaterThan(0)
    const workRoot = join(scratch(), 'work')
    for (const plugin of lock.keys()) {
      const first = await ensureOk({ distDir, workRoot, plugin, lock })
      expect(await ensureOk({ distDir, workRoot, plugin, lock })).toMatchObject({ dir: first.dir, reused: true })
    }
  })
})
