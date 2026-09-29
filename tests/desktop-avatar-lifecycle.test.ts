import { expect, test } from 'bun:test'
import { releaseAvatarResources } from '../desktop/src/main/avatar-quit.ts'

test('closes the server before releasing the registry and lifetime', async () => {
  const calls: string[] = []
  await releaseAvatarResources(
    { close: async () => { calls.push('server.close') } },
    { release: () => { calls.push('registry.release') } },
    { release: () => { calls.push('lifetime.release') } }
  )
  expect(calls).toEqual(['server.close', 'registry.release', 'lifetime.release'])
})
