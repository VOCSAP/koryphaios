import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type LockConnection, openLockDatabase, withFileLock } from '../desktop/src/main/file-lock.ts'

const MODULE = join(import.meta.dir, '..', 'desktop', 'src', 'main', 'file-lock.ts')

const dirs: string[] = []
const children: Array<{ kill(signal?: number | NodeJS.Signals): void; exited: Promise<number> }> = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL')
    await child.exited
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kory-file-lock-'))
  dirs.push(dir)
  return dir
}

/**
 * A writer process running the real withFileLock. `hold` takes the lock and
 * never gives it back; `rmw` adds its own key to the JSON file inside the lock,
 * with a critical-section marker created O_EXCL so that two writers inside at
 * once is observed rather than inferred.
 */
function writeChildScript(dir: string): string {
  const script = join(dir, 'lock-child.ts')
  writeFileSync(script, [
    "import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    `import { withFileLock } from ${JSON.stringify(MODULE)}`,
    'const [mode, file, dir, id] = process.argv.slice(2)',
    'const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)',
    "if (mode === 'hold') {",
    "  withFileLock(file, 'test', () => { writeFileSync(join(dir, 'held'), ''); sleep(60_000) }, { busyMs: 0 })",
    '} else {',
    "  writeFileSync(join(dir, `waiting-${id}`), '')",
    '  let overlap = false',
    "  const marker = join(dir, 'in-critical-section')",
    '  withFileLock(file, \'test\', () => {',
    "    try { writeFileSync(marker, id, { flag: 'wx' }) } catch { overlap = true }",
    "    const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}",
    '    sleep(300)',
    '    writeFileSync(file, JSON.stringify({ ...current, [id]: true }))',
    '    if (!overlap) rmSync(marker)',
    '  }, { busyMs: 8_000 })',
    '  process.stdout.write(JSON.stringify({ id, overlap }))',
    '}'
  ].join('\n'))
  return script
}

function spawnChild(script: string, args: string[]) {
  const child = Bun.spawn([process.execPath, script, ...args], { stdout: 'pipe', stderr: 'pipe' })
  children.push(child)
  return child
}

async function waitForFiles(files: string[], what: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!files.every((f) => existsSync(f))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(10)
  }
}

async function outputOf(child: ReturnType<typeof spawnChild>): Promise<{ code: number; out: string; err: string }> {
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ])
  return { code, out, err }
}

test('two writers queued behind a holder that dies mid-section run one at a time and keep both keys', async () => {
  const dir = freshDir()
  const file = join(dir, 'settings.json')
  const script = writeChildScript(dir)
  const holder = spawnChild(script, ['hold', file, dir, 'H'])
  await waitForFiles([join(dir, 'held')], 'the holder to enter its critical section')

  const a = spawnChild(script, ['rmw', file, dir, 'A'])
  const b = spawnChild(script, ['rmw', file, dir, 'B'])
  await waitForFiles([join(dir, 'waiting-A'), join(dir, 'waiting-B')], 'both writers to queue')
  await Bun.sleep(200)
  expect(
    [a.exitCode, b.exitCode],
    'both writers must still be waiting on the lock when its holder dies, or the kill proves nothing'
  ).toEqual([null, null])
  expect(existsSync(join(dir, 'in-critical-section')), 'no writer may be inside while the holder lives').toBe(false)
  const killedAt = Date.now()
  holder.kill('SIGKILL')
  await holder.exited

  const results = await Promise.all([outputOf(a), outputOf(b)])
  const elapsed = Date.now() - killedAt
  for (const r of results) expect(r.code, r.err).toBe(0)
  expect(results.map((r) => JSON.parse(r.out)).sort((x, y) => x.id.localeCompare(y.id))).toEqual([
    { id: 'A', overlap: false },
    { id: 'B', overlap: false }
  ])
  expect(JSON.parse(readFileSync(file, 'utf8')), 'a write lost to the other writer means the lock let both in').toEqual({
    A: true,
    B: true
  })
  expect(elapsed, 'the dead holder must not wedge the file past the writers own wait').toBeLessThan(8_000)
})

test('a writer that cannot get the lock in time throws without running its update', async () => {
  const dir = freshDir()
  const file = join(dir, 'settings.json')
  const holder = spawnChild(writeChildScript(dir), ['hold', file, dir, 'H'])
  await waitForFiles([join(dir, 'held')], 'the holder to enter its critical section')

  let ran = false
  const startedAt = Date.now()
  expect(() => withFileLock(file, 'test', () => { ran = true }, { busyMs: 200 })).toThrow(
    /another process is writing .*settings\.json; retry/
  )
  expect(Date.now() - startedAt).toBeLessThan(2_000)
  expect(ran).toBe(false)
  holder.kill('SIGKILL')
  await holder.exited
  expect(withFileLock(file, 'test', () => 'after')).toBe('after')
})

test('a lock file that is not a SQLite database is named for the operator and never deleted', () => {
  const dir = freshDir()
  const file = join(dir, 'settings.json')
  const lockPath = `${file}.lock.sqlite`
  const garbage = 'not a lock database, '.repeat(40)
  writeFileSync(lockPath, garbage)

  let ran = false
  let message = ''
  try {
    withFileLock(file, 'test', () => { ran = true })
  } catch (e) {
    message = e instanceof Error ? e.message : String(e)
  }
  expect(message).toBe(`${lockPath} is not a lock database; delete that file by hand, then retry`)
  expect(ran).toBe(false)
  expect(readFileSync(lockPath, 'utf8')).toBe(garbage)
})

/** The real opener, counting how many of the connections it handed out were closed. */
function countingOpener(): { open: (path: string) => LockConnection; opened: () => number; closed: () => number } {
  let opened = 0
  let closed = 0
  return {
    open: (path) => {
      const db = openLockDatabase(path)
      opened += 1
      return {
        exec: (sql) => db.exec(sql),
        close: () => {
          closed += 1
          db.close()
        }
      }
    },
    opened: () => opened,
    closed: () => closed
  }
}

test('a refused lock closes the connection it opened, busy or not a database', async () => {
  const dir = freshDir()
  const busyFile = join(dir, 'busy.json')
  spawnChild(writeChildScript(dir), ['hold', busyFile, dir, 'H'])
  await waitForFiles([join(dir, 'held')], 'the holder to enter its critical section')
  const busy = countingOpener()
  expect(() => withFileLock(busyFile, 'test', () => 'never', { busyMs: 100, open: busy.open })).toThrow(
    /another process is writing/
  )
  expect([busy.opened(), busy.closed()], 'a busy refusal must not leave its connection open').toEqual([1, 1])

  const garbageFile = join(dir, 'garbage.json')
  writeFileSync(`${garbageFile}.lock.sqlite`, 'not a lock database, '.repeat(40))
  const garbage = countingOpener()
  expect(() => withFileLock(garbageFile, 'test', () => 'never', { open: garbage.open })).toThrow(/not a lock database/)
  expect([garbage.opened(), garbage.closed()], 'a not-a-database refusal must not leave its connection open').toEqual([1, 1])
})

test('a nested lock of the same file throws at once, however its directory is spelled', () => {
  const dir = freshDir()
  const real = join(dir, 'real')
  mkdirSync(real)
  const link = join(dir, 'link')
  symlinkSync(real, link, 'junction')
  const spellings = [join(link, 'settings.json'), join(real, '.', 'settings.json')]
  if (process.platform === 'win32') spellings.push(join(real.toUpperCase(), 'settings.json'))

  for (const other of spellings) {
    let nestedMs = -1
    const outer = withFileLock(join(real, 'settings.json'), 'test', () => {
      const startedAt = Date.now()
      expect(() => withFileLock(other, 'test', () => 'inner'), `nested through ${other}`).toThrow(
        /already being written by this process/
      )
      nestedMs = Date.now() - startedAt
      return 'outer'
    })
    expect(outer).toBe('outer')
    expect(nestedMs, `nested through ${other} must not wait out its own holder`).toBeLessThan(500)
  }
  expect(withFileLock(join(link, 'settings.json'), 'test', () => 'again')).toBe('again')
})

test('an update that throws releases the lock for the next writer', () => {
  const dir = freshDir()
  const file = join(dir, 'settings.json')
  expect(() => withFileLock(file, 'test', () => { throw new Error('refused') })).toThrow('refused')
  expect(withFileLock(file, 'test', () => 'next', { busyMs: 0 })).toBe('next')
})

