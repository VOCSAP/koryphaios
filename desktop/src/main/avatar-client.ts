import { request } from 'node:https'
import type { RawData } from 'ws'
import {
  AVATAR_PROTOCOL_VERSION,
  parseAvatarServerFrame,
  unsupportedAvatarCommandRequestId,
  type AvatarAttachRequest
} from '../shared/avatar-protocol'
import { AVATAR_HEARTBEAT_MS, type AvatarDeckIdentity } from '../shared/avatar-state'
import type { SessionRuntime } from '../shared/types'
import { projectAvatarCounters } from './avatar-counters'
import type { AvatarRendezvous } from './avatar-registry'
import { avatarHttpsRequestOptions, connectAvatarWss } from './avatar-transport'
import { logInfo, reportError } from './log'

export const AVATAR_REQUEST_TIMEOUT_MS = 3_000
export const AVATAR_FOCUS_TIMEOUT_MS = 2_000

export interface AvatarClientSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: 'open', listener: () => void): unknown
  on(event: 'message', listener: (data: RawData) => void): unknown
  on(event: 'close', listener: (code: number) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export type AvatarPost = (rendezvous: AvatarRendezvous, path: string, body: unknown) => Promise<number>

export interface AvatarClientOptions {
  /** Re-read at every sync for its name; deckRunId and broker_url are taken once, at creation. */
  deck(): Omit<AvatarAttachRequest, 'protocol_version'>
  autoAttachEnabled(): boolean
  rendezvous(): AvatarRendezvous | null
  sessions(): SessionRuntime[]
  focus(): Promise<void>
  post?: AvatarPost
  connect?: (rendezvous: AvatarRendezvous) => AvatarClientSocket
  every?: (ms: number, tick: () => void) => () => void
  after?: (ms: number, fire: () => void) => () => void
  report?: typeof reportError
  info?: typeof logInfo
}

export interface AvatarClient {
  start(): boolean
  sessionsChanged(): void
  stop(): Promise<void>
}

export function postAvatarJson(rendezvous: AvatarRendezvous, path: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ ...avatarHttpsRequestOptions(rendezvous, path), method: 'POST' }, (response) => {
      response.resume()
      response.once('end', () => resolve(response.statusCode ?? 0))
      response.once('error', reject)
    })
    outgoing.once('error', reject)
    outgoing.setTimeout(AVATAR_REQUEST_TIMEOUT_MS, () => outgoing.destroy(new Error(`Avatar ${path} timed out`)))
    outgoing.setHeader('content-type', 'application/json')
    outgoing.end(JSON.stringify(body))
  })
}

function everyInterval(ms: number, tick: () => void): () => void {
  const timer = setInterval(tick, ms)
  return () => clearInterval(timer)
}

function afterTimeout(ms: number, fire: () => void): () => void {
  const timer = setTimeout(fire, ms)
  return () => clearTimeout(timer)
}

interface FailureEpisode {
  fail(message: string, error?: unknown): void
  ok(): void
}

function failureEpisode(report: typeof reportError, info: typeof logInfo, restored: string): FailureEpisode {
  let failing: string | null = null
  return {
    fail(message, error) {
      if (failing === message) return
      failing = message
      report('avatar-client', message, error)
    },
    ok() {
      if (failing === null) return
      failing = null
      info('avatar-client', restored)
    }
  }
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return data.toString('utf8')
}

export function createAvatarClient(options: AvatarClientOptions): AvatarClient {
  const report = options.report ?? reportError
  const post = options.post ?? postAvatarJson
  const connect = options.connect ?? ((rendezvous: AvatarRendezvous) => connectAvatarWss(rendezvous, '/ws'))
  const every = options.every ?? everyInterval
  const after = options.after ?? afterTimeout
  const info = options.info ?? logInfo
  const link = failureEpisode(report, info, 'Avatar link restored')
  const webSocket = failureEpisode(report, info, 'Avatar WebSocket restored')
  const initialDeck = options.deck()
  const identity: AvatarDeckIdentity = { deckRunId: initialDeck.deckRunId, broker_url: initialDeck.broker_url }
  let attachedRunId: string | null = null
  let attachedName: string | null = null
  let socket: AvatarClientSocket | null = null
  let lastPushed: string | null = null
  let stopHeartbeat: (() => void) | null = null
  let chain = Promise.resolve()

  const enqueue = (work: () => Promise<void>): Promise<void> => {
    chain = chain.then(work).catch((error: unknown) => {
      link.fail('Avatar link failed', error)
    })
    return chain
  }

  const reply = (current: AvatarClientSocket, requestId: string, ok: boolean, error?: string): void => {
    if (socket !== current) return
    current.send(JSON.stringify({ type: 'command_result', requestId, ok, ...(error === undefined ? {} : { error }) }))
  }

  const openSocket = (rendezvous: AvatarRendezvous): void => {
    const current = connect(rendezvous)
    let bound = false
    socket = current
    current.on('open', () => {
      current.send(JSON.stringify({ type: 'bind', protocol_version: AVATAR_PROTOCOL_VERSION, ...identity }))
    })
    current.on('message', (data) => {
      let input: unknown
      let frame: ReturnType<typeof parseAvatarServerFrame>
      try {
        input = JSON.parse(rawText(data)) as unknown
        frame = parseAvatarServerFrame(input)
      } catch (error) {
        report('avatar-client', 'rejected an invalid Avatar frame', error)
        const unsupported = bound ? unsupportedAvatarCommandRequestId(input) : null
        if (unsupported) reply(current, unsupported, false, 'unsupported_command')
        return
      }
      if (frame.type === 'bound') {
        bound = true
        webSocket.ok()
        return
      }
      if (!bound) {
        report('avatar-client', 'rejected an Avatar command received before bound')
        return
      }
      if (frame.deckRunId !== identity.deckRunId || frame.broker_url !== identity.broker_url) {
        report('avatar-client', 'rejected an Avatar command addressed to another Deck')
        reply(current, frame.requestId, false, 'wrong_deck')
        return
      }
      const { requestId } = frame
      let answered = false
      const answer = (ok: boolean, error?: string): void => {
        if (answered) return
        answered = true
        cancelDeadline()
        reply(current, requestId, ok, error)
      }
      const cancelDeadline = after(AVATAR_FOCUS_TIMEOUT_MS, () => {
        report('avatar-client', `Avatar focus command timed out after ${AVATAR_FOCUS_TIMEOUT_MS} ms`)
        answer(false, 'focus_timeout')
      })
      Promise.resolve().then(() => options.focus()).then(
        () => answer(true),
        (error: unknown) => {
          report('avatar-client', 'Avatar focus command failed', error)
          answer(false, 'focus_failed')
        }
      )
    })
    current.on('close', (code) => {
      if (socket === current) socket = null
      if (!bound && code >= 4000) webSocket.fail(`Avatar closed the WebSocket before bound with code ${code}`)
    })
    current.on('error', (error) => webSocket.fail('Avatar WebSocket error', error))
  }

  const sync = async (force: boolean): Promise<void> => {
    if (!stopHeartbeat) return
    const rendezvous = options.rendezvous()
    if (!rendezvous) {
      attachedRunId = null
      return
    }
    const deck = { ...options.deck(), ...identity }
    const avatarChanged = attachedRunId !== rendezvous.avatarRunId
    if (avatarChanged || deck.deckName !== attachedName) {
      const status = await post(rendezvous, '/attach', { protocol_version: AVATAR_PROTOCOL_VERSION, ...deck })
      if (status !== 200) {
        link.fail(`Avatar refused the attach with status ${status}`)
        return
      }
      attachedName = deck.deckName
      if (avatarChanged) {
        attachedRunId = rendezvous.avatarRunId
        lastPushed = null
        const previous = socket
        socket = null
        previous?.close(1000, 'Avatar restarted')
      }
    }
    if (!socket) openSocket(rendezvous)

    const snapshot = { identity, ...projectAvatarCounters(options.sessions()) }
    const serialized = JSON.stringify(snapshot)
    if (!force && serialized === lastPushed) return
    const status = await post(rendezvous, '/state', snapshot)
    if (status !== 200) {
      if (status === 409) attachedRunId = null
      link.fail(`Avatar refused the state with status ${status}`)
      return
    }
    lastPushed = serialized
    link.ok()
  }

  return {
    start() {
      if (!options.autoAttachEnabled()) return false
      if (stopHeartbeat) return true
      stopHeartbeat = every(AVATAR_HEARTBEAT_MS, () => void enqueue(() => sync(true)))
      void enqueue(() => sync(true))
      return true
    },
    sessionsChanged() {
      if (stopHeartbeat) void enqueue(() => sync(false))
    },
    stop() {
      stopHeartbeat?.()
      stopHeartbeat = null
      return enqueue(async () => {
        const closing = socket
        socket = null
        closing?.close(1000, 'Deck detaching')
        const rendezvous = options.rendezvous()
        if (!rendezvous || attachedRunId !== rendezvous.avatarRunId) return
        attachedRunId = null
        const status = await post(rendezvous, '/detach', identity)
        if (status !== 200) report('avatar-client', `Avatar refused the detach with status ${status}`)
      })
    }
  }
}
