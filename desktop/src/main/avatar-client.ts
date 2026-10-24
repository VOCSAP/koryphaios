import { request } from 'node:https'
import type { RawData } from 'ws'
import {
  AVATAR_CAPABILITIES,
  AVATAR_PROTOCOL_VERSION,
  MAX_AVATAR_REQUEST_BYTES,
  parseAvatarServerFrame,
  unsupportedAvatarCommandRequestId,
  type AvatarAttachRequest,
  type AvatarCapability,
  type AvatarDeckContext
} from '../shared/avatar-protocol'
import { AVATAR_HEARTBEAT_MS, type AvatarDeckIdentity } from '../shared/avatar-state'
import type { HookAwaitRow } from '../shared/hook-await'
import type { SessionRuntime } from '../shared/types'
import { isAvatarCounter, projectAvatarCounters } from './avatar-counters'
import type { AvatarRendezvous } from './avatar-registry'
import { avatarHttpsRequestOptions, connectAvatarWss } from './avatar-transport'
import { logInfo, logWarn, reportError } from './log'

export const AVATAR_REQUEST_TIMEOUT_MS = 3_000
export const AVATAR_COMMAND_TIMEOUT_MS = 2_000

export interface AvatarClientSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: 'open', listener: () => void): unknown
  on(event: 'message', listener: (data: RawData) => void): unknown
  on(event: 'close', listener: (code: number) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export interface AvatarPostResponse {
  status: number
  body: Record<string, unknown> | null
}

export type AvatarPostResult = number | AvatarPostResponse
export type AvatarPost = (rendezvous: AvatarRendezvous, path: string, body: unknown) => Promise<AvatarPostResult>

export interface AvatarClientOptions {
  /** Re-read at every sync so the attachment follows the current Deck scope. */
  deck(): Omit<AvatarAttachRequest, 'protocol_version'>
  autoAttachEnabled(): boolean
  rendezvous(): AvatarRendezvous | null
  sessions(): SessionRuntime[]
  /** The last pending-approvals list of this Deck's broker; absent reads as none. */
  pendingApprovals?(): readonly HookAwaitRow[]
  /** Unread operator inbox messages; absent reads as zero. */
  inboxUnread?(): number
  focus(): Promise<void>
  openQuestion(): Promise<void>
  post?: AvatarPost
  connect?: (rendezvous: AvatarRendezvous) => AvatarClientSocket
  every?: (ms: number, tick: () => void) => () => void
  after?: (ms: number, fire: () => void) => () => void
  report?: typeof reportError
  info?: typeof logInfo
  warn?: typeof logWarn
}

export interface AvatarClient {
  start(): boolean
  sessionsChanged(): void
  scopeChanged(): void
  stop(): Promise<void>
}

export function postAvatarJson(rendezvous: AvatarRendezvous, path: string, body: unknown): Promise<AvatarPostResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ ...avatarHttpsRequestOptions(rendezvous, path), method: 'POST' }, (response) => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_AVATAR_REQUEST_BYTES) {
          response.destroy(new Error(`Avatar ${path} response payload_too_large`))
          return
        }
        chunks.push(chunk)
      })
      response.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        try {
          const value = JSON.parse(text) as unknown
          const parsed = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
          resolve({ status: response.statusCode ?? 0, body: parsed })
        } catch {
          resolve({ status: response.statusCode ?? 0, body: null })
        }
      })
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

function assertNever(value: never): never {
  throw new Error(`Unclassified Avatar command: ${JSON.stringify(value)}`)
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return data.toString('utf8')
}

function postStatus(result: AvatarPostResult): number {
  return typeof result === 'number' ? result : result.status
}

function negotiatedCapabilities(result: AvatarPostResult): readonly AvatarCapability[] {
  if (typeof result === 'number') return []
  const capabilities = result.body?.capabilities
  if (!Array.isArray(capabilities)) return []
  return capabilities.filter((capability): capability is AvatarCapability => (AVATAR_CAPABILITIES as readonly unknown[]).includes(capability))
}

function attachmentKey(identity: AvatarDeckIdentity, context: AvatarDeckContext | undefined): string {
  return JSON.stringify([identity.deckRunId, identity.broker_url, context?.group_id, context?.project_key, context?.scope_generation])
}

export function createAvatarClient(options: AvatarClientOptions): AvatarClient {
  const report = options.report ?? reportError
  const post = options.post ?? postAvatarJson
  const connect = options.connect ?? ((rendezvous: AvatarRendezvous) => connectAvatarWss(rendezvous, '/ws'))
  const every = options.every ?? everyInterval
  const after = options.after ?? afterTimeout
  const info = options.info ?? logInfo
  const warn = options.warn ?? logWarn
  const link = failureEpisode(report, info, 'Avatar link restored')
  const webSocket = failureEpisode(report, info, 'Avatar WebSocket restored')
  const unreadInput = failureEpisode(report, info, 'Inbox unread count valid again')
  let attached: { avatarRunId: string; identity: AvatarDeckIdentity; key: string; name: string } | null = null
  let socket: AvatarClientSocket | null = null
  let lastPushed: string | null = null
  let stopHeartbeat: (() => void) | null = null
  let scopeEpoch = 0
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

  const openSocket = (rendezvous: AvatarRendezvous, identity: AvatarDeckIdentity): void => {
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
      const { requestId, command } = frame
      let answered = false
      const answer = (ok: boolean, error?: string): void => {
        if (answered) return
        answered = true
        cancelDeadline()
        reply(current, requestId, ok, error)
      }
      const cancelDeadline = after(AVATAR_COMMAND_TIMEOUT_MS, () => {
        report('avatar-client', `Avatar ${command} command timed out after ${AVATAR_COMMAND_TIMEOUT_MS} ms`)
        answer(false, `${command}_timeout`)
      })
      const run = (): Promise<void> => {
        switch (command) {
          case 'focus':
            return options.focus()
          case 'open_question':
            return options.openQuestion()
          default:
            return assertNever(command)
        }
      }
      Promise.resolve().then(run).then(
        () => answer(true),
        (error: unknown) => {
          report('avatar-client', `Avatar ${command} command failed`, error)
          answer(false, `${command}_failed`)
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
    const epoch = scopeEpoch
    const rendezvous = options.rendezvous()
    if (!rendezvous) {
      attached = null
      return
    }
    const deck = options.deck()
    const identity: AvatarDeckIdentity = { deckRunId: deck.deckRunId, broker_url: deck.broker_url }
    const key = attachmentKey(identity, deck.context)
    const contextFreeKey = attachmentKey(identity, undefined)
    const needsAttach =
      attached === null ||
      attached.avatarRunId !== rendezvous.avatarRunId ||
      attached.key !== key ||
      attached.name !== deck.deckName
    if (needsAttach) {
      const previousAttachment = attached
      if (
        previousAttachment &&
        previousAttachment.avatarRunId === rendezvous.avatarRunId &&
        previousAttachment.identity.broker_url !== identity.broker_url
      ) {
        const detachResult = await post(rendezvous, '/detach', previousAttachment.identity)
        if (epoch !== scopeEpoch) return
        const detachStatus = postStatus(detachResult)
        if (detachStatus !== 200) report('avatar-client', `Avatar refused the detach with status ${detachStatus}`)
      }
      const { context, ...attachDeck } = deck
      const capabilities = context === undefined ? [] : AVATAR_CAPABILITIES
      const attachResult = await post(rendezvous, '/attach', {
        protocol_version: AVATAR_PROTOCOL_VERSION,
        ...attachDeck,
        ...(capabilities.length === 0 ? {} : { capabilities })
      })
      const attachStatus = postStatus(attachResult)
      if (attachStatus !== 200) {
        link.fail(`Avatar refused the attach with status ${attachStatus}`)
        return
      }
      attached = { avatarRunId: rendezvous.avatarRunId, identity, key: context === undefined ? key : contextFreeKey, name: deck.deckName }
      if (epoch !== scopeEpoch) return
      if (context && negotiatedCapabilities(attachResult).includes('a3_context')) {
        const contextResult = await post(rendezvous, '/attach', {
          protocol_version: AVATAR_PROTOCOL_VERSION,
          ...attachDeck,
          capabilities,
          context
        })
        if (epoch !== scopeEpoch) return
        const contextStatus = postStatus(contextResult)
        if (contextStatus !== 200) {
          link.fail(`Avatar refused the attach with status ${contextStatus}`)
          return
        }
      }
      const avatarChanged = previousAttachment?.avatarRunId !== rendezvous.avatarRunId
      const identityChanged = previousAttachment !== null && previousAttachment.identity.broker_url !== identity.broker_url
      attached = { avatarRunId: rendezvous.avatarRunId, identity, key, name: deck.deckName }
      lastPushed = null
      if (avatarChanged || identityChanged) {
        const previousSocket = socket
        socket = null
        previousSocket?.close(1000, avatarChanged ? 'Avatar restarted' : 'Deck scope changed')
      }
    }
    if (!socket) openSocket(rendezvous, identity)

    const unread = options.inboxUnread?.() ?? 0
    if (isAvatarCounter(unread)) unreadInput.ok()
    const snapshot = {
      identity,
      ...projectAvatarCounters(options.sessions(), options.pendingApprovals?.() ?? [], unread, (value) =>
        unreadInput.fail(`Invalid inbox unread count (${String(value)}), bounded before the Avatar snapshot`)
      )
    }
    const serialized = JSON.stringify(snapshot)
    if (!force && serialized === lastPushed) return
    const stateResult = await post(rendezvous, '/state', snapshot)
    if (epoch !== scopeEpoch) return
    const stateStatus = postStatus(stateResult)
    if (stateStatus !== 200) {
      if (stateStatus === 409) attached = null
      link.fail(`Avatar refused the state with status ${stateStatus}`)
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
    scopeChanged() {
      scopeEpoch += 1
      lastPushed = null
      const previousSocket = socket
      socket = null
      previousSocket?.close(1000, 'Deck scope changed')
      if (stopHeartbeat) void enqueue(() => sync(true))
    },
    stop() {
      stopHeartbeat?.()
      stopHeartbeat = null
      return enqueue(async () => {
        const closing = socket
        socket = null
        closing?.close(1000, 'Deck detaching')
        const rendezvous = options.rendezvous()
        if (!rendezvous || !attached) return
        if (attached.avatarRunId !== rendezvous.avatarRunId) {
          warn('avatar-client', 'Avatar detach abandoned because its run changed')
          return
        }
        const identity = attached.identity
        attached = null
        const result = await post(rendezvous, '/detach', identity)
        const status = postStatus(result)
        if (status !== 200) report('avatar-client', `Avatar refused the detach with status ${status}`)
        else info('avatar-client', 'Avatar detached')
      })
    }
  }
}
