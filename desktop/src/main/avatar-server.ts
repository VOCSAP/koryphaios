import { timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  AVATAR_PROTOCOL_VERSION,
  AvatarProtocolError,
  MAX_AVATAR_ATTACHMENTS,
  parseAvatarAttachRequest,
  parseAvatarDetachRequest,
  parseAvatarStateRequest,
  type AvatarAttachRequest
} from '../shared/avatar-protocol'
import type { AvatarRunCertificate } from './avatar-certificate'
import { AvatarState, type AvatarDeckIdentity } from '../shared/avatar-state'
import { reportError } from './log'

export const MAX_AVATAR_REQUEST_BYTES = 64 * 1024

export interface AvatarServerOptions {
  avatarRunId: string
  certificate: AvatarRunCertificate
  state: AvatarState
  token: string
  port?: number
  report?: typeof reportError
}

export interface AvatarAttachedDeck extends AvatarAttachRequest {}

export interface AvatarServer {
  readonly host: string
  readonly port: number
  attachedDecks(): AvatarAttachedDeck[]
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

function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
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
  const report = options.report ?? reportError

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

  const server: Server = createServer(
    { cert: options.certificate.certPem, key: options.certificate.keyPem },
    (request, response) => {
      observeAvatarRequest(handle(request, response), report)
    }
  )

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
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.close((error) => (error ? rejectClose(error) : resolveClose()))
          })
      })
    })
  })
}
