// CWE-427: a cloned repository must not be able to plant an executable that the
// Deck or the avatar runs by bare name. Runs the real entry.ts under the repo's
// Electron in a trap directory holding a copy of bun named kory-trap-probe.exe.
import { test, expect } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = join(import.meta.dir, '..')
const PLANTED = Bun.version

function setup(): { dir: string; trap: string; entry: string; stub: string; electron: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kory-cwd-exe-'))
  const trap = join(dir, 'trap')
  mkdirSync(trap)
  copyFileSync(process.execPath, join(trap, 'kory-trap-probe.exe'))
  writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}')
  const stub = readFileSync(join(import.meta.dir, 'fixtures', 'cwd-exe-search-main.cjs'), 'utf8')
  writeFileSync(join(dir, 'index'), stub)
  writeFileSync(join(dir, 'avatar-entry'), stub)
  writeFileSync(join(dir, 'stub.cjs'), stub)
  const source = readFileSync(join(repo, 'desktop', 'src', 'main', 'entry.ts'), 'utf8')
  writeFileSync(join(dir, 'entry.cjs'), new Bun.Transpiler({ loader: 'ts' }).transformSync(source))
  const electron = createRequire(import.meta.url)(join(repo, 'desktop', 'node_modules', 'electron')) as string
  return { dir, trap, entry: join(dir, 'entry.cjs'), stub: join(dir, 'stub.cjs'), electron }
}

// The freshly executed copy stays locked for a moment after its process exits.
async function removeWithRetry(dir: string): Promise<unknown> {
  let last: unknown
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return null
    } catch (error) {
      last = error
      await Bun.sleep(100)
    }
  }
  return last
}

async function run(electron: string, script: string, trap: string, extra: string[] = []): Promise<unknown> {
  const env: Record<string, string | undefined> = { ...process.env, ELECTRON_RUN_AS_NODE: '1', KORY_TRAP_DIR: trap }
  delete env.NoDefaultCurrentDirectoryInExePath
  const child = Bun.spawn([electron, script, ...extra], { env, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ])
  expect(code, `electron exited ${code}: ${stderr}`).toBe(0)
  return JSON.parse(stdout)
}

test.skipIf(process.platform !== 'win32')(
  'entry.ts stops the Deck and the avatar from running an executable planted in the working directory',
  async () => {
    const { dir, trap, entry, stub, electron } = setup()
    let failed = false
    try {
      expect(
        await run(electron, stub, trap),
        'control: without entry.ts the planted binary must run, or this test proves nothing'
      ).toEqual({ execFile: PLANTED, cmdShell: PLANTED })
      for (const extra of [[], ['--avatar']]) {
        expect(await run(electron, entry, trap, extra), `entry.ts ${extra.join(' ') || '(Deck)'}`).toEqual({
          execFile: 'refused:ENOENT',
          cmdShell: 'refused:1'
        })
      }
    } catch (error) {
      failed = true
      throw error
    } finally {
      const leftover = await removeWithRetry(dir)
      if (leftover && !failed) throw leftover
      if (leftover) console.error(`cleanup of ${dir} failed after the test had already failed`, leftover)
    }
  },
  60_000
)
