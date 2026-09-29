import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { request } from 'node:https'
import { connect } from 'node:tls'
import { generateAvatarRunCertificate } from '../desktop/src/main/avatar-certificate.ts'
import {
  installAvatarServerErrorReporter,
  MAX_AVATAR_REQUEST_BYTES,
  observeAvatarRequest,
  startAvatarServer,
  type AvatarServer
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

async function openServer(): Promise<{ server: AvatarServer; state: AvatarState; reports: string[] }> {
  const state = new AvatarState({ now: () => 0 })
  const reports: string[] = []
  const server = await startAvatarServer({
    avatarRunId: 'avatar-run-1',
    certificate: await certificate,
    state,
    token,
    report: (_scope, message) => reports.push(message)
  })
  return { server, state, reports }
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

test('keeps distinct broker identities with the same Deck run id attached', async () => {
  const { server, state } = await openServer()
  const otherBroker = 'https://127.0.0.1:7900'
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
