import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { finishAvatarStartup, type AvatarStartupSteps } from '../desktop/src/main/avatar-startup.ts'
import type { AvatarEvent } from '../desktop/src/main/avatar-window-state.ts'

const SCREEN_EVENTS = ['display-added', 'display-removed', 'display-metrics-changed'] as const

function rig(fail: 'claim' | 'tray' | null = null) {
  const log: string[] = []
  const events: AvatarEvent[] = []
  const theme = new EventEmitter()
  const screen = new EventEmitter()
  const recordSubscription = (source: EventEmitter, name: string): void => {
    source.on('newListener', (event: string) => log.push(`${name}:${event}`))
  }
  recordSubscription(theme, 'theme')
  recordSubscription(screen, 'screen')
  const steps: AvatarStartupSteps = {
    claimRegistry: () => {
      log.push('claim')
      if (fail === 'claim') throw new Error('registry held elsewhere')
    },
    createTray: () => {
      log.push('tray')
      if (fail === 'tray') throw new Error('tray failed')
    },
    theme,
    themeChanged: () => log.push('themeChanged'),
    screen,
    geometryChanged: () => log.push('geometryChanged'),
    dispatch: (event) => {
      log.push(`dispatch:${event.kind}`)
      events.push(event)
    }
  }
  return { log, events, theme, screen, steps }
}

test('the window is restored only after the registry is held, the Tray exists, the followers are attached and geometry and theme are read again', () => {
  const r = rig()
  finishAvatarStartup(r.steps)

  expect(r.log).toEqual([
    'claim',
    'tray',
    'theme:updated',
    'screen:display-added',
    'screen:display-removed',
    'screen:display-metrics-changed',
    'geometryChanged',
    'themeChanged',
    'dispatch:RestoreRequested'
  ])
  expect(r.events, 'exactly one restore and never a Show that would overwrite a hidden choice').toEqual([{ kind: 'RestoreRequested' }])
})

test('each follower reaches its handler, and the returned stop detaches all of them', () => {
  const r = rig()
  const stop = finishAvatarStartup(r.steps)
  r.log.length = 0

  r.theme.emit('updated')
  for (const event of SCREEN_EVENTS) r.screen.emit(event, {}, {})
  expect(r.log).toEqual(['themeChanged', 'geometryChanged', 'geometryChanged', 'geometryChanged'])

  stop()
  expect(r.theme.listenerCount('updated'), 'theme listener left after stop').toBe(0)
  for (const event of SCREEN_EVENTS) expect(r.screen.listenerCount(event), `${event} listener left after stop`).toBe(0)
})

test('a failed claim or Tray leaves no follower attached and restores nothing', () => {
  for (const fail of ['claim', 'tray'] as const) {
    const r = rig(fail)
    expect(() => finishAvatarStartup(r.steps), fail).toThrow()
    expect(r.events, `${fail} failure must not restore a window`).toEqual([])
    expect(r.theme.listenerCount('updated'), `${fail} failure must not follow the theme`).toBe(0)
    for (const event of SCREEN_EVENTS) expect(r.screen.listenerCount(event), `${fail} failure must not follow ${event}`).toBe(0)
  }
})
