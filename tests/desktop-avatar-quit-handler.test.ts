import { expect, test } from 'bun:test'
import { createAvatarQuitHandler } from '../desktop/src/main/avatar-quit-handler.ts'

function pendingRelease(): { release: () => Promise<void>; settle: () => void } {
  let settle = (): void => {}
  const pending = new Promise<void>((resolve) => {
    settle = resolve
  })
  return { release: () => pending, settle }
}

test('cancels every reentrant quit until Avatar release has settled', async () => {
  const { release, settle } = pendingRelease()
  const prevented: string[] = []
  const effects: string[] = []
  let quit = 0
  let resolveQuit = (): void => {}
  const quitted = new Promise<void>((resolve) => {
    resolveQuit = resolve
  })
  const handler = createAvatarQuitHandler({
    disposeTray: () => effects.push('tray'),
    release,
    quit: () => {
      quit += 1
      resolveQuit()
    },
    report: () => {}
  })

  handler({ preventDefault: () => prevented.push('first') })
  handler({ preventDefault: () => prevented.push('second') })
  expect(prevented).toEqual(['first', 'second'])
  expect(effects).toEqual(['tray'])
  expect(quit).toBe(0)

  settle()
  await quitted
  expect(quit).toBe(1)

  handler({ preventDefault: () => prevented.push('final') })
  expect(prevented).toEqual(['first', 'second'])
  expect(effects).toEqual(['tray'])
})

test('reports tray disposal and release failures separately before the final quit', async () => {
  const trayError = new Error('tray failed')
  const releaseError = new Error('release failed')
  const errors: { message: string; error?: unknown }[] = []
  let resolveQuit = (): void => {}
  let resolveReports = (): void => {}
  const quitted = new Promise<void>((resolve) => {
    resolveQuit = resolve
  })
  const reported = new Promise<void>((resolve) => {
    resolveReports = resolve
  })
  const handler = createAvatarQuitHandler({
    disposeTray: () => { throw trayError },
    release: () => Promise.reject(releaseError),
    quit: resolveQuit,
    report: (_scope, message, error) => {
      errors.push({ message, error })
      if (errors.length === 2) resolveReports()
    }
  })

  handler({ preventDefault: () => {} })
  await Promise.all([quitted, reported])

  expect(errors.map((entry) => entry.error)).toEqual([trayError, releaseError])
  expect(errors.map((entry) => entry.message)).toEqual([
    'quit effect failed: Avatar Tray',
    'quit release failed'
  ])
})
