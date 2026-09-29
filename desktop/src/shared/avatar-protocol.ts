import { posix, win32 } from 'node:path'
import type { AvatarDeckCounters, AvatarDeckIdentity, AvatarDeckSnapshot } from './avatar-state'

export const AVATAR_PROTOCOL_VERSION = 1
export const MAX_AVATAR_COUNTER = 1_000_000
export const MAX_AVATAR_ATTACHMENTS = 64
export const AVATAR_COMMANDS = ['focus'] as const

const MAX_DECK_RUN_ID_LENGTH = 64
const MAX_AVATAR_REQUEST_ID_LENGTH = 64
const MAX_AVATAR_COMMAND_ERROR_LENGTH = 256
const MAX_DECK_NAME_LENGTH = 64
const MAX_PROJECT_DIR_LENGTH = 4_096
const DECK_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export interface AvatarAttachRequest {
  protocol_version: number
  deckRunId: string
  deckPid: number
  broker_url: string
  projectDir: string
  deckName: string
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
  command: (typeof AVATAR_COMMANDS)[number]
}

export interface AvatarCommandResultFrame {
  type: 'command_result'
  requestId: string
  ok: boolean
  error?: string
}

export type AvatarDeckFrame = AvatarBindFrame | AvatarCommandResultFrame
export type AvatarServerFrame = AvatarBoundFrame | AvatarCommandFrame

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

export function escapeAvatarTrayLabel(deckName: string): string {
  return deckName.replaceAll('&', '&&')
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
  return {
    protocol_version: requiredProtocolVersion(input.protocol_version),
    deckRunId: requiredDeckRunId(input.deckRunId),
    deckPid: requiredPid(input.deckPid),
    broker_url: requiredBrokerUrl(input.broker_url),
    projectDir: requiredProjectDir(input.projectDir),
    deckName: requiredDeckName(input.deckName)
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
    return result
  }
  return invalidAvatarFrame()
}

/** requestId of a well-formed command whose only defect is a command outside AVATAR_COMMANDS, else null. */
export function unsupportedAvatarCommandRequestId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (input.type !== 'command' || (AVATAR_COMMANDS as readonly unknown[]).includes(input.command)) return null
  try {
    return parseAvatarCommandFrame({ ...input, command: AVATAR_COMMANDS[0] }).requestId
  } catch {
    return null
  }
}

export function parseAvatarServerFrame(value: unknown): AvatarServerFrame {
  const input = frameRecord(value)
  if (input.type === 'bound') return { type: 'bound' }
  if (input.type === 'command') return parseAvatarCommandFrame(input)
  return invalidAvatarFrame()
}
