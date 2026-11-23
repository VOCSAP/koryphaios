import { expect, test } from 'bun:test'
import { skillSequenceBridge } from '../desktop/src/preload/skill-sequence-bridge'
import { COMPANION_MANIFEST } from '../desktop/src/shared/companion'

function fakeIpc() {
  const calls: unknown[][] = []
  return { calls, ipc: { invoke: (channel: string, ...args: unknown[]) => (calls.push([channel, ...args]), Promise.resolve(`reply:${channel}`)) } }
}

// Mutants: the run channel misspelled; the mode dropped.
test('runSessionSkill invokes skills:run with the tile, the moment and the mode, and returns the reply', async () => {
  const { calls, ipc } = fakeIpc()
  const bridge = skillSequenceBridge(ipc)

  expect(await bridge.runSessionSkill('t', 'stop', 'hard')).toBe('reply:skills:run' as never)
  await bridge.runSessionSkill('t', 'start')
  expect(calls).toEqual([
    ['skills:run', 't', 'stop', 'hard'],
    ['skills:run', 't', 'start', undefined]
  ])
})

// Mutant: the cancel and override channels swapped.
test('cancel and override invoke their own channel with the tile only', async () => {
  const { calls, ipc } = fakeIpc()
  const bridge = skillSequenceBridge(ipc)

  await bridge.cancelSessionSequence('t')
  await bridge.overrideSessionQuiescence('u')
  expect(calls).toEqual([
    ['sessions:sequence-cancel', 't'],
    ['sessions:sequence-override', 'u']
  ])
})

test('each bridged method invokes the channel the companion manifest declares for it', async () => {
  const { calls, ipc } = fakeIpc()
  const bridge = skillSequenceBridge(ipc)

  await bridge.runSessionSkill('t', 'start')
  await bridge.cancelSessionSequence('t')
  await bridge.overrideSessionQuiescence('t')
  expect(calls.map((call) => call[0])).toEqual([
    COMPANION_MANIFEST.runSessionSkill.channel,
    COMPANION_MANIFEST.cancelSessionSequence.channel,
    COMPANION_MANIFEST.overrideSessionQuiescence.channel
  ])
})
