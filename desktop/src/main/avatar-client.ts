import { request } from 'node:https'
import type { RawData } from 'ws'
import {
  AVATAR_CAPABILITIES,
  AVATAR_NOTIFICATION_LEASE_MS,
  AVATAR_PROTOCOL_VERSION,
  MAX_AVATAR_REQUEST_BYTES,
  invalidInboxActionRequestId,
  parseAvatarServerFrame,
  unsupportedAvatarCommandRequestId,
  type AvatarAttachRequest,
  type AvatarCapability,
  type AvatarDeckContext,
  type AvatarNotificationStatusFrame
} from '../shared/avatar-protocol'
import { AVATAR_HEARTBEAT_MS, type AvatarDeckIdentity } from '../shared/avatar-state'
import type { HookAwaitRow } from '../shared/hook-await'
import type { SessionRuntime } from '../shared/types'
import { isAvatarCounter, projectAvatarCounters } from './avatar-counters'
import type { AvatarInboxAction, InboxOutcome, InboxRelayApproval } from '../shared/avatar-inbox-protocol'
import { createInboxPusher, type InboxActionResult, type InboxPusher, type InboxRelaySourcesInput } from './avatar-inbox-relay'
import type { AvatarRendezvous } from './avatar-registry'
import { shouldSuppressDeckNotification } from './avatar-notification-policy'
import { avatarHttpsRequestOptions, connectAvatarWss, type AvatarWssLimits } from './avatar-transport'
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
  /** The Courrier and the pending questions relayed to an Avatar that negotiated a3_inbox. */
  inbox?: AvatarInboxRelay
  now?: () => number
  /** Times the notification lease; a server date never decides it. */
  monotonicNow?: () => number
  post?: AvatarPost
  connect?: (rendezvous: AvatarRendezvous, limits?: AvatarWssLimits) => AvatarClientSocket
  every?: (ms: number, tick: () => void) => () => void
  after?: (ms: number, fire: () => void) => () => void
  report?: typeof reportError
  info?: typeof logInfo
  warn?: typeof logWarn
}

export interface AvatarInboxRelay {
  sources(): InboxRelaySourcesInput
  act(action: AvatarInboxAction, sent: ReadonlyMap<string, InboxRelayApproval>): Promise<InboxActionResult>
}

export interface AvatarClient {
  start(): boolean
  sessionsChanged(): void
  scopeChanged(): void
  inboxChanged(): void
  /** True while the Avatar vouches, by a fresh lease on the current binding, that it shows the alerts the Deck would send to the OS. */
  notificationsReplaced(): boolean
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

/** One WebSocket that negotiated a3_notify_replace; its sequence floor and lease live and die with it. */
interface NotificationBinding {
  socket: AvatarClientSocket
  avatarRunId: string
  identity: AvatarDeckIdentity
  generation: number
  attachmentKey: string
  lastSeq: number
  bound: boolean
}

function isNotificationStatusInput(input: unknown): boolean {
  return typeof input === 'object' && input !== null && (input as { type?: unknown }).type === 'notification_status'
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
  const connect = options.connect ?? ((rendezvous: AvatarRendezvous, limits?: AvatarWssLimits) => connectAvatarWss(rendezvous, '/ws', limits))
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const every = options.every ?? everyInterval
  const after = options.after ?? afterTimeout
  const info = options.info ?? logInfo
  const warn = options.warn ?? logWarn
  const link = failureEpisode(report, info, 'Avatar link restored')
  const webSocket = failureEpisode(report, info, 'Avatar WebSocket restored')
  const unreadInput = failureEpisode(report, info, 'Inbox unread count valid again')
  const now = options.now ?? Date.now
  let attached: {
    avatarRunId: string
    identity: AvatarDeckIdentity
    key: string
    name: string
    theme: AvatarAttachRequest['theme']
  } | null = null
  let socket: AvatarClientSocket | null = null
  let lastPushed: string | null = null
  let stopHeartbeat: (() => void) | null = null
  let scopeEpoch = 0
  let chain = Promise.resolve()
  let inboxGeneration: number | null = null
  let inboxSignals = false
  let pusher: { socket: AvatarClientSocket; generation: number; relay: InboxPusher } | null = null
  let notifyGeneration: number | null = null
  let binding: NotificationBinding | null = null
  let lease: { binding: NotificationBinding; receivedAt: number } | null = null

  const bindingIsCurrent = (current: NotificationBinding): boolean =>
    socket === current.socket &&
    notifyGeneration === current.generation &&
    attached !== null &&
    attached.avatarRunId === current.avatarRunId &&
    attached.key === current.attachmentKey

  const receiveStatus = (current: AvatarClientSocket, frame: AvatarNotificationStatusFrame): void => {
    const mine = binding
    if (!stopHeartbeat || socket !== current) return
    if (!mine || mine.socket !== current) {
      report('avatar-client', 'ignored a notification status on a socket that did not negotiate it')
      return
    }
    if (!mine.bound) {
      report('avatar-client', 'rejected a notification status received before bound')
      lease = null
      return
    }
    if (
      frame.avatarRunId !== mine.avatarRunId ||
      frame.deckRunId !== mine.identity.deckRunId ||
      frame.broker_url !== mine.identity.broker_url ||
      frame.scope_generation !== mine.generation ||
      !bindingIsCurrent(mine)
    ) {
      report('avatar-client', 'rejected a notification status that is not for the current binding')
      lease = null
      return
    }
    if (frame.seq <= mine.lastSeq) return
    mine.lastSeq = frame.seq
    lease = frame.replace ? { binding: mine, receivedAt: monotonicNow() } : null
  }

  const stopPusher = (current: AvatarClientSocket): void => {
    if (pusher?.socket !== current) return
    pusher.relay.stop()
    pusher = null
  }

  const enqueue = (work: () => Promise<void>): Promise<void> => {
    chain = chain.then(work).catch((error: unknown) => {
      lease = null
      link.fail('Avatar link failed', error)
    })
    return chain
  }

  const reply = (
    current: AvatarClientSocket,
    requestId: string,
    ok: boolean,
    error?: string,
    settled?: { outcome: InboxOutcome; reason?: string }
  ): void => {
    if (socket !== current) return
    current.send(
      JSON.stringify({
        type: 'command_result',
        requestId,
        ok,
        ...(error === undefined ? {} : { error }),
        ...(settled === undefined ? {} : settled)
      })
    )
  }

  const runInboxAction = (current: AvatarClientSocket, requestId: string, action: AvatarInboxAction): void => {
    const relay = pusher?.socket === current ? pusher.relay : null
    if (!relay || !options.inbox) {
      reply(current, requestId, false, 'unsupported_command')
      return
    }
    options.inbox.act(action, relay.sentApprovals()).then(
      (result) => {
        if ('error' in result) reply(current, requestId, false, result.error)
        else reply(current, requestId, true, undefined, result)
      },
      (error: unknown) => {
        report('avatar-client', `Avatar ${action.action} gesture failed`, error)
        reply(current, requestId, false, 'inbox_action_failed')
      }
    )
  }

  const openSocket = (rendezvous: AvatarRendezvous, identity: AvatarDeckIdentity): void => {
    const negotiatedGeneration = notifyGeneration
    const current =
      negotiatedGeneration === null ? connect(rendezvous) : connect(rendezvous, { maxPayload: MAX_AVATAR_REQUEST_BYTES })
    let bound = false
    socket = current
    lease = null
    binding =
      negotiatedGeneration === null || attached === null
        ? null
        : {
            socket: current,
            avatarRunId: rendezvous.avatarRunId,
            identity,
            generation: negotiatedGeneration,
            attachmentKey: attached.key,
            lastSeq: 0,
            bound: false
          }
    current.on('open', () => {
      current.send(JSON.stringify({ type: 'bind', protocol_version: AVATAR_PROTOCOL_VERSION, ...identity }))
    })
    current.on('message', (data) => {
      const text = rawText(data)
      const mine = binding?.socket === current ? binding : null
      if (mine && Buffer.byteLength(text) > MAX_AVATAR_REQUEST_BYTES) {
        report('avatar-client', 'rejected an oversize Avatar frame')
        if (socket === current) lease = null
        return
      }
      let input: unknown
      let frame: ReturnType<typeof parseAvatarServerFrame>
      try {
        input = JSON.parse(text) as unknown
        frame = parseAvatarServerFrame(input)
      } catch (error) {
        if (mine && socket === current && isNotificationStatusInput(input)) lease = null
        report('avatar-client', 'rejected an invalid Avatar frame', error)
        const unsupported = bound ? unsupportedAvatarCommandRequestId(input) : null
        if (unsupported) reply(current, unsupported, false, 'unsupported_command')
        const invalidInbox = bound ? invalidInboxActionRequestId(input) : null
        if (invalidInbox) {
          reply(current, invalidInbox, false, pusher?.socket === current ? 'invalid_inbox_action' : 'unsupported_command')
        }
        return
      }
      if (frame.type === 'notification_status') {
        receiveStatus(current, frame)
        return
      }
      if (frame.type === 'bound') {
        bound = true
        if (mine) mine.bound = true
        webSocket.ok()
        const inbox = options.inbox
        if (inbox && inboxGeneration !== null && socket === current) {
          stopPusher(current)
          pusher = {
            socket: current,
            generation: inboxGeneration,
            relay: createInboxPusher({
              identity,
              scopeGeneration: inboxGeneration,
              signals: inboxSignals,
              sources: () => inbox.sources(),
              send: (text) => current.send(text),
              after,
              now,
              report
            })
          }
        }
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
      if (frame.command === 'inbox_action') {
        runInboxAction(current, frame.requestId, frame.inbox)
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
      stopPusher(current)
      if (socket === current) socket = null
      if (binding?.socket === current) {
        binding = null
        lease = null
      }
      if (!bound && code >= 4000) webSocket.fail(`Avatar closed the WebSocket before bound with code ${code}`)
    })
    current.on('error', (error) => {
      if (binding?.socket === current) lease = null
      webSocket.fail('Avatar WebSocket error', error)
    })
  }

  const sync = async (force: boolean): Promise<void> => {
    if (!stopHeartbeat) return
    const epoch = scopeEpoch
    const rendezvous = options.rendezvous()
    if (!rendezvous) {
      attached = null
      binding = null
      lease = null
      return
    }
    const dropLease = (): void => {
      if (epoch === scopeEpoch) lease = null
    }
    const deck = options.deck()
    const identity: AvatarDeckIdentity = { deckRunId: deck.deckRunId, broker_url: deck.broker_url }
    const key = attachmentKey(identity, deck.context)
    const contextFreeKey = attachmentKey(identity, undefined)
    const needsAttach =
      attached === null ||
      attached.avatarRunId !== rendezvous.avatarRunId ||
      attached.key !== key ||
      attached.name !== deck.deckName ||
      attached.theme !== deck.theme
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
      const capabilities: readonly AvatarCapability[] =
        context === undefined
          ? []
          : options.inbox
            ? AVATAR_CAPABILITIES
            : AVATAR_CAPABILITIES.filter((c) => c === 'a3_context')
      let negotiatedSignals = false
      let negotiatedInbox: number | null = null
      let negotiatedNotify: number | null = null
      const attachResult = await post(rendezvous, '/attach', {
        protocol_version: AVATAR_PROTOCOL_VERSION,
        ...attachDeck,
        ...(capabilities.length === 0 ? {} : { capabilities })
      })
      const attachStatus = postStatus(attachResult)
      if (attachStatus !== 200) {
        dropLease()
        link.fail(`Avatar refused the attach with status ${attachStatus}`)
        return
      }
      attached = {
        avatarRunId: rendezvous.avatarRunId,
        identity,
        key: context === undefined ? key : contextFreeKey,
        name: deck.deckName,
        theme: deck.theme
      }
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
          dropLease()
          link.fail(`Avatar refused the attach with status ${contextStatus}`)
          return
        }
        const negotiated = negotiatedCapabilities(contextResult)
        if (negotiated.includes('a3_inbox')) negotiatedInbox = context.scope_generation
        negotiatedSignals = negotiated.includes('a3_inbox_signals')
        if (negotiated.includes('a3_inbox') && negotiated.includes('a3_notify_replace')) negotiatedNotify = context.scope_generation
      }
      const avatarChanged = previousAttachment?.avatarRunId !== rendezvous.avatarRunId
      const identityChanged = previousAttachment !== null && previousAttachment.identity.broker_url !== identity.broker_url
      const inboxChanged = negotiatedInbox !== inboxGeneration
      const renegotiatesNotify = (negotiatedNotify !== null || notifyGeneration !== null) && socket !== null
      attached = { avatarRunId: rendezvous.avatarRunId, identity, key, name: deck.deckName, theme: deck.theme }
      inboxGeneration = negotiatedInbox
      inboxSignals = negotiatedSignals
      notifyGeneration = negotiatedNotify
      lease = null
      lastPushed = null
      if (avatarChanged || identityChanged || (inboxChanged && socket !== null) || renegotiatesNotify) {
        const previousSocket = socket
        socket = null
        if (previousSocket) stopPusher(previousSocket)
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
      dropLease()
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
      lease = null
      binding = null
      const previousSocket = socket
      socket = null
      if (previousSocket) stopPusher(previousSocket)
      previousSocket?.close(1000, 'Deck scope changed')
      if (stopHeartbeat) void enqueue(() => sync(true))
    },
    inboxChanged() {
      pusher?.relay.changed()
    },
    notificationsReplaced() {
      const current = binding
      const live = current !== null && lease?.binding === current ? lease : null
      const suppress = shouldSuppressDeckNotification(
        {
          negotiated: current !== null && notifyGeneration !== null,
          bound: current?.bound === true,
          currentContext: current !== null && bindingIsCurrent(current),
          status: live === null ? null : { replace: true, receivedAt: live.receivedAt, leaseMs: AVATAR_NOTIFICATION_LEASE_MS }
        },
        monotonicNow()
      )
      if (!suppress) lease = null
      return suppress
    },
    stop() {
      stopHeartbeat?.()
      stopHeartbeat = null
      lease = null
      binding = null
      return enqueue(async () => {
        const closing = socket
        socket = null
        if (closing) stopPusher(closing)
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
