import { expect, test } from 'bun:test'
import { registerSkillSequenceChannels, type SkillSequenceChannelsService } from '../desktop/src/main/skill-sequence-ipc'

function registered(service: SkillSequenceChannelsService): Map<string, (event: unknown, ...args: unknown[]) => unknown> {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  registerSkillSequenceChannels((channel, fn) => handlers.set(channel, fn), service)
  return handlers
}

function recorder() {
  const calls: Array<[string, ...unknown[]]> = []
  const service: SkillSequenceChannelsService = {
    runSkillSequence: (...args) => (calls.push(['run', ...args]), Promise.resolve({ status: 'started' })),
    cancelSequence: (id) => (calls.push(['cancel', id]), true),
    overrideQuiescence: (id) => (calls.push(['override', id]), false)
  }
  return { calls, service }
}

test('registers exactly the three Skills sequence channels', () => {
  expect([...registered(recorder().service).keys()].sort()).toEqual(['sessions:sequence-cancel', 'sessions:sequence-override', 'skills:run'])
})

// Mutants: the handler drops the mode; the handler passes undefined as the mode.
test('skills:run hands the service the tile, the moment and the mode exactly as received, and returns its reply', async () => {
  const { calls, service } = recorder()
  const run = registered(service).get('skills:run')!

  expect(await run({ sender: 'ipc-event' }, 'tile-1', 'stop', 'hard')).toEqual({ status: 'started' })
  await run({}, 'tile-1', 'start')
  await run({}, 42, { moment: 'x' }, 'sideways')
  expect(calls).toEqual([
    ['run', 'tile-1', 'stop', 'hard'],
    ['run', 'tile-1', 'start', undefined],
    ['run', 42, { moment: 'x' }, 'sideways']
  ])
})

// Mutants: cancel calling the override method, the override channel calling cancel.
test('cancel and override reach two distinct service methods with the tile and return their answer', () => {
  const { calls, service } = recorder()
  const handlers = registered(service)

  expect(handlers.get('sessions:sequence-cancel')!({}, 'tile-1')).toBe(true)
  expect(calls).toEqual([['cancel', 'tile-1']])
  expect(handlers.get('sessions:sequence-override')!({}, 'tile-2')).toBe(false)
  expect(calls).toEqual([['cancel', 'tile-1'], ['override', 'tile-2']])
})

test('a rejection of the service reaches the caller instead of being swallowed', async () => {
  const service: SkillSequenceChannelsService = {
    runSkillSequence: () => Promise.reject(new Error('refused by main')),
    cancelSequence: () => false,
    overrideQuiescence: () => false
  }

  await expect(registered(service).get('skills:run')!({}, 'tile-1', 'start') as Promise<unknown>).rejects.toThrow('refused by main')
})
