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
  const connects: Array<unknown> = []
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
    connect: (_rendezvous, limits) => {
      connects.push(limits)
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
  return { client, posts, sockets, reports, infos, warnings, heartbeat, deadlines, live, connects }
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
  const context = { group_id: '11111111111111111111111111111111', project_key: 'project-1', scope_generation: 1 }
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
  const context = { group_id: '11111111111111111111111111111111', project_key: 'project-1', scope_generation: 1 }
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

const inboxContext = { group_id: '11111111111111111111111111111111', project_key: 'project-1', scope_generation: 5 }
const APPROVAL_ID = '00000000-0000-4000-8000-000000000001'

function inboxApproval() {
  return {
    id: APPROVAL_ID,
    operator_id: 'op',
    origin: { host: 'h', os_user_hash: 'x', project_key: 'p', group_id: 'g', from_peer: 'peer-a', session_ref: 's', tile_ref: 't' },
    kind: 'question',
    title: 'Proceed?',
    question: 'q',
    options: [],
    status: 'pending',
    reply_route: 'channel',
    mergeable: false,
    absorbed_permission: false,
    informational: false,
    answered_via: null,
    answer_kind: null,
    answer_text: null,
    questions: null,
    answers: null,
    created_at: '2026-11-17T08:00:00.000Z',
    notif_expires_at: '2026-11-17T09:00:00.000Z',
    answered_at: null,
    delivered_at: null
  } as never
}

async function inboxHarness(granted: readonly string[], overrides: Partial<AvatarClientOptions> = {}) {
  const acts: Array<{ action: unknown; sentIds: string[] }> = []
  const context = harness({
    inbox: {
      sources: () => ({ approvals: [inboxApproval()], messages: [], closed: [], tileName: () => null }),
      act: async (action, sentIds) => {
        acts.push({ action, sentIds: [...sentIds.keys()] })
        return { outcome: 'won' }
      }
    },
    ...overrides
  })
  context.live.deck = { ...deck, context: inboxContext }
  context.live.status['/attach'] = { status: 200, body: { capabilities: granted } }
  context.client.start()
  await flush()
  await flush()
  const socket = context.sockets[0]!
  socket.open()
  socket.receive({ type: 'bound' })
  return { ...context, socket, acts }
}

test('asks for a3_inbox only when it has an inbox to relay, and relays it after bound once granted', async () => {
  const { client, posts, socket } = await inboxHarness(['a3_context', 'a3_inbox'])
  expect(posts[0]).toEqual({
    path: '/attach',
    body: { protocol_version: 1, ...deck, capabilities: ['a3_context', 'a3_inbox', 'a3_notify_replace', 'a3_inbox_signals'] }
  })
  const frames = socket.sent.filter((frame) => frame.type === 'inbox_snapshot')
  expect(frames).toHaveLength(1)
  expect(frames[0]).toMatchObject({ seq: 1, scope_generation: 5, ...identity })
  expect((frames[0]!.approvals as Array<{ id: string }>).map((a) => a.id)).toEqual([APPROVAL_ID])
  await client.stop()
})

test('sends the warning signals only to an Avatar that granted a3_inbox_signals', async () => {
  const flagged = { ...(inboxApproval() as object), text_flags: ['bidi'] } as never
  const inbox: AvatarClientOptions['inbox'] = {
    sources: () => ({ approvals: [flagged], messages: [], closed: [], tileName: () => null }),
    act: async () => ({ outcome: 'won' })
  }
  const relayedFlags = async (granted: readonly string[]) => {
    const { client, socket } = await inboxHarness(granted, { inbox })
    const frame = socket.sent.find((sent) => sent.type === 'inbox_snapshot')!
    await client.stop()
    return (frame.approvals as Array<{ text_flags?: string[] }>)[0]!.text_flags
  }
  expect(await relayedFlags(['a3_context', 'a3_inbox', 'a3_inbox_signals'])).toEqual(['bidi'])
  expect(await relayedFlags(['a3_context', 'a3_inbox']), 'an older Avatar refuses an unknown field').toBeUndefined()
})

test('relays nothing and refuses inbox_action as unsupported when the Avatar did not grant a3_inbox', async () => {
  const { client, socket, acts } = await inboxHarness(['a3_context'])
  expect(socket.sent.filter((frame) => frame.type === 'inbox_snapshot')).toEqual([])
  socket.receive(command({ command: 'inbox_action', inbox: { approval_id: APPROVAL_ID, action: 'allow' } }))
  await flush()
  expect(socket.sent.at(-1)).toEqual({ type: 'command_result', requestId: 'request-1', ok: false, error: 'unsupported_command' })
  expect(acts).toEqual([])
  await client.stop()
})

test('carries out an inbox_action against the ids relayed on this socket and answers its outcome', async () => {
  const { client, socket, acts } = await inboxHarness(['a3_context', 'a3_inbox'])
  socket.receive(command({ command: 'inbox_action', inbox: { approval_id: APPROVAL_ID, action: 'deny' } }))
  await flush()
  expect(acts).toEqual([{ action: { approval_id: APPROVAL_ID, action: 'deny' }, sentIds: [APPROVAL_ID] }])
  expect(socket.sent.at(-1)).toEqual({ type: 'command_result', requestId: 'request-1', ok: true, outcome: 'won' })

  socket.receive(command({ requestId: 'request-2', command: 'inbox_action', inbox: { approval_id: APPROVAL_ID, action: 'terminal' } }))
  await flush()
  expect(socket.sent.at(-1)).toEqual({ type: 'command_result', requestId: 'request-2', ok: false, error: 'invalid_inbox_action' })
  expect(acts).toHaveLength(1)
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
    group_id: '22222222222222222222222222222222',
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
    context: { group_id: '22222222222222222222222222222222', project_key: 'project-1', scope_generation: 2 }
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

test('a Deck theme change re-attaches once under the same identity, keeping its socket', async () => {
  const { client, posts, sockets, heartbeat, live } = await boundHarness()
  live.deck = { ...deck, theme: 'light' }
  heartbeat.tick?.()
  await flush()
  heartbeat.tick?.()
  await flush()
  const attaches = posts.filter((post) => post.path === '/attach')
  expect(attaches).toEqual([
    { path: '/attach', body: { protocol_version: 1, ...deck } },
    { path: '/attach', body: { protocol_version: 1, ...deck, theme: 'light' } }
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
  ['group', { group_id: '22222222222222222222222222222222' }],
  ['project key', { project_key: 'project-2' }]
])('renews its attachment when only the %s of the Deck context changes', async (_field, change) => {
  const context = { group_id: '11111111111111111111111111111111', project_key: 'project-1', scope_generation: 1 }
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
  const context = { group_id: '11111111111111111111111111111111', project_key: 'project-1', scope_generation: 1 }
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
  live.deck = { ...deck, context: { ...context, group_id: '22222222222222222222222222222222', scope_generation: 2 } }
  client.scopeChanged()
  releaseContext(403)
  await flush()
  await flush()
  expect(reports).toEqual([])
  await client.stop()
})

test('retries a refused A3 context before restoring the Avatar link', async () => {
  const context = { group_id: '11111111111111111111111111111111', project_key: 'project-1', scope_generation: 1 }
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
    context: { group_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', project_key: 'project-b', scope_generation: 1 }
  }
  client.scopeChanged()
  await flush()
  live.deck = {
    ...deck,
    broker_url: brokerC,
    context: { group_id: 'cccccccccccccccccccccccccccccccc', project_key: 'project-c', scope_generation: 2 }
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

const NOTIFY_GRANTED = ['a3_context', 'a3_inbox', 'a3_notify_replace']
const statusFrame = (overrides: Record<string, unknown> = {}) => ({
  type: 'notification_status',
  protocol_version: 1,
  avatarRunId: 'avatar-run-1',
  ...identity,
  scope_generation: 5,
  seq: 1,
  replace: true,
  lease_ms: 15_000,
  ...overrides
})

async function notifyHarness(granted: readonly string[] = NOTIFY_GRANTED) {
  const clock = { now: 1_000 }
  const context = await inboxHarness(granted, { monotonicNow: () => clock.now })
  return { ...context, clock }
}

test('the lease holds for 15000 ms on the injected monotonic clock and never longer, whatever the cache or the clock', async () => {
  const { client, socket, clock } = await notifyHarness()
  expect(client.notificationsReplaced(), 'no status yet').toBe(false)
  socket.receive(statusFrame())
  expect(client.notificationsReplaced()).toBe(true)
  clock.now = 1_000 + 14_999
  expect(client.notificationsReplaced()).toBe(true)
  clock.now = 1_000 + 15_000
  expect(client.notificationsReplaced(), 'the lease is over at its full length').toBe(false)
  clock.now = 1_000 + 100
  expect(client.notificationsReplaced(), 'an expired lease is not cached back to life').toBe(false)

  socket.receive(statusFrame({ seq: 2 }))
  clock.now = 500
  expect(client.notificationsReplaced(), 'a clock gone backwards never extends the lease').toBe(false)
  socket.receive(statusFrame({ seq: 3 }))
  clock.now = Number.NaN
  expect(client.notificationsReplaced(), 'a non-finite clock never suppresses').toBe(false)
  await client.stop()
})

test('a duplicate or older sequence renews nothing and a revocation keeps the floor, so an old true cannot come back', async () => {
  const { client, socket, clock } = await notifyHarness()
  socket.receive(statusFrame({ seq: 2 }))
  clock.now = 10_000
  socket.receive(statusFrame({ seq: 2 }))
  socket.receive(statusFrame({ seq: 1 }))
  clock.now = 1_000 + 15_000
  expect(client.notificationsReplaced(), 'a replayed frame did not renew the lease').toBe(false)

  clock.now = 20_000
  socket.receive(statusFrame({ seq: 3 }))
  expect(client.notificationsReplaced()).toBe(true)
  socket.receive(statusFrame({ seq: 4, replace: false }))
  expect(client.notificationsReplaced(), 'replace false revokes at once').toBe(false)
  socket.receive(statusFrame({ seq: 3 }))
  socket.receive(statusFrame({ seq: 4 }))
  expect(client.notificationsReplaced(), 'an old true after a revocation stays inert').toBe(false)
  socket.receive(statusFrame({ seq: 5 }))
  expect(client.notificationsReplaced()).toBe(true)
  await client.stop()
})

test('a status for another Avatar run, Deck run, broker or scope generation cannot activate or keep the lease', async () => {
  const { client, socket } = await notifyHarness()
  const foreign = [
    { avatarRunId: 'avatar-run-2' },
    { deckRunId: 'deck-run-9' },
    { broker_url: 'http://127.0.0.1:7000' },
    { scope_generation: 6 }
  ]
  for (const [index, patch] of foreign.entries()) {
    socket.receive(statusFrame({ seq: 10 + index * 2 }))
    expect(client.notificationsReplaced(), `lease before ${JSON.stringify(patch)}`).toBe(true)
    socket.receive(statusFrame({ seq: 11 + index * 2, ...patch }))
    expect(client.notificationsReplaced(), JSON.stringify(patch)).toBe(false)
  }
  await client.stop()
})

test('a malformed, unnegotiated or pre-bound status never activates, clears an existing lease and leaves the socket open', async () => {
  const { client, socket, reports } = await notifyHarness()
  socket.receive(statusFrame())
  expect(client.notificationsReplaced()).toBe(true)
  const malformed = [
    { ...statusFrame({ seq: 2 }), extra: 1 },
    statusFrame({ seq: 3, replace: 'true' }),
    statusFrame({ seq: 4, lease_ms: 30_000 }),
    statusFrame({ seq: 5, scope_generation: -1 })
  ]
  for (const [index, bad] of malformed.entries()) {
    socket.receive(statusFrame({ seq: 100 + index }))
    expect(client.notificationsReplaced()).toBe(true)
    socket.receive(bad)
    expect(client.notificationsReplaced(), JSON.stringify(bad)).toBe(false)
  }
  expect(socket.closed, 'invalid data does not close the focus channel').toBeUndefined()
  expect(reports).toContain('rejected an invalid Avatar frame')

  const early = await notifyHarnessUnbound()
  early.socket.receive(statusFrame())
  expect(early.client.notificationsReplaced(), 'a status before bound activates nothing').toBe(false)
  early.socket.receive({ type: 'bound' })
  early.socket.receive(statusFrame())
  expect(early.client.notificationsReplaced(), 'the floor was not consumed by the refused frame').toBe(true)

  const legacy = await notifyHarness(['a3_context', 'a3_inbox'])
  legacy.socket.receive(statusFrame())
  expect(legacy.client.notificationsReplaced(), 'a status on a pair that did not negotiate it is ignored').toBe(false)
  await Promise.all([client.stop(), early.client.stop(), legacy.client.stop()])
})

async function notifyHarnessUnbound() {
  const clock = { now: 1_000 }
  const context = harness({
    monotonicNow: () => clock.now,
    inbox: { sources: () => ({ approvals: [], messages: [], closed: [], tileName: () => null }), act: async () => ({ outcome: 'won' }) }
  })
  context.live.deck = { ...deck, context: inboxContext }
  context.live.status['/attach'] = { status: 200, body: { capabilities: NOTIFY_GRANTED } }
  context.client.start()
  await flush()
  await flush()
  const socket = context.sockets[0]!
  socket.open()
  return { ...context, socket, clock }
}

test('every door that ends the binding drops the lease at once', async () => {
  const doors: Array<[string, (h: Awaited<ReturnType<typeof notifyHarness>>) => Promise<void> | void]> = [
    ['socket close', (h) => void h.socket.close(1006)],
    ['socket error', (h) => void h.socket.emit('error', new Error('boom'))],
    ['scope change', (h) => h.client.scopeChanged()],
    [
      'stop',
      async (h) => {
        const stopping = h.client.stop()
        expect(h.client.notificationsReplaced(), 'before the async chain settles').toBe(false)
        await stopping
      }
    ],
    [
      'rendezvous gone',
      async (h) => {
        h.live.rendezvous = null as never
        h.heartbeat.tick?.()
        await flush()
      }
    ],
    [
      'state refused',
      async (h) => {
        h.live.post = async (_r, path) => (path === '/state' ? 500 : { status: 200, body: { capabilities: NOTIFY_GRANTED } })
        h.heartbeat.tick?.()
        await flush()
      }
    ],
    [
      'renegotiation',
      async (h) => {
        h.live.deck = { ...h.live.deck, deckName: 'Renamed' }
        h.heartbeat.tick?.()
        await flush()
        await flush()
      }
    ],
    [
      'attach refused',
      async (h) => {
        h.live.deck = { ...h.live.deck, deckName: 'Renamed' }
        h.live.post = async (_r, path) => (path === '/attach' ? 500 : 200)
        h.heartbeat.tick?.()
        await flush()
      }
    ],
    [
      'context attach refused',
      async (h) => {
        let attaches = 0
        h.live.deck = { ...h.live.deck, deckName: 'Renamed' }
        h.live.post = async (_r, path) => {
          if (path !== '/attach') return 200
          attaches += 1
          return attaches === 1 ? { status: 200, body: { capabilities: NOTIFY_GRANTED } } : 500
        }
        h.heartbeat.tick?.()
        await flush()
        await flush()
      }
    ],
    [
      'transport failure',
      async (h) => {
        h.live.post = async () => {
          throw new Error('down')
        }
        h.heartbeat.tick?.()
        await flush()
      }
    ]
  ]
  for (const [name, trigger] of doors) {
    const h = await notifyHarness()
    h.socket.receive(statusFrame())
    expect(h.client.notificationsReplaced(), `${name}: lease before`).toBe(true)
    await trigger(h)
    expect(h.client.notificationsReplaced(), name).toBe(false)
    await h.client.stop()
  }
})

test('a renegotiated pair needs a new binding and its own accepted status, and an old socket cannot touch the new lease', async () => {
  const h = await notifyHarness()
  h.socket.receive(statusFrame({ seq: 7 }))
  expect(h.client.notificationsReplaced()).toBe(true)
  h.live.deck = { ...h.live.deck, deckName: 'Renamed' }
  h.heartbeat.tick?.()
  await flush()
  await flush()
  expect(h.socket.closed, 'the old socket was closed').toBeDefined()
  const next = h.sockets[1]!
  expect(next).toBeDefined()
  next.open()
  next.receive({ type: 'bound' })
  expect(h.client.notificationsReplaced(), 'the new binding starts without the old witness').toBe(false)
  next.receive(statusFrame({ seq: 1 }))
  expect(h.client.notificationsReplaced(), 'its own floor restarts at zero').toBe(true)

  h.socket.receive(statusFrame({ seq: 50, replace: false }))
  h.socket.emit('close', 1006)
  h.socket.emit('error', new Error('late'))
  expect(h.client.notificationsReplaced(), 'late events of the old socket leave the new lease alone').toBe(true)
  await h.client.stop()
})

test('nothing reactivates after stop', async () => {
  const h = await notifyHarness()
  await h.client.stop()
  h.socket.receive(statusFrame())
  expect(h.client.notificationsReplaced()).toBe(false)
})

test('only a pair that negotiated the capability gets the 64 KiB WSS bound, and an oversize frame there is refused', async () => {
  const negotiated = await notifyHarness()
  expect(negotiated.connects).toEqual([{ maxPayload: 64 * 1024 }])
  negotiated.socket.receive(statusFrame())
  expect(negotiated.client.notificationsReplaced()).toBe(true)
  negotiated.socket.emit('message', Buffer.from(JSON.stringify({ ...statusFrame({ seq: 2 }), pad: 'x'.repeat(64 * 1024) })))
  expect(negotiated.client.notificationsReplaced(), 'an oversize frame clears the lease and is not parsed').toBe(false)
  expect(negotiated.reports).toContain('rejected an oversize Avatar frame')

  const legacy = await notifyHarness(['a3_context', 'a3_inbox'])
  expect(legacy.connects, 'the legacy pair keeps the default options').toEqual([undefined])
  await Promise.all([negotiated.client.stop(), legacy.client.stop()])
})

test('an old Deck stays silent: nothing is asked without a context or an inbox to relay', async () => {
  const noInbox = harness()
  noInbox.live.deck = { ...deck, context: inboxContext }
  noInbox.client.start()
  await flush()
  expect(JSON.stringify(noInbox.posts)).not.toContain('a3_notify_replace')
  expect(noInbox.client.notificationsReplaced()).toBe(false)
  await noInbox.client.stop()
})
