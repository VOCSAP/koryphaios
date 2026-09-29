import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import {
  AVATAR_PROTOCOL_VERSION,
  AvatarProtocolError,
  MAX_AVATAR_ATTACHMENTS,
  parseAvatarAttachRequest,
  parseAvatarDeckFrame,
  parseAvatarDetachRequest,
  parseAvatarStateRequest,
  type AvatarAttachRequest
} from '../shared/avatar-protocol'
import type { AvatarRunCertificate } from './avatar-certificate'
import type { TcpEndpoint } from './avatar-socket-owner'
import { AvatarState, type AvatarDeckIdentity } from '../shared/avatar-state'
import { reportError } from './log'

export const MAX_AVATAR_REQUEST_BYTES = 64 * 1024
export const AVATAR_BIND_TIMEOUT_MS = 5_000
export const AVATAR_COMMAND_RESULT_TIMEOUT_MS = 3_000

export interface AvatarServerOptions {
  avatarRunId: string
  certificate: AvatarRunCertificate
  state: AvatarState
  token: string
  port?: number
  bindTimeoutMs?: number
  commandResultTimeoutMs?: number
  report?: typeof reportError
}

export interface AvatarAttachedDeck extends AvatarAttachRequest {}

export interface AvatarCommandResult {
  requestId: string
  ok: boolean
  error?: string
}

export interface AvatarServer {
  readonly host: string
  readonly port: number
  attachedDecks(): AvatarAttachedDeck[]
  focusDeck(identity: AvatarDeckIdentity): Promise<AvatarCommandResult>
  isDeckBound(identity: AvatarDeckIdentity): boolean
  /** The Deck-side port of the Deck's open bound WebSocket, or null. */
  boundRemotePort(identity: AvatarDeckIdentity): number | null
  close(): Promise<void>
}

class AvatarRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>
  ) {
    super(String(body.error ?? 'invalid_request'))
  }
}

interface AvatarServerErrorEmitter {
  on(event: 'error', listener: (error: Error) => void): unknown
}

interface PendingAvatarCommand {
  resolve(result: AvatarCommandResult): void
  reject(error: Error): void
  timeout: ReturnType<typeof setTimeout>
}

export interface AvatarDeckSocket {
  readonly readyState: number
  send(data: string, callback?: (error?: Error) => void): void
  close(code: number, reason: string): void
  on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): unknown
  on(event: 'close', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export interface AvatarSocketHubOptions {
  isAttached(identity: AvatarDeckIdentity): boolean
  report: typeof reportError
  bindTimeoutMs: number
  commandResultTimeoutMs: number
}

export interface AvatarSocketHub {
  /** `remotePort` is the Deck-side TCP port of the upgraded connection, null when the transport has none. */
  accept(socket: AvatarDeckSocket, remotePort: number | null): void
  focusDeck(identity: AvatarDeckIdentity): Promise<AvatarCommandResult>
  detach(identity: AvatarDeckIdentity): void
  isDeckBound(identity: AvatarDeckIdentity): boolean
  boundRemotePort(identity: AvatarDeckIdentity): number | null
}

interface BoundAvatarSocket {
  ws: AvatarDeckSocket
  identity: AvatarDeckIdentity
  pending: Map<string, PendingAvatarCommand>
  remotePort: number | null
}

/**
 * The two ends of a bound Deck's WebSocket as netstat names them, Deck side
 * first: the owner read on the local end is the Deck process. Null while the
 * Deck has no open bound socket.
 */
export function deckSocketEndpoints(
  server: Pick<AvatarServer, 'port' | 'boundRemotePort'>,
  identity: AvatarDeckIdentity
): { local: TcpEndpoint; remote: TcpEndpoint } | null {
  const deckPort = server.boundRemotePort(identity)
  if (deckPort === null) return null
  return { local: { address: '127.0.0.1', port: deckPort }, remote: { address: '127.0.0.1', port: server.port } }
}

export function observeAvatarRequest(request: Promise<void>, report: typeof reportError): void {
  void request.catch((error: unknown) => report('avatar-server', 'request failed', error))
}

export function installAvatarServerErrorReporter(server: AvatarServerErrorEmitter, report: typeof reportError): void {
  server.on('error', (error) => report('avatar-server', 'server error', error))
}

function deckKey(identity: AvatarDeckIdentity): string {
  return JSON.stringify([identity.deckRunId, identity.broker_url])
}

function sameBearerToken(authorization: string | undefined, token: string): boolean {
  if (!authorization?.startsWith('Bearer ')) return false
  const provided = Buffer.from(authorization.slice('Bearer '.length))
  const expected = Buffer.from(token)
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

/** An explicit length: without it, bun 1.4.0 hands the client of a refused request a body it cannot parse. */
function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  response.end(payload)
}

function contentLengthExceedsLimit(request: IncomingMessage): boolean {
  const header = request.headers['content-length']
  if (typeof header !== 'string') return false
  const length = Number(header)
  return Number.isSafeInteger(length) && length > MAX_AVATAR_REQUEST_BYTES
}

function readJson(request: IncomingMessage): Promise<unknown> {
  if (contentLengthExceedsLimit(request)) {
    return Promise.reject(new AvatarRequestError(413, { error: 'payload_too_large' }))
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      reject(error)
    }

    request.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_AVATAR_REQUEST_BYTES) {
        fail(new AvatarRequestError(413, { error: 'payload_too_large' }))
        return
      }
      chunks.push(chunk)
    })
    request.on('aborted', () => fail(new AvatarRequestError(400, { error: 'invalid_request' })))
    request.on('error', fail)
    request.on('end', () => {
      if (settled) return
      try {
        settled = true
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
      } catch {
        reject(new AvatarRequestError(400, { error: 'invalid_request' }))
      }
    })
  })
}

export async function startAvatarServer(options: AvatarServerOptions): Promise<AvatarServer> {
  const attached = new Map<string, AvatarAttachedDeck>()
  const sockets = new Set<WebSocket>()
  const report = options.report ?? reportError
  const bindTimeoutMs = options.bindTimeoutMs ?? AVATAR_BIND_TIMEOUT_MS
  const commandResultTimeoutMs = options.commandResultTimeoutMs ?? AVATAR_COMMAND_RESULT_TIMEOUT_MS

  const reject = (response: ServerResponse, status: number, body: Record<string, unknown>, message: string): void => {
    report('avatar-server', message)
    sendJson(response, status, body)
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.headers.origin !== undefined) {
      reject(response, 403, { error: 'origin_not_allowed' }, 'rejected Avatar request with an Origin header')
      return
    }
    if (!sameBearerToken(request.headers.authorization, options.token)) {
      reject(response, 401, { error: 'unauthorized' }, 'rejected unauthorized Avatar request')
      return
    }
    if (request.method !== 'POST') {
      reject(response, 404, { error: 'not_found' }, 'rejected Avatar request for an unknown route')
      return
    }

    try {
      const body = await readJson(request)
      if (request.url === '/attach') {
        const attach = parseAvatarAttachRequest(body)
        const key = deckKey(attach)
        if (!attached.has(key) && attached.size >= MAX_AVATAR_ATTACHMENTS) {
          reject(response, 409, { error: 'too_many_attached_decks' }, 'rejected Avatar attachment limit')
          return
        }
        if (!attached.has(key)) {
          options.state.receiveSnapshot({
            identity: { deckRunId: attach.deckRunId, broker_url: attach.broker_url },
            counters: { working: 0, idle: 0, unknown: 0, waiting: 0, exited: 0, rateLimited: 0 },
            unread: 0
          })
        }
        attached.set(key, { ...attach })
        sendJson(response, 200, {
          ok: true,
          protocol_version: AVATAR_PROTOCOL_VERSION,
          avatarRunId: options.avatarRunId
        })
        return
      }
      if (request.url === '/detach') {
        const identity = parseAvatarDetachRequest(body)
        const key = deckKey(identity)
        const detached = attached.delete(key)
        hub.detach(identity)
        options.state.detach(identity)
        sendJson(response, 200, { ok: true, detached })
        return
      }
      if (request.url === '/state') {
        const snapshot = parseAvatarStateRequest(body)
        if (!attached.has(deckKey(snapshot.identity))) {
          reject(response, 409, { error: 'deck_not_attached' }, 'rejected state for an unattached Deck')
          return
        }
        options.state.receiveSnapshot(snapshot)
        sendJson(response, 200, { ok: true })
        return
      }
      reject(response, 404, { error: 'not_found' }, 'rejected Avatar request for an unknown route')
    } catch (error) {
      if (error instanceof AvatarProtocolError && error.code === 'unsupported_protocol_version') {
        reject(
          response,
          409,
          {
            error: 'unsupported_protocol_version',
            protocol_version: AVATAR_PROTOCOL_VERSION,
            supported_protocol_versions: [AVATAR_PROTOCOL_VERSION],
            avatarRunId: options.avatarRunId
          },
          error.message
        )
        return
      }
      if (error instanceof AvatarRequestError) {
        reject(response, error.status, error.body, error.message)
        return
      }
      reject(response, 400, { error: 'invalid_request' }, error instanceof Error ? error.message : 'invalid Avatar request')
    }
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_AVATAR_REQUEST_BYTES })
  const hub = createAvatarSocketHub({
    isAttached: (identity) => attached.has(deckKey(identity)),
    report,
    bindTimeoutMs,
    commandResultTimeoutMs
  })

  const server: Server = createServer(
    { cert: options.certificate.certPem, key: options.certificate.keyPem },
    (request, response) => {
      observeAvatarRequest(handle(request, response), report)
    }
  )
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (request.url !== '/ws') {
      report('avatar-server', 'rejected Avatar WebSocket request for an unknown route')
      socket.destroy()
      return
    }
    if (request.headers.origin !== undefined) {
      report('avatar-server', 'rejected Avatar WebSocket request with an Origin header')
      socket.destroy()
      return
    }
    if (!sameBearerToken(request.headers.authorization, options.token)) {
      report('avatar-server', 'rejected unauthorized Avatar WebSocket request')
      socket.destroy()
      return
    }
    const remotePort = (socket as Duplex & { remotePort?: number }).remotePort ?? null
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      sockets.add(webSocket)
      webSocket.on('close', () => sockets.delete(webSocket))
      hub.accept(webSocket, remotePort)
    })
  })

  return new Promise((resolve, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      installAvatarServerErrorReporter(server, report)
      const address = server.address()
      if (!address || typeof address === 'string') {
        rejectListen(new Error('Avatar server has no TCP address'))
        return
      }
      resolve({
        host: address.address,
        port: address.port,
        attachedDecks: () => [...attached.values()].map((deck) => ({ ...deck })),
        focusDeck: hub.focusDeck,
        isDeckBound: hub.isDeckBound,
        boundRemotePort: hub.boundRemotePort,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            for (const socket of sockets) socket.terminate()
            server.close((serverError) => {
              wss.close((wssError) => {
                const error = serverError ?? wssError
                if (error) rejectClose(error)
                else resolveClose()
              })
            })
          })
      })
    })
  })
}

export function createAvatarSocketHub(options: AvatarSocketHubOptions): AvatarSocketHub {
  const boundSockets = new Map<string, BoundAvatarSocket>()
  const { report, bindTimeoutMs, commandResultTimeoutMs } = options

  const releaseBoundSocket = (bound: BoundAvatarSocket, error: Error): void => {
    if (boundSockets.get(deckKey(bound.identity)) === bound) {
      boundSockets.delete(deckKey(bound.identity))
    }
    for (const pending of bound.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    bound.pending.clear()
  }

  const unbind = (bound: BoundAvatarSocket, code: number, reason: string, error: Error): void => {
    releaseBoundSocket(bound, error)
    bound.ws.close(code, reason)
  }

  const detach = (identity: AvatarDeckIdentity): void => {
    const bound = boundSockets.get(deckKey(identity))
    if (bound) unbind(bound, 4410, 'detached', new Error('Avatar Deck detached'))
  }

  const closeSocket = (socket: AvatarDeckSocket, code: number, reason: string, message: string, error?: unknown): void => {
    report('avatar-server', message, error)
    socket.close(code, reason)
  }

  const accept = (socket: AvatarDeckSocket, remotePort: number | null): void => {
    let bound: BoundAvatarSocket | undefined
    const bindDeadline = setTimeout(() => {
      if (!bound) closeSocket(socket, 4408, 'bind timeout', 'rejected Avatar WebSocket bind timeout')
    }, bindTimeoutMs)

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        closeSocket(socket, 4400, 'invalid frame', 'rejected invalid Avatar WebSocket frame')
        return
      }

      let input: unknown
      try {
        const text = Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : data instanceof ArrayBuffer
            ? Buffer.from(data).toString('utf8')
            : data.toString('utf8')
        input = JSON.parse(text) as unknown
      } catch (error) {
        closeSocket(socket, 4400, 'invalid frame', 'rejected invalid Avatar WebSocket frame', error)
        return
      }

      if (!bound && input && typeof input === 'object' && !Array.isArray(input) && (input as { type?: unknown }).type === 'command') {
        closeSocket(socket, 4401, 'bind required', 'rejected Avatar command before bind')
        return
      }

      let frame: ReturnType<typeof parseAvatarDeckFrame>
      try {
        frame = parseAvatarDeckFrame(input)
      } catch (error) {
        const closeCode = error instanceof AvatarProtocolError && error.code === 'unsupported_protocol_version' ? 4409 : 4400
        closeSocket(
          socket,
          closeCode,
          closeCode === 4409 ? 'unsupported version' : 'invalid frame',
          error instanceof Error ? error.message : 'rejected invalid Avatar WebSocket frame',
          error
        )
        return
      }

      if (!bound) {
        if (frame.type !== 'bind') {
          closeSocket(socket, 4401, 'bind required', 'rejected Avatar WebSocket frame before bind')
          return
        }
        if (!options.isAttached(frame)) {
          closeSocket(socket, 4403, 'Deck not attached', 'rejected Avatar WebSocket bind for an unattached Deck')
          return
        }
        clearTimeout(bindDeadline)
        bound = {
          ws: socket,
          identity: { deckRunId: frame.deckRunId, broker_url: frame.broker_url },
          pending: new Map(),
          remotePort
        }
        const previous = boundSockets.get(deckKey(bound.identity))
        if (previous) {
          report('avatar-server', 'replaced the Avatar WebSocket of a Deck that bound again')
          unbind(previous, 4410, 'superseded', new Error('Avatar Deck WebSocket superseded'))
        }
        boundSockets.set(deckKey(bound.identity), bound)
        socket.send(JSON.stringify({ type: 'bound' }))
        return
      }

      if (frame.type !== 'command_result') {
        closeSocket(socket, 4400, 'invalid frame', 'rejected a second Avatar WebSocket bind on a bound socket')
        return
      }
      const pending = bound.pending.get(frame.requestId)
      if (!pending) {
        report('avatar-server', 'ignored an Avatar command result with an unknown or expired requestId')
        return
      }
      bound.pending.delete(frame.requestId)
      clearTimeout(pending.timeout)
      const result: AvatarCommandResult = {
        requestId: frame.requestId,
        ok: frame.ok,
        ...(frame.error === undefined ? {} : { error: frame.error })
      }
      pending.resolve(result)
    })

    socket.on('close', () => {
      clearTimeout(bindDeadline)
      if (bound) releaseBoundSocket(bound, new Error('Avatar Deck WebSocket disconnected'))
    })
    socket.on('error', (error) => report('avatar-server', 'Avatar WebSocket error', error))
  }

  const focusDeck = (identity: AvatarDeckIdentity): Promise<AvatarCommandResult> => {
    if (!options.isAttached(identity)) return Promise.reject(new Error('Avatar Deck is not attached'))
    const bound = boundSockets.get(deckKey(identity))
    if (!bound || bound.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Avatar Deck is not bound'))
    }

    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        bound.pending.delete(requestId)
        reject(new Error('Avatar command result timed out'))
      }, commandResultTimeoutMs)
      bound.pending.set(requestId, { resolve, reject, timeout })
      try {
        bound.ws.send(
          JSON.stringify({ type: 'command', requestId, command: 'focus', deckRunId: identity.deckRunId, broker_url: identity.broker_url }),
          (error) => {
            if (!error) return
            const pending = bound.pending.get(requestId)
            if (!pending) return
            bound.pending.delete(requestId)
            clearTimeout(pending.timeout)
            pending.reject(error)
          }
        )
      } catch (error) {
        const pending = bound.pending.get(requestId)
        if (!pending) return
        bound.pending.delete(requestId)
        clearTimeout(pending.timeout)
        pending.reject(error instanceof Error ? error : new Error('Avatar command could not be sent'))
      }
    })
  }

  const isDeckBound = (identity: AvatarDeckIdentity): boolean =>
    boundSockets.get(deckKey(identity))?.ws.readyState === WebSocket.OPEN

  const boundRemotePort = (identity: AvatarDeckIdentity): number | null => {
    const bound = boundSockets.get(deckKey(identity))
    return bound && bound.ws.readyState === WebSocket.OPEN ? bound.remotePort : null
  }

  return { accept, focusDeck, detach, isDeckBound, boundRemotePort }
}
