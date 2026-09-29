import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAvatarClient,
  type AvatarClientOptions,
  type AvatarClientSocket
} from '../desktop/src/main/avatar-client.ts'
import { AVATAR_REGISTRY_VERSION, type AvatarRendezvous } from '../desktop/src/main/avatar-registry.ts'
import {
  AVATAR_SETTINGS_FILE,
  avatarAutoAttachEnabled,
  writeAvatarAutoAttach,
  writeProjectAvatarSettings
} from '../desktop/src/main/avatar-settings.ts'
import type { SessionRuntime } from '../desktop/src/shared/types.ts'

const deck = {
  deckRunId: 'deck-run-1',
  deckPid: 4242,
  broker_url: 'http://127.0.0.1:7899',
  projectDir: 'C:/work/example',
  deckName: 'Example'
}
const identity = { deckRunId: deck.deckRunId, broker_url: deck.broker_url }

function rendezvous(avatarRunId = 'avatar-run-1'): AvatarRendezvous {
  return { version: AVATAR_REGISTRY_VERSION, avatarRunId, pid: 1, port: 1, certPem: 'cert', token: 'token' }
}

function session(activity: SessionRuntime['activity']): SessionRuntime {
  return { status: 'running', activity, rateLimited: false, needsAttention: false } as SessionRuntime
}

class FakeClientSocket extends EventEmitter implements AvatarClientSocket {
  sent: Record<string, unknown>[] = []
  closed: { code?: number; reason?: string } | undefined

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return
    this.closed = { code, reason }
    this.emit('close', code)
  }

  open(): void {
    this.emit('open')
  }

  receive(frame: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)))
  }
}

function harness(overrides: Partial<AvatarClientOptions> = {}) {
  const posts: Array<{ path: string; body: unknown }> = []
  const sockets: FakeClientSocket[] = []
  const reports: string[] = []
  const infos: string[] = []
  const heartbeat: { ms?: number; tick?: () => void } = {}
  const deadlines: Array<{ ms: number; fire(): void; cancelled: boolean }> = []
  const live = {
    rendezvous: rendezvous(),
    sessions: [] as SessionRuntime[],
    focusCalls: 0,
    status: {} as Record<string, number>
  }
  const client = createAvatarClient({
    deck,
    autoAttachEnabled: () => true,
    rendezvous: () => live.rendezvous,
    sessions: () => live.sessions,
    focus: async () => {
      live.focusCalls += 1
    },
    post: async (_rendezvous, path, body) => {
      posts.push({ path, body })
      return live.status[path] ?? 200
    },
    connect: () => {
      const socket = new FakeClientSocket()
      sockets.push(socket)
      return socket
    },
    every: (ms, tick) => {
      heartbeat.ms = ms
      heartbeat.tick = tick
      return () => {
        heartbeat.tick = undefined
      }
    },
    after: (ms, fire) => {
      const deadline = { ms, fire, cancelled: false }
      deadlines.push(deadline)
      return () => {
        deadline.cancelled = true
      }
    },
    report: (_scope, message) => reports.push(message),
    info: (_scope, message) => infos.push(message),
    ...overrides
  })
  return { client, posts, sockets, reports, infos, heartbeat, deadlines, live }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const paths = (posts: Array<{ path: string }>): string[] => posts.map((post) => post.path)
const command = (overrides: Record<string, unknown> = {}) => ({
  type: 'command',
  requestId: 'request-1',
  command: 'focus',
  ...identity,
  ...overrides
})

async function boundHarness(overrides: Partial<AvatarClientOptions> = {}) {
  const context = harness(overrides)
  context.client.start()
  await flush()
  const socket = context.sockets[0]!
  socket.open()
  socket.receive({ type: 'bound' })
  return { ...context, socket }
}

test('auto-attaches only when the global setting is on and the project has not opted out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kory-avatar-client-'))
  const file = join(dir, AVATAR_SETTINGS_FILE)
  const attachedWith = async (): Promise<string[]> => {
    const { client, posts } = harness({ autoAttachEnabled: () => avatarAutoAttachEnabled(file, 'project-a') })
    client.start()
    await flush()
    await client.stop()
    return paths(posts)
  }
  try {
    expect(await attachedWith()).toEqual(['/attach', '/state', '/detach'])
    writeProjectAvatarSettings(file, 'project-a', { optOut: true })
    expect(await attachedWith()).toEqual([])
    writeProjectAvatarSettings(file, 'project-a', { optOut: false })
    writeAvatarAutoAttach(file, false)
    expect(await attachedWith()).toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('attaches, binds, pushes state on change and repeats it every five seconds', async () => {
  const { client, posts, sockets, heartbeat, live } = harness()
  expect(client.start()).toBe(true)
  await flush()
  expect(posts[0]).toEqual({ path: '/attach', body: { protocol_version: 1, ...deck } })
  expect(sockets).toHaveLength(1)
  sockets[0]!.open()
  expect(sockets[0]!.sent).toEqual([{ type: 'bind', protocol_version: 1, ...identity }])
  expect(heartbeat.ms).toBe(5_000)

  client.sessionsChanged()
  await flush()
  expect(paths(posts)).toEqual(['/attach', '/state'])

  live.sessions = [session('working'), session('idle'), session('idle')]
  client.sessionsChanged()
  await flush()
  expect(posts.at(-1)).toEqual({
    path: '/state',
    body: {
      identity,
      counters: { working: 1, idle: 2, unknown: 0, waiting: 0, exited: 0, rateLimited: 0 },
      unread: 0
    }
  })

  heartbeat.tick?.()
  await flush()
  expect(paths(posts)).toEqual(['/attach', '/state', '/state', '/state'])
  expect(posts[3]!.body).toEqual(posts[2]!.body)
  expect(sockets).toHaveLength(1)
  await client.stop()
})

test('focuses on a bound command and answers its result', async () => {
  const { client, socket, live } = await boundHarness()
  socket.receive(command())
  await flush()
  expect(live.focusCalls).toBe(1)
  expect(socket.sent.at(-1)).toEqual({ type: 'command_result', requestId: 'request-1', ok: true })
  await client.stop()
})

test('answers and traces a focus that fails', async () => {
  const { client, socket, reports } = await boundHarness({ focus: () => Promise.reject(new Error('window gone')) })
  socket.receive(command())
  await flush()
  expect(socket.sent.at(-1)).toEqual({ type: 'command_result', requestId: 'request-1', ok: false, error: 'focus_failed' })
  expect(reports).toEqual(['Avatar focus command failed'])
  await client.stop()
})

test('answers and traces a focus that throws synchronously', async () => {
  const { client, socket, reports } = await boundHarness({
    focus: () => {
      throw new Error('window handle missing')
    }
  })
  socket.receive(command())
  await flush()
  expect(socket.sent.at(-1)).toEqual({ type: 'command_result', requestId: 'request-1', ok: false, error: 'focus_failed' })
  expect(reports).toEqual(['Avatar focus command failed'])
  await client.stop()
})

test('answers focus_timeout once when focus outlasts its two-second bound', async () => {
  let finishFocus: () => void = () => undefined
  const { client, socket, reports, deadlines } = await boundHarness({
    focus: () =>
      new Promise<void>((resolve) => {
        finishFocus = resolve
      })
  })
  socket.receive(command())
  expect(deadlines.at(-1)!.ms).toBe(2_000)
  deadlines.at(-1)!.fire()
  finishFocus()
  await flush()
  expect(socket.sent.slice(1)).toEqual([{ type: 'command_result', requestId: 'request-1', ok: false, error: 'focus_timeout' }])
  expect(reports).toEqual(['Avatar focus command timed out after 2000 ms'])
  await client.stop()
})

test('refuses and traces a command before bound, outside AVATAR_COMMANDS, or for another Deck', async () => {
  const { client, sockets, reports, live } = harness()
  client.start()
  await flush()
  const socket = sockets[0]!
  socket.open()
  socket.receive(command())
  socket.receive({ type: 'bound' })
  socket.receive(command({ requestId: 'request-restart', command: 'restart' }))
  socket.receive(command({ requestId: '', command: 'restart' }))
  socket.receive(command({ requestId: 'request-2', deckRunId: 'deck-run-2' }))
  await flush()
  expect(live.focusCalls).toBe(0)
  expect(reports).toEqual([
    'rejected an Avatar command received before bound',
    'rejected an invalid Avatar frame',
    'rejected an invalid Avatar frame',
    'rejected an Avatar command addressed to another Deck'
  ])
  expect(socket.sent.slice(1)).toEqual([
    { type: 'command_result', requestId: 'request-restart', ok: false, error: 'unsupported_command' },
    { type: 'command_result', requestId: 'request-2', ok: false, error: 'wrong_deck' }
  ])
  await client.stop()
})

test('never replays an answer to a socket reopened after a disconnect', async () => {
  let finishFocus: () => void = () => undefined
  const { client, sockets, socket, heartbeat } = await boundHarness({
    focus: () =>
      new Promise<void>((resolve) => {
        finishFocus = resolve
      })
  })
  socket.receive(command())
  socket.close(1006, 'lost')
  heartbeat.tick?.()
  await flush()
  const reopened = sockets[1]!
  reopened.open()
  reopened.receive({ type: 'bound' })
  finishFocus()
  await flush()
  expect(socket.sent).toEqual([{ type: 'bind', protocol_version: 1, ...identity }])
  expect(reopened.sent).toEqual([{ type: 'bind', protocol_version: 1, ...identity }])
  await client.stop()
})

test('re-attaches and replaces its socket when the Avatar restarts under a new run', async () => {
  const { client, posts, sockets, socket, heartbeat, live } = await boundHarness()
  live.rendezvous = rendezvous('avatar-run-2')
  heartbeat.tick?.()
  await flush()
  expect(paths(posts)).toEqual(['/attach', '/state', '/attach', '/state'])
  expect(socket.closed).toEqual({ code: 1000, reason: 'Avatar restarted' })
  expect(sockets).toHaveLength(2)
  await client.stop()
})

test('reports a failing Avatar link once per episode, not on every heartbeat', async () => {
  const { client, reports, infos, heartbeat, live } = harness()
  live.status['/attach'] = 409
  client.start()
  await flush()
  heartbeat.tick?.()
  await flush()
  heartbeat.tick?.()
  await flush()
  expect(reports).toEqual(['Avatar refused the attach with status 409'])

  live.status['/attach'] = 200
  heartbeat.tick?.()
  await flush()
  expect(infos).toEqual(['Avatar link restored'])

  live.status['/state'] = 500
  heartbeat.tick?.()
  await flush()
  heartbeat.tick?.()
  await flush()
  expect(reports).toEqual(['Avatar refused the attach with status 409', 'Avatar refused the state with status 500'])
  await client.stop()
})

test('reports a failing WebSocket once per episode even while the HTTP link keeps working', async () => {
  const { client, sockets, reports, infos, heartbeat } = harness()
  client.start()
  await flush()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    sockets.at(-1)!.emit('error', new Error('upgrade refused'))
    sockets.at(-1)!.close(1006, 'lost')
    heartbeat.tick?.()
    await flush()
  }
  expect(sockets).toHaveLength(4)
  expect(reports).toEqual(['Avatar WebSocket error'])

  sockets.at(-1)!.open()
  sockets.at(-1)!.receive({ type: 'bound' })
  expect(infos).toEqual(['Avatar WebSocket restored'])
  sockets.at(-1)!.emit('error', new Error('reset'))
  expect(reports).toEqual(['Avatar WebSocket error', 'Avatar WebSocket error'])
  await client.stop()
})

test('reports a new failure cause even while an episode is already open', async () => {
  let networkDown = true
  const { client, reports, heartbeat, live } = harness({
    post: async (_rendezvous, path) => {
      if (networkDown) throw new Error('connect ECONNREFUSED')
      return live.status[path] ?? 200
    }
  })
  live.status['/attach'] = 409
  client.start()
  await flush()
  networkDown = false
  for (let tick = 0; tick < 3; tick += 1) {
    heartbeat.tick?.()
    await flush()
  }
  expect(reports).toEqual(['Avatar link failed', 'Avatar refused the attach with status 409'])
  await client.stop()
})

test('reports once a socket the Avatar closes before bound with an application code', async () => {
  const { client, sockets, reports, heartbeat } = harness()
  client.start()
  await flush()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    sockets.at(-1)!.close(4403, 'Deck not attached')
    heartbeat.tick?.()
    await flush()
  }
  expect(sockets).toHaveLength(4)
  expect(reports).toEqual(['Avatar closed the WebSocket before bound with code 4403'])
  await client.stop()
})

test('does not report an application close code once the socket was bound', async () => {
  const { client, socket, reports } = await boundHarness()
  socket.close(4410, 'superseded')
  expect(reports).toEqual([])
  await client.stop()
})

test('traces a refused attach and opens no socket', async () => {
  const { client, sockets, reports } = harness({ post: async () => 409 })
  client.start()
  await flush()
  expect(sockets).toHaveLength(0)
  expect(reports).toEqual(['Avatar refused the attach with status 409'])
  await client.stop()
})

test('stop issued before the first sync runs attaches nothing and opens no socket', async () => {
  const { client, posts, sockets } = harness()
  client.start()
  await client.stop()
  expect(posts).toEqual([])
  expect(sockets).toHaveLength(0)
})

test('stop closes the socket, detaches once, and ignores later session changes', async () => {
  const { client, posts, socket, heartbeat } = await boundHarness()
  await client.stop()
  client.sessionsChanged()
  await flush()
  expect(socket.closed).toEqual({ code: 1000, reason: 'Deck detaching' })
  expect(heartbeat.tick).toBeUndefined()
  expect(posts.at(-1)).toEqual({ path: '/detach', body: identity })
  expect(paths(posts).filter((path) => path === '/detach')).toHaveLength(1)
})
