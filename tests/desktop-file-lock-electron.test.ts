import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..')
const MODULE = join(REPO, 'desktop', 'src', 'main', 'file-lock.ts')
const ELECTRON_PACKAGE = join(REPO, 'desktop', 'node_modules', 'electron')

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('the Electron runtime of the Deck (node:sqlite) is excluded by a lock held from bun', async () => {
  const pointer = join(ELECTRON_PACKAGE, 'path.txt')
  expect(existsSync(pointer), `electron is not installed: ${pointer} is missing`).toBe(true)
  const electron = join(ELECTRON_PACKAGE, 'dist', readFileSync(pointer, 'utf-8').trim())
  const dir = mkdtempSync(join(tmpdir(), 'kory-file-lock-electron-'))
  dirs.push(dir)
  const built = await Bun.build({ entrypoints: [MODULE], outdir: dir, target: 'node', format: 'cjs', external: ['node:sqlite'] })
  expect(built.success).toBe(true)
  const probe = join(dir, 'electron-probe.cjs')
  writeFileSync(probe, [
    `const { withFileLock } = require(${JSON.stringify(join(dir, 'file-lock.js'))})`,
    'const file = process.argv[2]',
    'try {',
    "  const got = withFileLock(file, 'test', () => typeof process.getBuiltinModule('node:sqlite').DatabaseSync, { busyMs: 200 })",
    '  process.stdout.write(JSON.stringify({ ok: true, got }))',
    '} catch (e) {',
    '  process.stdout.write(JSON.stringify({ ok: false, message: e.message }))',
    '}'
  ].join('\n'))
  const file = join(dir, 'settings.json')
  const runProbe = () => {
    const r = Bun.spawnSync([electron, probe, file], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 15_000 })
    expect(r.exitCode, r.stderr.toString()).toBe(0)
    return JSON.parse(r.stdout.toString()) as { ok: boolean; got?: string; message?: string }
  }

  const holder = new Database(`${file}.lock.sqlite`)
  holder.run('BEGIN IMMEDIATE')
  try {
    const blocked = runProbe()
    expect(blocked.ok).toBe(false)
    expect(blocked.message).toMatch(/another process is writing/)
  } finally {
    holder.run('ROLLBACK')
    holder.close()
  }
  expect(runProbe()).toEqual({ ok: true, got: 'function' })
})
