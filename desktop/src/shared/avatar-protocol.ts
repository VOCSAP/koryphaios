import { posix, win32 } from 'node:path'
import type { AvatarDeckCounters, AvatarDeckIdentity, AvatarDeckSnapshot } from './avatar-state'

export const AVATAR_PROTOCOL_VERSION = 1
export const MAX_AVATAR_COUNTER = 1_000_000
export const MAX_AVATAR_ATTACHMENTS = 1_000_000

const MAX_DECK_RUN_ID_LENGTH = 64
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

export type AvatarProtocolErrorCode = 'unsupported_protocol_version' | 'invalid_attach_request'

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
