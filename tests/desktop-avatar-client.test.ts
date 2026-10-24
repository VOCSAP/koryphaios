import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import {
  createAvatarClient,
  postAvatarJson,
  type AvatarClientOptions,
  type AvatarClientSocket,
  type AvatarPost,
  type AvatarPostResult
} from '../desktop/src/main/avatar-client.ts'
import { generateAvatarRunCertificate } from '../desktop/src/main/avatar-certificate.ts'
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

async function responseServer(body: string): Promise<{ server: Server; rendezvous: AvatarRendezvous }> {
  const certificate = await generateAvatarRunCertificate()
  const server = createServer({ cert: certificate.certPem, key: certificate.keyPem }, (_request, response) => response.end(body))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    server,
    rendezvous: {
      version: AVATAR_REGISTRY_VERSION,
      avatarRunId: 'avatar-response-test',
      pid: 1,
      port: address.port,
      certPem: certificate.certPem,
      token: rendezvous().token
    }
  }
}

async function closeResponseServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
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
  const warnings: string[] = []
  const heartbeat: { ms?: number; tick?: () => void } = {}
  const deadlines: Array<{ ms: number; fire(): void; cancelled: boolean }> = []
  const live = {
    rendezvous: rendezvous(),
    sessions: [] as SessionRuntime[],
    focusCalls: 0,
    openQuestionCalls: 0,
    post: undefined as AvatarPost | undefined,
    status: {} as Record<string, AvatarPostResult>,
    deck: { ...deck }
  }
  const client = createAvatarClient({
    deck: () => live.deck,
    autoAttachEnabled: () => true,
    rendezvous: () => live.rendezvous,
    sessions: () => live.sessions,
    focus: async () => {
      live.focusCalls += 1
    },
    openQuestion: async () => {
      live.openQuestionCalls += 1
    },
    post: async (rendezvous, path, body) => {
      posts.push({ path, body })
      return live.post ? live.post(rendezvous, path, body) : (live.status[path] ?? 200)
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
    warn: (_scope, message) => warnings.push(message),
    ...overrides
  })
  return { client, posts, sockets, reports, infos, warnings, heartbeat, deadlines, live }
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

test('keeps a non-JSON Avatar response body as null', async () => {
  const { server, rendezvous } = await responseServer('not JSON')
  try {
    expect(await postAvatarJson(rendezvous, '/attach', {})).toEqual({ status: 200, body: null })
  } finally {
    await closeResponseServer(server)
  }
})

test('rejects an oversized Avatar response body', async () => {
  const { server, rendezvous } = await responseServer(JSON.stringify({ payload: 'x'.repeat(64 * 1024) }))
  try {
    await expect(postAvatarJson(rendezvous, '/attach', {})).rejects.toThrow(/payload_too_large/)
  } finally {
    await closeResponseServer(server)
  }
})

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

test('logs successful and abandoned Avatar detach attempts', async () => {
  const successful = harness()
  successful.client.start()
  await flush()
  await successful.client.stop()
  expect(successful.infos).toContain('Avatar detached')

  const abandoned = harness()
  abandoned.client.start()
  await flush()
  abandoned.live.rendezvous = rendezvous('avatar-run-2')
  await abandoned.client.stop()
  expect(abandoned.warnings).toContain('Avatar detach abandoned because its run changed')
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

test('sends A3 context only after the Avatar announces the same capability', async () => {
  const context = { group_id: 'group-1', project_key: 'project-1', scope_generation: 1 }
  const { client, posts, live } = harness()
  live.deck = { ...deck, context }
  live.status['/attach'] = { status: 200, body: { capabilities: ['a3_context'] } }
  client.start()
  await flush()
  expect(posts).toEqual([
    { path: '/attach', body: { protocol_version: 1, ...deck, capabilities: ['a3_context'] } },
    { path: '/attach', body: { protocol_version: 1, ...deck, capabilities: ['a3_context'], context } },
    expect.objectContaining({ path: '/state', body: expect.objectContaining({ identity }) })
  ])
  await client.stop()
})

test('keeps A1/A2 behavior with an older Avatar that does not announce A3', async () => {
  const context = { group_id: 'group-1', project_key: 'project-1', scope_generation: 1 }
  const { client, posts, live } = harness()
  live.deck = { ...deck, context }
  client.start()
  await flush()
  expect(posts).toEqual([
    { path: '/attach', body: { protocol_version: 1, ...deck, capabilities: ['a3_context'] } },
    expect.objectContaining({ path: '/state', body: expect.objectContaining({ identity }) })
  ])
  await client.stop()
})

test('pushes the pending Courrier requests and the unread inbox it is given, neutral when not given', async () => {
  const rows = [{ reply_route: 'channel', status: 'pending', origin: { tile_ref: '' } }]
  const { client, posts } = harness({ pendingApprovals: () => rows, inboxUnread: () => 3 })
  client.start()
  await flush()
  expect(posts.at(-1)).toEqual({
    path: '/state',
    body: { identity, counters: { working: 0, idle: 0, unknown: 0, waiting: 1, exited: 0, rateLimited: 0 }, unread: 3 }
  })
  await client.stop()
})

test('an invalid unread count is traced once per episode and the bounded state is still pushed', async () => {
  let unread = Number.NaN
  const { client, posts, reports, infos, heartbeat } = harness({ inboxUnread: () => unread })
  client.start()
  await flush()
  heartbeat.tick?.()
  await flush()
  expect(reports.filter((message) => message.includes('Invalid inbox unread count'))).toHaveLength(1)
  expect(posts.filter((post) => post.path === '/state').every((post) => (post.body as { unread: number }).unread === 0)).toBe(true)
  unread = 2
  heartbeat.tick?.()
  await flush()
  expect(infos).toContain('Inbox unread count valid again')
  expect((posts.at(-1)!.body as { unread: number }).unread).toBe(2)
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

test('an open_question command opens the question, not a plain focus', async () => {
  const { client, socket, live } = await boundHarness()
  socket.receive(command({ command: 'open_question' }))
  await flush()
  expect(live.openQuestionCalls).toBe(1)
  expect(live.focusCalls).toBe(0)
  expect(socket.sent.at(-1)).toEqual({ type: 'command_result', requestId: 'request-1', ok: true })
  await client.stop()
})

test('answers and traces an open_question that fails, naming the command', async () => {
  const { client, socket, reports, live } = await boundHarness({ openQuestion: () => Promise.reject(new Error('window gone')) })
  socket.receive(command({ command: 'open_question' }))
  await flush()
  expect(socket.sent.at(-1)).toEqual({ type: 'command_result', requestId: 'request-1', ok: false, error: 'open_question_failed' })
  expect(reports).toEqual(['Avatar open_question command failed'])
  expect(live.focusCalls).toBe(0)
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

test('renews its attachment when the Deck scope generation changes', async () => {
  const { client, posts, live } = harness()
  client.start()
  await flush()
  ;(live.deck as typeof deck & { context: { group_id: string; project_key: string; scope_generation: number } }).context = {
    group_id: 'group-2',
    project_key: 'project-1',
    scope_generation: 2
  }
  client.sessionsChanged()
  await flush()
  expect(paths(posts)).toEqual(['/attach', '/state', '/attach', '/state'])
  await client.stop()
})

test('ignores an attachment response from a scope generation it has left', async () => {
  let releaseAttach: (result: AvatarPostResult) => void = () => undefined
  let attachCount = 0
  const { client, posts, live } = harness()
  live.post = async (_rendezvous, path) => {
    if (path !== '/attach' || attachCount++ > 0) return 200
    return new Promise<AvatarPostResult>((resolve) => {
      releaseAttach = resolve
    })
  }
  client.start()
  await flush()
  live.deck = {
    ...deck,
    context: { group_id: 'group-2', project_key: 'project-1', scope_generation: 2 }
  }
  client.scopeChanged()
  releaseAttach(200)
  await flush()
  await flush()
  expect(paths(posts)).toEqual(['/attach', '/attach', '/state'])
  await client.stop()
})

test('detaches each replaced broker attachment before attaching its successor', async () => {
  const attached = new Set<string>()
  const events: Array<{ path: string; broker: string }> = []
  const secondBroker = 'http://127.0.0.1:7900'
  const thirdBroker = 'http://127.0.0.1:7901'
  const { client, live } = harness({
    post: async (_rendezvous, path, body) => {
      const broker = (body as { broker_url: string }).broker_url
      events.push({ path, broker })
      if (path === '/attach') attached.add(broker)
      if (path === '/detach') attached.delete(broker)
      return 200
    }
  })

  client.start()
  await flush()
  live.deck = { ...deck, broker_url: secondBroker }
  client.scopeChanged()
  await flush()
  live.deck = { ...deck, broker_url: thirdBroker }
  client.scopeChanged()
  await flush()

  expect(events.map((event) => event.path)).toEqual(['/attach', '/state', '/detach', '/attach', '/state', '/detach', '/attach', '/state'])
  expect(attached).toEqual(new Set([thirdBroker]))
  expect(events.filter((event) => event.path === '/detach').map((event) => event.broker)).toEqual([deck.broker_url, secondBroker])
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

test('a renamed Deck re-attaches once under the same identity, keeping its socket', async () => {
  const { client, posts, sockets, heartbeat, live } = await boundHarness()
  live.deck = { ...deck, deckName: 'Renamed workspace' }
  heartbeat.tick?.()
  await flush()
  heartbeat.tick?.()
  await flush()
  const attaches = posts.filter((post) => post.path === '/attach')
  expect(attaches).toEqual([
    { path: '/attach', body: { protocol_version: 1, ...deck } },
    { path: '/attach', body: { protocol_version: 1, ...deck, deckName: 'Renamed workspace' } }
  ])
  expect(sockets).toHaveLength(1)
  expect(sockets[0]!.closed).toBeUndefined()
  await client.stop()
})

test('renews the identity and socket when the broker provider changes', async () => {
  const { client, posts, sockets, heartbeat, live } = await boundHarness()
  const nextIdentity = { deckRunId: 'deck-run-other', broker_url: 'http://127.0.0.1:7900' }
  live.deck = { ...deck, ...nextIdentity, deckName: 'Renamed' }
  heartbeat.tick?.()
  await flush()
  expect(posts.slice(-3)).toEqual([
    { path: '/detach', body: identity },
    { path: '/attach', body: { protocol_version: 1, ...live.deck } },
    expect.objectContaining({ path: '/state', body: expect.objectContaining({ identity: nextIdentity }) })
  ])
  expect(sockets[0]!.closed).toEqual({ code: 1000, reason: 'Deck scope changed' })
  expect(sockets).toHaveLength(2)
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

test.each([
  ['scope generation', { scope_generation: 2 }],
  ['group', { group_id: 'group-2' }],
  ['project key', { project_key: 'project-2' }]
])('renews its attachment when only the %s of the Deck context changes', async (_field, change) => {
  const context = { group_id: 'group-1', project_key: 'project-1', scope_generation: 1 }
  const { client, posts, live } = harness()
  live.deck = { ...deck, context }
  client.start()
  await flush()
  live.deck = { ...deck, context: { ...context, ...change } }
  client.sessionsChanged()
  await flush()
  expect(paths(posts)).toEqual(['/attach', '/state', '/attach', '/state'])
  await client.stop()
})

test('closes the bound socket and opens a new one when the Deck scope changes', async () => {
  const { client, sockets, socket } = await boundHarness()
  client.scopeChanged()
  await flush()
  expect(socket.closed).toEqual({ code: 1000, reason: 'Deck scope changed' })
  expect(sockets).toHaveLength(2)
  await client.stop()
})

test('ignores a state response from a scope generation it has left', async () => {
  let releaseState: (result: AvatarPostResult) => void = () => undefined
  let stateCount = 0
  const { client, reports, live } = harness()
  live.post = async (_rendezvous, path) => {
    if (path !== '/state' || stateCount++ > 0) return 200
    return new Promise<AvatarPostResult>((resolve) => {
      releaseState = resolve
    })
  }
  client.start()
  await flush()
  client.scopeChanged()
  releaseState(409)
  await flush()
  await flush()
  expect(reports).toEqual([])
  await client.stop()
})

test('ignores a context attachment response from a scope generation it has left', async () => {
  const context = { group_id: 'group-1', project_key: 'project-1', scope_generation: 1 }
  let releaseContext: (result: AvatarPostResult) => void = () => undefined
  let attachCount = 0
  const { client, reports, live } = harness()
  live.deck = { ...deck, context }
  live.post = async (_rendezvous, path, body) => {
    if (path !== '/attach') return 200
    attachCount += 1
    if (attachCount === 2) {
      return new Promise<AvatarPostResult>((resolve) => {
        releaseContext = resolve
      })
    }
    return (body as { context?: unknown }).context ? 200 : { status: 200, body: { capabilities: ['a3_context'] } }
  }
  client.start()
  await flush()
  live.deck = { ...deck, context: { ...context, group_id: 'group-2', scope_generation: 2 } }
  client.scopeChanged()
  releaseContext(403)
  await flush()
  await flush()
  expect(reports).toEqual([])
  await client.stop()
})

test('retries a refused A3 context before restoring the Avatar link', async () => {
  const context = { group_id: 'group-1', project_key: 'project-1', scope_generation: 1 }
  let contextAttempts = 0
  const { client, heartbeat, infos, live, reports } = harness()
  live.deck = { ...deck, context }
  live.post = async (_rendezvous, path, body) => {
    if (path !== '/attach') return 200
    if ((body as { context?: unknown }).context) {
      contextAttempts += 1
      return contextAttempts === 1 ? 500 : 200
    }
    return { status: 200, body: { capabilities: ['a3_context'] } }
  }

  client.start()
  await flush()
  expect(reports).toEqual(['Avatar refused the attach with status 500'])
  expect(infos).toEqual([])

  heartbeat.tick?.()
  await flush()
  expect(contextAttempts).toBe(2)
  expect(infos).toEqual(['Avatar link restored'])
  await client.stop()
})

test('detaches a blocked B attachment before replacing it with C', async () => {
  const brokerB = 'http://127.0.0.1:7900'
  const brokerC = 'http://127.0.0.1:7901'
  const attached = new Set<string>()
  let releaseContextB: (result: AvatarPostResult) => void = () => undefined
  const { client, live } = harness({
    post: async (_rendezvous, path, body) => {
      const broker = (body as { broker_url: string }).broker_url
      if (path === '/detach') {
        attached.delete(broker)
        return 200
      }
      if (path !== '/attach') return 200
      if ((body as { context?: unknown }).context && broker === brokerB) {
        return new Promise<AvatarPostResult>((resolve) => {
          releaseContextB = resolve
        })
      }
      if (!(body as { context?: unknown }).context) attached.add(broker)
      return (body as { context?: unknown }).context ? 200 : { status: 200, body: { capabilities: ['a3_context'] } }
    }
  })

  client.start()
  await flush()
  live.deck = {
    ...deck,
    broker_url: brokerB,
    context: { group_id: 'group-b', project_key: 'project-b', scope_generation: 1 }
  }
  client.scopeChanged()
  await flush()
  live.deck = {
    ...deck,
    broker_url: brokerC,
    context: { group_id: 'group-c', project_key: 'project-c', scope_generation: 2 }
  }
  client.scopeChanged()
  releaseContextB(200)
  await flush()
  await flush()
  await flush()

  expect(attached).toEqual(new Set([brokerC]))
  await client.stop()
})

test('abandons a broker replacement whose detach answers after the scope moved on', async () => {
  const secondBroker = 'http://127.0.0.1:7900'
  const thirdBroker = 'http://127.0.0.1:7901'
  let releaseDetach: () => void = () => undefined
  let detachCount = 0
  const attachedBrokers: string[] = []
  const { client, live } = harness({
    post: async (_rendezvous, path, body) => {
      if (path === '/attach') attachedBrokers.push((body as { broker_url: string }).broker_url)
      if (path === '/detach' && detachCount++ === 0) {
        await new Promise<void>((resolve) => {
          releaseDetach = resolve
        })
      }
      return 200
    }
  })
  client.start()
  await flush()
  live.deck = { ...deck, broker_url: secondBroker }
  client.sessionsChanged()
  await flush()
  live.deck = { ...deck, broker_url: thirdBroker }
  client.scopeChanged()
  releaseDetach()
  await flush()
  await flush()
  await flush()
  expect(attachedBrokers).toEqual([deck.broker_url, thirdBroker])
  await client.stop()
})
