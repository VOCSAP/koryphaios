import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { request } from 'node:https'
import { connect } from 'node:tls'
import { generateAvatarRunCertificate } from '../desktop/src/main/avatar-certificate.ts'
import {
  createAvatarSocketHub,
  deckSocketEndpoints,
  installAvatarServerErrorReporter,
  MAX_AVATAR_REQUEST_BYTES,
  observeAvatarRequest,
  startAvatarServer,
  type AvatarDeckSocket,
  type AvatarServer,
  type AvatarSocketHub,
  type AvatarSocketHubOptions
} from '../desktop/src/main/avatar-server.ts'
import { AvatarState } from '../desktop/src/shared/avatar-state.ts'
import { MAX_AVATAR_ATTACHMENTS, MAX_AVATAR_COUNTER } from '../desktop/src/shared/avatar-protocol.ts'

const certificate = generateAvatarRunCertificate()
const token = 'avatar-test-token'
const attach = {
  protocol_version: 1,
  deckRunId: 'deck-run-1',
  deckPid: 4242,
  broker_url: 'http://127.0.0.1:7899',
  projectDir: 'C:/work/example',
  deckName: 'Example'
}

interface AvatarResponse {
  status: number
  body: Record<string, unknown>
}

async function openServer(options: { allowedBrokerUrls?: readonly string[] } = {}): Promise<{ server: AvatarServer; state: AvatarState; reports: string[]; setNow(now: number): void }> {
  let now = 0
  const state = new AvatarState({ now: () => now })
  const reports: string[] = []
  const server = await startAvatarServer({
    avatarRunId: 'avatar-run-1',
    certificate: await certificate,
    state,
    token,
    report: (_scope, message) => reports.push(message),
    allowedBrokerUrls: () => options.allowedBrokerUrls ?? [attach.broker_url]
  })
  return { server, state, reports, setNow: (next) => { now = next } }
}

test('reports a rejected Avatar request handler', async () => {
  const reports: string[] = []
  observeAvatarRequest(Promise.reject(new Error('handler failed')), (_scope, message) => reports.push(message))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(reports).toEqual(['request failed'])
})

test('reports an Avatar server error after it has started', () => {
  const reports: string[] = []
  const server = new EventEmitter()
  installAvatarServerErrorReporter(server, (_scope, message) => reports.push(message))
  server.emit('error', new Error('listener failed'))
  expect(reports).toEqual(['server error'])
})

function post(
  server: AvatarServer,
  path: string,
  body: string,
  options: { token?: string; origin?: string } = {}
): Promise<AvatarResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${options.token ?? token}`,
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body))
    }
    if (options.origin !== undefined) headers.origin = options.origin

    const client = request(
      {
        hostname: '127.0.0.1',
        port: server.port,
        path,
        method: 'POST',
        rejectUnauthorized: false,
        headers
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
          })
        })
      }
    )
    client.on('error', reject)
    client.end(body)
  })
}

function postChunked(server: AvatarServer, path: string, body: string): Promise<AvatarResponse> {
  return new Promise((resolve, reject) => {
    const halfway = Math.floor(body.length / 2)
    const first = body.slice(0, halfway)
    const second = body.slice(halfway)
    const socket = connect({ host: '127.0.0.1', port: server.port, rejectUnauthorized: false }, () => {
      socket.write([
        `POST ${path} HTTP/1.1`,
        'Host: 127.0.0.1',
        `Authorization: Bearer ${token}`,
        'Content-Type: application/json',
        'Transfer-Encoding: chunked',
        'Connection: close',
        '',
        Buffer.byteLength(first).toString(16),
        first,
        Buffer.byteLength(second).toString(16),
        second,
        '0',
        '',
        ''
      ].join('\r\n'))
    })
    let response = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      response += chunk
    })
    socket.on('end', () => {
      const divider = response.indexOf('\r\n\r\n')
      const status = /^HTTP\/1\.1 (\d{3})/.exec(response)?.[1]
      if (divider < 0 || !status) {
        reject(new Error('Avatar server returned an invalid HTTP response'))
        return
      }
      resolve({
        status: Number(status),
        body: JSON.parse(response.slice(divider + 4)) as Record<string, unknown>
      })
    })
    socket.on('error', reject)
  })
}

function postHeadersOnly(server: AvatarServer, path: string, contentLength: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false
    const socket = connect({ host: '127.0.0.1', port: server.port, rejectUnauthorized: false }, () => {
      socket.write([
        `POST ${path} HTTP/1.1`,
        'Host: 127.0.0.1',
        `Authorization: Bearer ${token}`,
        'Content-Type: application/json',
        `Content-Length: ${contentLength}`,
        'Connection: close',
        '',
        ''
      ].join('\r\n'))
    })
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error('Avatar server did not reject oversized Content-Length before the request body'))
    }, 1_000)
    socket.setEncoding('utf8')
    socket.once('data', (response: string) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.destroy()
      const status = /^HTTP\/1\.1 (\d{3})/.exec(response)?.[1]
      if (!status) {
        reject(new Error('Avatar server returned an invalid HTTP response'))
        return
      }
      resolve(Number(status))
    })
    socket.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
  })
}

test('attaches one Deck per identity, receives state, and makes detach idempotent', async () => {
  const { server, state } = await openServer()
  try {
    expect(await post(server, '/attach', JSON.stringify(attach))).toEqual({
      status: 200,
      body: { ok: true, protocol_version: 1, avatarRunId: 'avatar-run-1' }
    })

    expect(await post(server, '/state', JSON.stringify({
      identity: { deckRunId: attach.deckRunId, broker_url: attach.broker_url },
      counters: { working: 2, idle: 1, unknown: 0, waiting: 0, exited: 0, rateLimited: 0 },
      unread: 3
    }))).toEqual({ status: 200, body: { ok: true } })
    expect(state.summary()).toMatchObject({
      face: 'courrier',
      counters: { working: 2, idle: 1 },
      unread: 3
    })

    expect(await post(server, '/attach', JSON.stringify({ ...attach, deckPid: 5252, deckName: 'Renamed' }))).toMatchObject({
      status: 200
    })
    expect(server.attachedDecks()).toEqual([{ ...attach, deckPid: 5252, deckName: 'Renamed' }])

    expect(await post(server, '/detach', JSON.stringify({
      deckRunId: attach.deckRunId,
      broker_url: attach.broker_url
    }))).toEqual({ status: 200, body: { ok: true, detached: true } })
    expect(await post(server, '/detach', JSON.stringify({
      deckRunId: attach.deckRunId,
      broker_url: attach.broker_url
    }))).toEqual({ status: 200, body: { ok: true, detached: false } })
    expect(state.summary().face).toBe('seul')
  } finally {
    await server.close()
  }
})

test('negotiates A3 context only with a capable Deck while preserving A1 attachments', async () => {
  const { server } = await openServer()
  const context = { group_id: 'group-1', project_key: 'project-1', scope_generation: 1 }
  try {
    expect(await post(server, '/attach', JSON.stringify({ ...attach, capabilities: ['a3_context'], context }))).toEqual({
      status: 200,
      body: { ok: true, protocol_version: 1, avatarRunId: 'avatar-run-1', capabilities: ['a3_context'] }
    })
    expect(server.attachedDecks()).toEqual([{ ...attach, capabilities: ['a3_context'], context }])
    expect(await post(server, '/attach', JSON.stringify({ ...attach, capabilities: ['future_avatar_capability'] }))).toEqual({
      status: 200,
      body: { ok: true, protocol_version: 1, avatarRunId: 'avatar-run-1' }
    })
    expect(server.attachedDecks()).toEqual([{ ...attach, capabilities: [] }])
  } finally {
    await server.close()
  }
})

test('rejects an attach PID that cannot prove Deck process ownership', async () => {
  const { server } = await openServer()
  try {
    for (const deckPid of [undefined, '4242', 42.5, 0]) {
      expect(await post(server, '/attach', JSON.stringify({ ...attach, deckPid }))).toEqual({
        status: 400,
        body: { error: 'invalid_request' }
      })
    }
  } finally {
    await server.close()
  }
})

test('removes a suspect Deck only when its PID confirms it is dead', async () => {
  const { server, state, setNow } = await openServer()
  try {
    expect(await post(server, '/attach', JSON.stringify(attach))).toMatchObject({ status: 200 })
    setNow(15_000)

    const probed: number[] = []
    server.sweepDeadDecks((pid) => {
      probed.push(pid)
      return false
    })

    expect(probed).toEqual([attach.deckPid])
    expect(server.attachedDecks()).toEqual([])
    expect(state.summary()).toMatchObject({ face: 'seul', decks: [] })
  } finally {
    await server.close()
  }
})

test('retains a live suspect Deck and does not probe a fresh Deck', async () => {
  const { server, state, setNow } = await openServer()
  const fresh = { ...attach, deckRunId: 'deck-run-fresh', deckPid: 5252 }
  try {
    expect(await post(server, '/attach', JSON.stringify(attach))).toMatchObject({ status: 200 })
    setNow(14_999)
    expect(await post(server, '/attach', JSON.stringify(fresh))).toMatchObject({ status: 200 })
    setNow(15_000)

    const probed: number[] = []
    server.sweepDeadDecks((pid) => {
      probed.push(pid)
      return true
    })

    expect(probed).toEqual([attach.deckPid])
    expect(server.attachedDecks()).toEqual([attach, fresh])
    expect(state.summary().face).toBe('panne')
  } finally {
    await server.close()
  }
})

test('keeps distinct broker identities with the same Deck run id attached', async () => {
  const otherBroker = 'https://127.0.0.1:7900'
  const { server, state } = await openServer({ allowedBrokerUrls: [attach.broker_url, otherBroker] })
  try {
    expect(await post(server, '/attach', JSON.stringify(attach))).toMatchObject({ status: 200 })
    expect(await post(server, '/attach', JSON.stringify({ ...attach, broker_url: otherBroker }))).toMatchObject({
      status: 200
    })
    expect(server.attachedDecks()).toHaveLength(2)
    const counters = {
      working: MAX_AVATAR_COUNTER,
      idle: MAX_AVATAR_COUNTER,
      unknown: MAX_AVATAR_COUNTER,
      waiting: MAX_AVATAR_COUNTER,
      exited: MAX_AVATAR_COUNTER,
      rateLimited: MAX_AVATAR_COUNTER
    }
    for (const broker_url of [attach.broker_url, otherBroker]) {
      expect(await post(server, '/state', JSON.stringify({
        identity: { deckRunId: attach.deckRunId, broker_url },
        counters,
        unread: MAX_AVATAR_COUNTER
      }))).toEqual({ status: 200, body: { ok: true } })
    }
    expect(MAX_AVATAR_ATTACHMENTS * MAX_AVATAR_COUNTER).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER)
    expect(state.summary()).toMatchObject({
      counters: { working: 2 * MAX_AVATAR_COUNTER },
      unread: 2 * MAX_AVATAR_COUNTER
    })
    expect(state.summary().decks.map((deck) => deck.identity.broker_url).sort()).toEqual([
      attach.broker_url,
      otherBroker
    ])
  } finally {
    await server.close()
  }
})

test('keeps an unlisted broker attached in A1 while refusing its A3 context', async () => {
  const { server, reports } = await openServer()
  const broker_url = 'https://untrusted.example.test'
  const context = { group_id: 'group-1', project_key: 'project-1', scope_generation: 1 }
  try {
    expect(await post(server, '/attach', JSON.stringify({ ...attach, broker_url, capabilities: ['a3_context'] }))).toEqual({
      status: 200,
      body: { ok: true, protocol_version: 1, avatarRunId: 'avatar-run-1' }
    })
    expect(await post(server, '/attach', JSON.stringify({ ...attach, broker_url, capabilities: ['a3_context'], context }))).toEqual({
      status: 403,
      body: { error: 'broker_not_allowed' }
    })
    expect(server.attachedDecks()).toEqual([{ ...attach, broker_url, capabilities: [] }])
    expect(reports).toEqual(['rejected Avatar context for a broker not authorized by Avatar main'])
  } finally {
    await server.close()
  }
})

test('refuses and traces the attach beyond sixty-four Decks while re-attaching a known Deck', async () => {
  const { server, reports } = await openServer()
  try {
    expect(MAX_AVATAR_ATTACHMENTS).toBe(64)
    for (let index = 0; index < MAX_AVATAR_ATTACHMENTS; index += 1) {
      expect((await post(server, '/attach', JSON.stringify({ ...attach, deckRunId: `deck-run-${index}` }))).status).toBe(200)
    }
    expect(await post(server, '/attach', JSON.stringify({ ...attach, deckRunId: 'deck-run-overflow' }))).toEqual({
      status: 409,
      body: { error: 'too_many_attached_decks' }
    })
    expect((await post(server, '/attach', JSON.stringify({ ...attach, deckRunId: 'deck-run-0' }))).status).toBe(200)
    expect(server.attachedDecks()).toHaveLength(MAX_AVATAR_ATTACHMENTS)
    expect(reports).toEqual(['rejected Avatar attachment limit'])
  } finally {
    await server.close()
  }
})

test('binds the Avatar server to IPv4 loopback only', async () => {
  const { server } = await openServer()
  try {
    expect(server.host).toBe('127.0.0.1')
  } finally {
    await server.close()
  }
})

test('traces an unsupported version without stopping the Avatar server', async () => {
  const { server, reports } = await openServer()
  try {
    expect(await post(server, '/attach', JSON.stringify({ ...attach, protocol_version: 2 }))).toEqual({
      status: 409,
      body: {
        error: 'unsupported_protocol_version',
        protocol_version: 1,
        supported_protocol_versions: [1],
        avatarRunId: 'avatar-run-1'
      }
    })
    expect(reports).toContain('unsupported Avatar protocol version 2')
    expect(await post(server, '/attach', JSON.stringify(attach))).toMatchObject({ status: 200 })
  } finally {
    await server.close()
  }
})

test('classifies malformed and unsupported protocol versions at the HTTP boundary', async () => {
  const { server } = await openServer()
  const cases = [
    { protocol_version: undefined, status: 400, error: 'invalid_request' },
    { protocol_version: null, status: 400, error: 'invalid_request' },
    { protocol_version: '1', status: 400, error: 'invalid_request' },
    { protocol_version: 1.5, status: 400, error: 'invalid_request' },
    { protocol_version: 'abc', status: 400, error: 'invalid_request' },
    { protocol_version: {}, status: 400, error: 'invalid_request' },
    { protocol_version: Number.MAX_SAFE_INTEGER + 1, status: 400, error: 'invalid_request' },
    { protocol_version: 2, status: 409, error: 'unsupported_protocol_version' }
  ]
  try {
    for (const expected of cases) {
      expect(await post(server, '/attach', JSON.stringify({ ...attach, protocol_version: expected.protocol_version }))).toMatchObject({
        status: expected.status,
        body: { error: expected.error }
      })
    }
  } finally {
    await server.close()
  }
})

test('rejects and traces untrusted, malformed, oversized, and unattached requests', async () => {
  const { server, reports } = await openServer()
  try {
    expect(await post(server, '/attach', JSON.stringify(attach), { token: 'wrong-token' })).toMatchObject({
      status: 401,
      body: { error: 'unauthorized' }
    })
    expect(await post(server, '/attach', JSON.stringify(attach), { origin: 'https://example.test' })).toMatchObject({
      status: 403,
      body: { error: 'origin_not_allowed' }
    })
    expect(await post(server, '/attach', '{')).toMatchObject({
      status: 400,
      body: { error: 'invalid_request' }
    })
    expect(await postChunked(server, '/attach', 'x'.repeat(MAX_AVATAR_REQUEST_BYTES + 1))).toMatchObject({
      status: 413,
      body: { error: 'payload_too_large' }
    })
    expect(await post(server, '/state', JSON.stringify({
      identity: { deckRunId: attach.deckRunId, broker_url: attach.broker_url },
      counters: { working: 0, idle: 0, unknown: 0, waiting: 0, exited: 0, rateLimited: 0 },
      unread: 0
    }))).toMatchObject({
      status: 409,
      body: { error: 'deck_not_attached' }
    })
    expect(reports).toEqual([
      'rejected unauthorized Avatar request',
      'rejected Avatar request with an Origin header',
      'invalid_request',
      'payload_too_large',
      'rejected state for an unattached Deck'
    ])
  } finally {
    await server.close()
  }
})

test('rejects an oversized Content-Length before the request body arrives', async () => {
  const { server } = await openServer()
  try {
    expect(await postHeadersOnly(server, '/attach', MAX_AVATAR_REQUEST_BYTES + 1)).toBe(413)
  } finally {
    await server.close()
  }
})

const deck = { deckRunId: attach.deckRunId, broker_url: attach.broker_url }
const otherDeck = { deckRunId: 'deck-run-2', broker_url: 'http://127.0.0.1:7900' }
const bindFrame = (identity: { deckRunId: string; broker_url: string }) => ({ type: 'bind', protocol_version: 1, ...identity })

class FakeDeckSocket extends EventEmitter implements AvatarDeckSocket {
  readyState = 1
  sent: Record<string, unknown>[] = []
  closed: { code: number; reason: string } | undefined

  send(data: string, callback?: (error?: Error) => void): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
    callback?.()
  }

  close(code: number, reason: string): void {
    if (this.closed) return
    this.closed = { code, reason }
    this.readyState = 3
    this.emit('close')
  }

  receive(frame: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)), false)
  }
}

function openHub(options: Partial<AvatarSocketHubOptions> = {}): {
  hub: AvatarSocketHub
  reports: string[]
  attachedDecks: Array<{ deckRunId: string; broker_url: string }>
} {
  const reports: string[] = []
  const attachedDecks = [deck, otherDeck]
  const hub = createAvatarSocketHub({
    isAttached: (identity) =>
      attachedDecks.some((candidate) => candidate.deckRunId === identity.deckRunId && candidate.broker_url === identity.broker_url),
    report: (_scope, message) => reports.push(message),
    bindTimeoutMs: 1_000,
    commandResultTimeoutMs: 1_000,
    ...options
  })
  return { hub, reports, attachedDecks }
}

function boundSocket(hub: AvatarSocketHub, identity = deck, remotePort: number | null = 50_000): FakeDeckSocket {
  const socket = new FakeDeckSocket()
  hub.accept(socket, remotePort)
  socket.receive(bindFrame(identity))
  return socket
}

function settledWithin<T>(promise: Promise<T>, ms = 500): Promise<T> {
  return Promise.race([
    promise,
    Bun.sleep(ms).then(() => {
      throw new Error(`focusDeck was still pending after ${ms} ms`)
    })
  ])
}

function lastRequestId(socket: FakeDeckSocket): string {
  const requestId = socket.sent.at(-1)?.requestId
  if (typeof requestId !== 'string') throw new Error('the Avatar sent no command with a requestId')
  return requestId
}

test('binds an attached Deck then relays its focus command result', async () => {
  const { hub } = openHub()
  const socket = boundSocket(hub)
  try {
    expect(socket.sent).toEqual([{ type: 'bound' }])
    const focus = hub.focusDeck(deck, 'focus')
    expect(socket.sent[1]).toMatchObject({ type: 'command', command: 'focus', ...deck })
    const requestId = lastRequestId(socket)
    socket.receive({ type: 'command_result', requestId, ok: false, error: 'window gone' })
    await expect(settledWithin(focus)).resolves.toEqual({ requestId, ok: false, error: 'window gone' })
  } finally {
    socket.close(1000, 'test done')
  }
})

test('sends the command it is given, and relays its result', async () => {
  const { hub } = openHub()
  const socket = boundSocket(hub)
  try {
    const opening = hub.focusDeck(deck, 'open_question')
    expect(socket.sent[1]).toMatchObject({ type: 'command', command: 'open_question', ...deck })
    const requestId = lastRequestId(socket)
    socket.receive({ type: 'command_result', requestId, ok: true })
    await expect(settledWithin(opening)).resolves.toEqual({ requestId, ok: true })
  } finally {
    socket.close(1000, 'test done')
  }
})

test('traces then closes a bind whose protocol version is unsupported', () => {
  const { hub, reports } = openHub()
  const socket = new FakeDeckSocket()
  hub.accept(socket, 50_000)
  socket.receive({ ...bindFrame(deck), protocol_version: 2 })
  expect(socket.closed).toEqual({ code: 4409, reason: 'unsupported version' })
  expect(socket.sent).toEqual([])
  expect(reports).toEqual(['unsupported Avatar protocol version 2'])
})

test('traces then closes a command received before bound', () => {
  const { hub, reports } = openHub()
  const socket = new FakeDeckSocket()
  hub.accept(socket, 50_000)
  socket.receive({ type: 'command', requestId: 'request-1', command: 'focus', ...deck })
  expect(socket.closed).toEqual({ code: 4401, reason: 'bind required' })
  expect(reports).toEqual(['rejected Avatar command before bind'])
})

test('traces then closes a bind for a Deck that was never attached', () => {
  const { hub, reports } = openHub()
  const socket = new FakeDeckSocket()
  hub.accept(socket, 50_000)
  socket.receive(bindFrame({ deckRunId: 'deck-run-unknown', broker_url: deck.broker_url }))
  expect(socket.closed).toEqual({ code: 4403, reason: 'Deck not attached' })
  expect(socket.sent).toEqual([])
  expect(reports).toEqual(['rejected Avatar WebSocket bind for an unattached Deck'])
})

test('traces then closes a socket that misses the bind deadline', async () => {
  const { hub, reports } = openHub({ bindTimeoutMs: 10 })
  const socket = new FakeDeckSocket()
  hub.accept(socket, 50_000)
  await Bun.sleep(40)
  expect(socket.closed).toEqual({ code: 4408, reason: 'bind timeout' })
  expect(reports).toEqual(['rejected Avatar WebSocket bind timeout'])
})

test('rejects a focus whose command_result misses its deadline', async () => {
  const { hub } = openHub({ commandResultTimeoutMs: 10 })
  const socket = boundSocket(hub)
  try {
    await expect(settledWithin(hub.focusDeck(deck, 'focus'))).rejects.toThrow('Avatar command result timed out')
  } finally {
    socket.close(1000, 'test done')
  }
})

test('never replays a command to the socket that reconnects after a disconnect', async () => {
  const { hub } = openHub()
  const first = boundSocket(hub)
  const focus = hub.focusDeck(deck, 'focus')
  first.close(1006, 'lost')
  await expect(settledWithin(focus)).rejects.toThrow('Avatar Deck WebSocket disconnected')

  const second = boundSocket(hub)
  try {
    await Bun.sleep(20)
    expect(second.sent).toEqual([{ type: 'bound' }])
  } finally {
    second.close(1000, 'test done')
  }
})

test('a second bind of the same Deck supersedes the first socket, traced, with its own close code', async () => {
  const { hub, reports } = openHub()
  const first = boundSocket(hub)
  const stranded = hub.focusDeck(deck, 'focus')
  const second = boundSocket(hub)
  try {
    expect(first.closed).toEqual({ code: 4410, reason: 'superseded' })
    expect(reports).toEqual(['replaced the Avatar WebSocket of a Deck that bound again'])
    await expect(settledWithin(stranded)).rejects.toThrow('Avatar Deck WebSocket superseded')
    const focus = hub.focusDeck(deck, 'focus')
    expect(first.sent).toHaveLength(2)
    const requestId = lastRequestId(second)
    second.receive({ type: 'command_result', requestId, ok: true })
    await expect(settledWithin(focus)).resolves.toEqual({ requestId, ok: true })
  } finally {
    second.close(1000, 'test done')
  }
})

test('traces and ignores a late or unknown command_result without closing the channel', async () => {
  const { hub, reports } = openHub({ commandResultTimeoutMs: 10 })
  const socket = boundSocket(hub)
  try {
    const expired = hub.focusDeck(deck, 'focus')
    const expiredId = lastRequestId(socket)
    await expect(settledWithin(expired)).rejects.toThrow('Avatar command result timed out')
    const live = hub.focusDeck(deck, 'focus')
    const liveId = lastRequestId(socket)
    socket.receive({ type: 'command_result', requestId: expiredId, ok: true })
    socket.receive({ type: 'command_result', requestId: 'never-issued', ok: true })
    socket.receive({ type: 'command_result', requestId: liveId, ok: true })
    await expect(settledWithin(live)).resolves.toEqual({ requestId: liveId, ok: true })
    expect(socket.closed).toBeUndefined()
    expect(reports).toEqual([
      'ignored an Avatar command result with an unknown or expired requestId',
      'ignored an Avatar command result with an unknown or expired requestId'
    ])
  } finally {
    socket.close(1000, 'test done')
  }
})

test('detach closes the bound socket, rejects its pending commands, and focusDeck then refuses the Deck', async () => {
  const { hub, attachedDecks } = openHub()
  const socket = boundSocket(hub)
  const pending = hub.focusDeck(deck, 'focus')
  attachedDecks.splice(attachedDecks.indexOf(deck), 1)
  hub.detach(deck)
  expect(socket.closed).toEqual({ code: 4410, reason: 'detached' })
  await expect(settledWithin(pending)).rejects.toThrow('Avatar Deck detached')
  await expect(settledWithin(hub.focusDeck(deck, 'focus'))).rejects.toThrow('Avatar Deck is not attached')
})

test('focusDeck refuses a Deck no longer attached even while its socket is still bound', async () => {
  const { hub, attachedDecks } = openHub()
  const socket = boundSocket(hub)
  try {
    attachedDecks.splice(attachedDecks.indexOf(deck), 1)
    await expect(settledWithin(hub.focusDeck(deck, 'focus'))).rejects.toThrow('Avatar Deck is not attached')
    expect(socket.sent).toEqual([{ type: 'bound' }])
  } finally {
    socket.close(1000, 'test done')
  }
})

test('closes and traces a second bind on an already bound socket', () => {
  const { hub, reports } = openHub()
  const socket = boundSocket(hub)
  socket.receive(bindFrame(deck))
  expect(socket.closed).toEqual({ code: 4400, reason: 'invalid frame' })
  expect(reports).toEqual(['rejected a second Avatar WebSocket bind on a bound socket'])
})

test('reports a Deck bound only between its bind and its disconnect', () => {
  const { hub } = openHub()
  expect(hub.isDeckBound(deck)).toBe(false)
  const socket = boundSocket(hub)
  expect(hub.isDeckBound(deck)).toBe(true)
  expect(hub.isDeckBound(otherDeck)).toBe(false)
  socket.close(1000, 'test done')
  expect(hub.isDeckBound(deck)).toBe(false)
})

test('the Deck-side port of the current bound socket is the one reported, and only while it is open', () => {
  const { hub } = openHub()
  expect(hub.boundRemotePort(deck)).toBeNull()
  const first = boundSocket(hub, deck, 50_001)
  expect(hub.boundRemotePort(deck)).toBe(50_001)
  expect(hub.boundRemotePort(otherDeck)).toBeNull()
  const second = boundSocket(hub, deck, 50_002)
  expect(first.closed, 'the superseded socket is closed').not.toBeNull()
  expect(hub.boundRemotePort(deck), 'a re-bound Deck is checked on its new socket').toBe(50_002)
  second.close(1000, 'test done')
  expect(hub.boundRemotePort(deck)).toBeNull()
})

test('A1 binds any attached identity a socket declares, without proving Deck ownership', () => {
  const { hub } = openHub()
  const socket = boundSocket(hub, otherDeck)
  try {
    expect(socket.sent).toEqual([{ type: 'bound' }])
  } finally {
    socket.close(1000, 'test done')
  }
})

test('the Deck side of a bound socket is the local end netstat must read, the Avatar side the remote end', () => {
  const server = { port: 50_100, boundRemotePort: (identity: { deckRunId: string }) => (identity.deckRunId === deck.deckRunId ? 50_123 : null) }
  expect(deckSocketEndpoints(server, deck)).toEqual({
    local: { address: '127.0.0.1', port: 50_123 },
    remote: { address: '127.0.0.1', port: 50_100 }
  })
  expect(deckSocketEndpoints(server, otherDeck)).toBeNull()
})

test.each([
  ['an empty allow-list', { allowedBrokerUrls: [] as string[] }, attach.broker_url],
  ['a broker URL that an allowed one is only a prefix of', { allowedBrokerUrls: ['http://127.0.0.1:78'] }, attach.broker_url],
  ['a broker URL extending an allowed one with a path', {}, `${attach.broker_url}/evil`]
])('refuses the A3 context of a broker outside the allow-list: %s', async (_what, options, broker_url) => {
  const { server } = await openServer(options)
  const context = { group_id: 'group-1', project_key: 'project-1', scope_generation: 1 }
  try {
    expect(await post(server, '/attach', JSON.stringify({ ...attach, broker_url, capabilities: ['a3_context'], context }))).toEqual({
      status: 403,
      body: { error: 'broker_not_allowed' }
    })
  } finally {
    await server.close()
  }
})

test('refuses the A3 context when the server was given no broker allow-list', async () => {
  const server = await startAvatarServer({
    avatarRunId: 'avatar-run-1',
    certificate: await certificate,
    state: new AvatarState({ now: () => 0 }),
    token,
    report: () => undefined
  })
  const context = { group_id: 'group-1', project_key: 'project-1', scope_generation: 1 }
  try {
    expect(await post(server, '/attach', JSON.stringify({ ...attach, capabilities: ['a3_context'], context }))).toEqual({
      status: 403,
      body: { error: 'broker_not_allowed' }
    })
  } finally {
    await server.close()
  }
})
