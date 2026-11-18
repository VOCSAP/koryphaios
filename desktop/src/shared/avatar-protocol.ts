import { posix, win32 } from 'node:path'
import { projectKeyCaseRefusal, validateProjectKey } from '../../../shared/project-key'
import {
  AVATAR_INBOX_PROTOCOL_VERSION,
  INBOX_OUTCOMES,
  MAX_INBOX_OUTCOME_REASON,
  parseAvatarInboxAction,
  parseAvatarInboxContent,
  type AvatarInboxAction,
  type AvatarInboxSnapshotFrame,
  type InboxOutcome,
  type InboxQuestionsValidator
} from './avatar-inbox-protocol'
import type { AvatarDeckCounters, AvatarDeckIdentity, AvatarDeckSnapshot } from './avatar-state'

export const AVATAR_PROTOCOL_VERSION = 1
export const MAX_AVATAR_COUNTER = 1_000_000
export const MAX_AVATAR_ATTACHMENTS = 64
export const MAX_AVATAR_REQUEST_BYTES = 64 * 1024
export const AVATAR_COMMANDS = ['focus', 'open_question'] as const
export const AVATAR_CAPABILITIES = ['a3_context', 'a3_inbox', 'a3_notify_replace'] as const
export const AVATAR_NOTIFICATION_LEASE_MS = 15_000
export const AVATAR_THEMES = ['dark', 'light', 'system'] as const
export type AvatarCommand = (typeof AVATAR_COMMANDS)[number]
export type AvatarCapability = (typeof AVATAR_CAPABILITIES)[number]
export type AvatarTheme = (typeof AVATAR_THEMES)[number]

export interface AvatarDeckContext {
  group_id: string
  project_key: string
  scope_generation: number
}

const MAX_DECK_RUN_ID_LENGTH = 64
const MAX_AVATAR_REQUEST_ID_LENGTH = 64
const MAX_AVATAR_COMMAND_ERROR_LENGTH = 256
const MAX_DECK_NAME_LENGTH = 64
const MAX_PROJECT_DIR_LENGTH = 4_096
const DECK_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const GROUP_ID_PATTERN = /^[a-f0-9]{32}$/
const INVISIBLE_FORMAT_PATTERN = /[\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2069\uFEFF]/

export interface AvatarAttachRequest {
  protocol_version: number
  deckRunId: string
  deckPid: number
  broker_url: string
  projectDir: string
  deckName: string
  /** Omitted means system fallback. */
  theme?: AvatarTheme
  capabilities?: AvatarCapability[]
  context?: AvatarDeckContext
}

export interface AvatarBindFrame extends AvatarDeckIdentity {
  type: 'bind'
  protocol_version: typeof AVATAR_PROTOCOL_VERSION
}

export interface AvatarBoundFrame {
  type: 'bound'
}

export interface AvatarCommandFrame extends AvatarDeckIdentity {
  type: 'command'
  requestId: string
  command: AvatarCommand
}

export const AVATAR_INBOX_COMMAND = 'inbox_action'

/** Outside AVATAR_COMMANDS: offered only on an a3_inbox attachment, and it carries a payload. */
export interface AvatarInboxCommandFrame extends AvatarDeckIdentity {
  type: 'command'
  requestId: string
  command: typeof AVATAR_INBOX_COMMAND
  inbox: AvatarInboxAction
}

export interface AvatarCommandResultFrame {
  type: 'command_result'
  requestId: string
  ok: boolean
  error?: string
  outcome?: InboxOutcome
  reason?: string
}

/** `replace` is every availability condition at once; false revokes the lease at once. */
export interface AvatarNotificationStatusFrame extends AvatarDeckIdentity {
  type: 'notification_status'
  protocol_version: typeof AVATAR_PROTOCOL_VERSION
  avatarRunId: string
  scope_generation: number
  seq: number
  replace: boolean
  lease_ms: typeof AVATAR_NOTIFICATION_LEASE_MS
}

export type AvatarDeckFrame = AvatarBindFrame | AvatarCommandResultFrame
export type AvatarServerFrame = AvatarBoundFrame | AvatarCommandFrame | AvatarInboxCommandFrame | AvatarNotificationStatusFrame

export type AvatarProtocolErrorCode =
  | 'unsupported_protocol_version'
  | 'invalid_attach_request'
  | 'invalid_avatar_frame'

export class AvatarProtocolError extends Error {
  constructor(
    readonly code: AvatarProtocolErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'AvatarProtocolError'
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AvatarProtocolError('invalid_attach_request', 'invalid Avatar attach request')
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AvatarProtocolError('invalid_attach_request', 'invalid Avatar attach request')
  }
  return value
}

function requiredPid(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new AvatarProtocolError('invalid_attach_request', 'invalid Avatar attach request')
  }
  return value
}

function invalidAttachRequest(): never {
  throw new AvatarProtocolError('invalid_attach_request', 'invalid Avatar attach request')
}

function requiredDeckRunId(value: unknown): string {
  const deckRunId = requiredString(value)
  if (deckRunId.length > MAX_DECK_RUN_ID_LENGTH || !DECK_RUN_ID_PATTERN.test(deckRunId)) {
    invalidAttachRequest()
  }
  return deckRunId
}

function requiredBrokerUrl(value: unknown): string {
  const brokerUrl = requiredString(value)
  try {
    const url = new URL(brokerUrl)
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password) {
      return brokerUrl
    }
  } catch {
    invalidAttachRequest()
  }
  return invalidAttachRequest()
}

function requiredProjectDir(value: unknown): string {
  const projectDir = requiredString(value)
  if (
    projectDir.length > MAX_PROJECT_DIR_LENGTH ||
    projectDir.startsWith('-') ||
    (!posix.isAbsolute(projectDir) && !win32.isAbsolute(projectDir))
  ) {
    invalidAttachRequest()
  }
  return projectDir
}

function requiredDeckName(value: unknown): string {
  const deckName = requiredString(value)
  if (deckName.length > MAX_DECK_NAME_LENGTH) invalidAttachRequest()
  return deckName
}

function optionalAvatarCapabilities(value: unknown): AvatarCapability[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) invalidAttachRequest()
  return [...new Set(value.filter((capability): capability is AvatarCapability => (AVATAR_CAPABILITIES as readonly unknown[]).includes(capability)))]
}

function optionalAvatarTheme(value: unknown): AvatarTheme | undefined {
  if (value === undefined) return undefined
  if (!(AVATAR_THEMES as readonly unknown[]).includes(value)) invalidAttachRequest()
  return value as AvatarTheme
}

function optionalAvatarContext(value: unknown, capabilities: readonly AvatarCapability[] | undefined): AvatarDeckContext | undefined {
  if (value === undefined) return undefined
  if (!capabilities?.includes('a3_context')) invalidAttachRequest()
  const input = record(value)
  const groupId = requiredString(input.group_id)
  const projectKey = requiredString(input.project_key)
  const scopeGeneration = input.scope_generation
  if (
    !GROUP_ID_PATTERN.test(groupId) ||
    !validateProjectKey(projectKey).ok ||
    projectKeyCaseRefusal(projectKey) !== null ||
    INVISIBLE_FORMAT_PATTERN.test(projectKey) ||
    typeof scopeGeneration !== 'number' ||
    !Number.isSafeInteger(scopeGeneration) ||
    scopeGeneration < 0
  ) {
    invalidAttachRequest()
  }
  return { group_id: groupId, project_key: projectKey, scope_generation: scopeGeneration }
}

export function escapeAvatarTrayLabel(deckName: string): string {
  return deckName.replaceAll('&', '&&')
}

/** The bubble's theme: the one explicit theme every attached Deck agrees on, else the system theme. */
export function resolveAvatarBubbleTheme(decks: readonly { theme?: AvatarTheme }[], system: 'dark' | 'light'): 'dark' | 'light' {
  const first = decks[0]?.theme
  if (first !== 'dark' && first !== 'light') return system
  return decks.every((deck) => deck.theme === first) ? first : system
}

function requiredProtocolVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalidAttachRequest()
  if (value !== AVATAR_PROTOCOL_VERSION) {
    throw new AvatarProtocolError('unsupported_protocol_version', `unsupported Avatar protocol version ${value}`)
  }
  return value
}

export function parseAvatarAttachRequest(value: unknown): AvatarAttachRequest {
  const input = record(value)
  const capabilities = optionalAvatarCapabilities(input.capabilities)
  const context = optionalAvatarContext(input.context, capabilities)
  const theme = optionalAvatarTheme(input.theme)
  return {
    protocol_version: requiredProtocolVersion(input.protocol_version),
    deckRunId: requiredDeckRunId(input.deckRunId),
    deckPid: requiredPid(input.deckPid),
    broker_url: requiredBrokerUrl(input.broker_url),
    projectDir: requiredProjectDir(input.projectDir),
    deckName: requiredDeckName(input.deckName),
    ...(theme === undefined ? {} : { theme }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(context === undefined ? {} : { context })
  }
}

function parseAvatarDeckIdentity(value: unknown): AvatarDeckIdentity {
  const input = record(value)
  return {
    deckRunId: requiredDeckRunId(input.deckRunId),
    broker_url: requiredBrokerUrl(input.broker_url)
  }
}

function requiredCounter(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_AVATAR_COUNTER) invalidAttachRequest()
  return value
}

function parseAvatarDeckCounters(value: unknown): AvatarDeckCounters {
  const input = record(value)
  return {
    working: requiredCounter(input.working),
    idle: requiredCounter(input.idle),
    unknown: requiredCounter(input.unknown),
    waiting: requiredCounter(input.waiting),
    exited: requiredCounter(input.exited),
    rateLimited: requiredCounter(input.rateLimited)
  }
}

export function parseAvatarDetachRequest(value: unknown): AvatarDeckIdentity {
  return parseAvatarDeckIdentity(value)
}

export function parseAvatarStateRequest(value: unknown): AvatarDeckSnapshot {
  const input = record(value)
  return {
    identity: parseAvatarDeckIdentity(input.identity),
    counters: parseAvatarDeckCounters(input.counters),
    unread: requiredCounter(input.unread)
  }
}

function invalidAvatarFrame(): never {
  throw new AvatarProtocolError('invalid_avatar_frame', 'invalid Avatar WebSocket frame')
}

function frameRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidAvatarFrame()
  return value as Record<string, unknown>
}

function frameString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) invalidAvatarFrame()
  return value
}

function frameDeckIdentity(input: Record<string, unknown>): AvatarDeckIdentity {
  const deckRunId = frameString(input.deckRunId, MAX_DECK_RUN_ID_LENGTH)
  if (!DECK_RUN_ID_PATTERN.test(deckRunId)) invalidAvatarFrame()

  const brokerUrl = frameString(input.broker_url, MAX_PROJECT_DIR_LENGTH)
  try {
    const url = new URL(brokerUrl)
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password) {
      return { deckRunId, broker_url: brokerUrl }
    }
  } catch {
    invalidAvatarFrame()
  }
  return invalidAvatarFrame()
}

function frameProtocolVersion(value: unknown): typeof AVATAR_PROTOCOL_VERSION {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalidAvatarFrame()
  if (value !== AVATAR_PROTOCOL_VERSION) {
    throw new AvatarProtocolError('unsupported_protocol_version', `unsupported Avatar protocol version ${value}`)
  }
  return value
}

function frameRequestId(value: unknown): string {
  const requestId = frameString(value, MAX_AVATAR_REQUEST_ID_LENGTH)
  if (!DECK_RUN_ID_PATTERN.test(requestId)) invalidAvatarFrame()
  return requestId
}

function frameCommand(value: unknown): (typeof AVATAR_COMMANDS)[number] {
  if (!(AVATAR_COMMANDS as readonly string[]).includes(value as string)) invalidAvatarFrame()
  return value as (typeof AVATAR_COMMANDS)[number]
}

function parseAvatarCommandFrame(input: Record<string, unknown>): AvatarCommandFrame {
  return {
    type: 'command',
    requestId: frameRequestId(input.requestId),
    command: frameCommand(input.command),
    ...frameDeckIdentity(input)
  }
}

export function parseAvatarDeckFrame(value: unknown): AvatarDeckFrame {
  const input = frameRecord(value)
  if (input.type === 'bind') {
    return {
      type: 'bind',
      protocol_version: frameProtocolVersion(input.protocol_version),
      ...frameDeckIdentity(input)
    }
  }
  if (input.type === 'command_result') {
    const result: AvatarCommandResultFrame = {
      type: 'command_result',
      requestId: frameRequestId(input.requestId),
      ok: typeof input.ok === 'boolean' ? input.ok : invalidAvatarFrame()
    }
    if (input.error !== undefined) result.error = frameString(input.error, MAX_AVATAR_COMMAND_ERROR_LENGTH)
    if (input.outcome !== undefined) {
      if (!(INBOX_OUTCOMES as readonly unknown[]).includes(input.outcome)) invalidAvatarFrame()
      result.outcome = input.outcome as InboxOutcome
    }
    if (input.reason !== undefined) result.reason = frameString(input.reason, MAX_INBOX_OUTCOME_REASON)
    return result
  }
  return invalidAvatarFrame()
}

/**
 * An inbox_snapshot frame. Kept out of parseAvatarDeckFrame: an invalid one is
 * dropped without closing the socket, and its questions need the broker's
 * validator, which the caller injects.
 */
export function parseAvatarInboxSnapshotFrame(value: unknown, validateQuestions: InboxQuestionsValidator): AvatarInboxSnapshotFrame {
  const input = frameRecord(value)
  if (input.protocol_version !== AVATAR_INBOX_PROTOCOL_VERSION) invalidAvatarFrame()
  return {
    ...parseAvatarInboxContent(input, validateQuestions),
    protocol_version: AVATAR_INBOX_PROTOCOL_VERSION,
    ...frameDeckIdentity(input)
  }
}

/** requestId of a well-formed command whose only defect is a command outside AVATAR_COMMANDS, else null. */
export function unsupportedAvatarCommandRequestId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (input.type !== 'command' || input.command === AVATAR_INBOX_COMMAND || (AVATAR_COMMANDS as readonly unknown[]).includes(input.command)) {
    return null
  }
  try {
    return parseAvatarCommandFrame({ ...input, command: AVATAR_COMMANDS[0] }).requestId
  } catch {
    return null
  }
}

/** requestId of an inbox_action addressed with a valid requestId and identity whose payload is refused, else null. */
export function invalidInboxActionRequestId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (input.type !== 'command' || input.command !== AVATAR_INBOX_COMMAND) return null
  try {
    return parseAvatarCommandFrame({ ...input, command: AVATAR_COMMANDS[0] }).requestId
  } catch {
    return null
  }
}

function parseAvatarInboxCommandFrame(input: Record<string, unknown>): AvatarInboxCommandFrame {
  return {
    type: 'command',
    requestId: frameRequestId(input.requestId),
    command: AVATAR_INBOX_COMMAND,
    inbox: parseAvatarInboxAction(input.inbox),
    ...frameDeckIdentity(input)
  }
}

const NOTIFICATION_STATUS_KEYS = [
  'avatarRunId',
  'broker_url',
  'deckRunId',
  'lease_ms',
  'protocol_version',
  'replace',
  'scope_generation',
  'seq',
  'type'
]

function frameSafeInteger(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) invalidAvatarFrame()
  return value
}

function parseAvatarNotificationStatusFrame(input: Record<string, unknown>): AvatarNotificationStatusFrame {
  const keys = Object.keys(input).sort()
  if (keys.length !== NOTIFICATION_STATUS_KEYS.length || keys.some((key, index) => key !== NOTIFICATION_STATUS_KEYS[index])) invalidAvatarFrame()
  const avatarRunId = frameString(input.avatarRunId, MAX_DECK_RUN_ID_LENGTH)
  if (!DECK_RUN_ID_PATTERN.test(avatarRunId)) invalidAvatarFrame()
  if (typeof input.replace !== 'boolean' || input.lease_ms !== AVATAR_NOTIFICATION_LEASE_MS) invalidAvatarFrame()
  return {
    type: 'notification_status',
    protocol_version: frameProtocolVersion(input.protocol_version),
    avatarRunId,
    scope_generation: frameSafeInteger(input.scope_generation, 0),
    seq: frameSafeInteger(input.seq, 1),
    replace: input.replace,
    lease_ms: AVATAR_NOTIFICATION_LEASE_MS,
    ...frameDeckIdentity(input)
  }
}

export function parseAvatarServerFrame(value: unknown): AvatarServerFrame {
  const input = frameRecord(value)
  if (input.type === 'bound') return { type: 'bound' }
  if (input.type === 'notification_status') return parseAvatarNotificationStatusFrame(input)
  if (input.type === 'command' && input.command === AVATAR_INBOX_COMMAND) return parseAvatarInboxCommandFrame(input)
  if (input.type === 'command') return parseAvatarCommandFrame(input)
  return invalidAvatarFrame()
}
