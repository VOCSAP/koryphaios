import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AvatarAppearance } from '../desktop/src/main/avatar-appearance.ts'
import { avatarTrayMayRebound } from '../desktop/src/main/avatar-tray-menu.ts'

const dirs: string[] = []

function appearanceFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kory-avatar-appearance-'))
  dirs.push(dir)
  return join(dir, 'avatar-appearance.json')
}

function validAppearance(): AvatarAppearance {
  return {
    version: 1,
    visible: true,
    alwaysOnTop: true,
    positionLocked: false,
    size: 'm',
    idleOpacity: 1,
    motion: 'continuous',
    dndUntil: 1_800_000_000_000,
    dndChoice: '1h',
    positions: {
      primary: { workArea: { x: 0, y: 0, width: 1920, height: 1080 }, x: 320, y: 240 }
    }
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('persists a complete valid appearance record', async () => {
  const appearance = await import('../desktop/src/main/avatar-appearance.ts')
  const file = appearanceFile()
  const expected = validAppearance()

  appearance.writeAvatarAppearance(file, expected)

  expect(appearance.readAvatarAppearance(file)).toEqual(expected)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(expected)
})

test('writes exactly the snapshot it is given, without reading the file or merging its content', async () => {
  const appearance = await import('../desktop/src/main/avatar-appearance.ts')
  const file = appearanceFile()
  const record = validAppearance()
  record.positions = { primary: record.positions.primary! }
  writeFileSync(file, JSON.stringify({ ...validAppearance(), visible: false, positions: { stale: { workArea: { x: 0, y: 0, width: 10, height: 10 }, x: 1, y: 1 } } }))
  const errors: string[] = []

  const returned = appearance.writeAvatarAppearance(file, record, { reportError: (_scope, message) => errors.push(message) })

  expect(returned).toBeUndefined()
  expect(errors).toEqual([])
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(record)
})

test('overwrites a corrupt file with the snapshot instead of resetting to defaults first', async () => {
  const appearance = await import('../desktop/src/main/avatar-appearance.ts')
  const file = appearanceFile()
  writeFileSync(file, '{ not json')
  const errors: string[] = []

  appearance.writeAvatarAppearance(file, { ...validAppearance(), visible: false }, { reportError: (_scope, message) => errors.push(message) })

  expect(errors).toEqual([])
  expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ visible: false, dndChoice: '1h' })
})

test('refuses an invalid snapshot and leaves the file untouched', async () => {
  const appearance = await import('../desktop/src/main/avatar-appearance.ts')
  const file = appearanceFile()
  appearance.writeAvatarAppearance(file, validAppearance())
  const before = readFileSync(file, 'utf8')

  expect(() => appearance.writeAvatarAppearance(file, { ...validAppearance(), idleOpacity: Number.NaN })).toThrow('Avatar appearance is invalid')
  expect(readFileSync(file, 'utf8')).toBe(before)
})

test('reports a write failure with its file and throws a stable error', async () => {
  const appearance = await import('../desktop/src/main/avatar-appearance.ts')
  const blocker = appearanceFile()
  writeFileSync(blocker, '{}')
  const file = join(blocker, 'nested', 'avatar-appearance.json')
  const errors: { message: string }[] = []

  expect(() => appearance.writeAvatarAppearance(file, validAppearance(), { reportError: (_scope, message) => errors.push({ message }) })).toThrow('Avatar appearance could not be written')
  expect(errors).toEqual([{ message: `cannot write ${file}` }])
})

test('rejects one malformed appearance field while preserving validation of every other field', async () => {
  const appearance = await import('../desktop/src/main/avatar-appearance.ts')
  const file = appearanceFile()
  const invalidFields = [
    ['version', 2],
    ['motion', 'loop-forever'],
    ['visible', 'yes'],
    ['alwaysOnTop', 'yes'],
    ['positionLocked', 'yes'],
    ['size', 'xl'],
    ['idleOpacity', 1.1],
    ['dndUntil', 'never'],
    ['dndChoice', 'later'],
    ['positions', []]
  ] as const

  for (const [field, value] of invalidFields) {
    writeFileSync(file, JSON.stringify({ ...validAppearance(), [field]: value }))
    const errors: { scope: string; message: string }[] = []
    expect(appearance.readAvatarAppearance(file, {
      reportError: (scope, message) => errors.push({ scope, message })
    })).toEqual({
      version: 1,
      visible: true,
      alwaysOnTop: true,
      positionLocked: false,
      size: 'm',
      idleOpacity: 1,
      motion: 'continuous',
      dndUntil: null,
      dndChoice: null,
      positions: {}
    })
    expect(errors).toEqual([{ scope: 'avatar-appearance', message: `appearance unreadable (${file})` }])
  }
})

test('rehydrates DND from its deadline before expiry and clears its effect after expiry', async () => {
  const appearance = await import('../desktop/src/main/avatar-appearance.ts')
  const file = appearanceFile()
  appearance.writeAvatarAppearance(file, validAppearance())

  const beforeExpiry = appearance.avatarAppearanceDnd(appearance.readAvatarAppearance(file))
  expect(beforeExpiry).toEqual({ choice: '1h', until: 1_800_000_000_000 })
  expect(avatarTrayMayRebound(beforeExpiry, 1_799_999_999_999)).toBe(false)
  const afterRestart = appearance.avatarAppearanceDnd(appearance.readAvatarAppearance(file))
  expect(avatarTrayMayRebound(afterRestart, 1_800_000_000_000)).toBe(true)
})

test('reports every discarded corrupt screen position by screen id', async () => {
  const appearance = await import('../desktop/src/main/avatar-appearance.ts')
  const file = appearanceFile()
  const record = validAppearance()
  record.positions = {
    primary: record.positions.primary!,
    lost: { workArea: { x: 0, y: 0, width: 0, height: 1080 }, x: 20, y: 20 }
  }
  writeFileSync(file, JSON.stringify(record))
  const errors: { scope: string; message: string }[] = []

  expect(appearance.readAvatarAppearance(file, {
    reportError: (scope, message) => errors.push({ scope, message })
  })).toMatchObject({ positions: { primary: record.positions.primary } })
  expect(errors).toEqual([{ scope: 'avatar-appearance', message: 'avatar position ignored for screen "lost"' }])
})
