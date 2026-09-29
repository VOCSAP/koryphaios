import { expect, test } from 'bun:test'
import {
  AVATAR_PROTOCOL_VERSION,
  AvatarProtocolError,
  AVATAR_COMMANDS,
  MAX_AVATAR_COUNTER,
  escapeAvatarTrayLabel,
  parseAvatarAttachRequest,
  parseAvatarDeckFrame,
  parseAvatarServerFrame,
  parseAvatarStateRequest,
  unsupportedAvatarCommandRequestId
} from '../desktop/src/shared/avatar-protocol.ts'

const validAttach = {
  protocol_version: AVATAR_PROTOCOL_VERSION,
  deckRunId: 'deck-run-123',
  deckPid: 4242,
  broker_url: 'http://127.0.0.1:7899',
  projectDir: 'C:/work/example',
  deckName: 'Example'
}

test('accepts the current protocol version and resolved Deck identity', () => {
  expect(parseAvatarAttachRequest(validAttach)).toEqual(validAttach)
})

test('rejects malformed protocol versions as invalid attach requests', () => {
  for (const protocol_version of [undefined, null, '1', 1.5, 'abc', {}, Number.MAX_SAFE_INTEGER + 1]) {
    try {
      parseAvatarAttachRequest({ ...validAttach, protocol_version })
      throw new Error('expected protocol rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(AvatarProtocolError)
      expect((error as AvatarProtocolError).code).toBe('invalid_attach_request')
    }
  }
})

test('rejects safe unsupported protocol versions with a typed error', () => {
  for (const protocol_version of [0, AVATAR_PROTOCOL_VERSION + 1]) {
    try {
      parseAvatarAttachRequest({ ...validAttach, protocol_version })
      throw new Error('expected protocol rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(AvatarProtocolError)
      expect((error as AvatarProtocolError).code).toBe('unsupported_protocol_version')
    }
  }
})

test('bounds Avatar state counters at the safe aggregation limit', () => {
  const counters = {
    working: MAX_AVATAR_COUNTER,
    idle: MAX_AVATAR_COUNTER,
    unknown: MAX_AVATAR_COUNTER,
    waiting: MAX_AVATAR_COUNTER,
    exited: MAX_AVATAR_COUNTER,
    rateLimited: MAX_AVATAR_COUNTER
  }
  const state = {
    identity: { deckRunId: validAttach.deckRunId, broker_url: validAttach.broker_url },
    counters,
    unread: MAX_AVATAR_COUNTER
  }
  expect(parseAvatarStateRequest(state)).toEqual(state)
  for (const field of Object.keys(counters)) {
    expect(() => parseAvatarStateRequest({ ...state, counters: { ...counters, [field]: MAX_AVATAR_COUNTER + 1 } })).toThrow(
      /invalid Avatar attach request/
    )
  }
  expect(() => parseAvatarStateRequest({ ...state, unread: MAX_AVATAR_COUNTER + 1 })).toThrow(/invalid Avatar attach request/)
})

test('requires the identity fields that distinguish concurrent Decks', () => {
  for (const field of ['deckRunId', 'deckPid', 'broker_url', 'projectDir', 'deckName'] as const) {
    const invalid = { ...validAttach, [field]: field === 'deckPid' ? 0 : '' }
    expect(() => parseAvatarAttachRequest(invalid)).toThrow(/invalid Avatar attach request/)
  }
})

test('rejects unsafe attach transport and identity values', () => {
  const invalidAttachRequests = [
    { projectDir: 'relative/project' },
    { projectDir: '-project' },
    { projectDir: `C:/${'x'.repeat(4_094)}` },
    { broker_url: 'ftp://127.0.0.1:7899' },
    { broker_url: 'http://user@127.0.0.1:7899' },
    { broker_url: 'https://user:password@127.0.0.1:7899' },
    { deckRunId: 'deck run' },
    { deckRunId: 'édeck' },
    { deckRunId: '-deck' },
    { deckRunId: '_deck' },
    { deckRunId: '.deck' },
    { deckRunId: 'deck\tid' },
    { deckRunId: 'deck\nid' },
    { deckRunId: `d${'x'.repeat(64)}` },
    { deckName: 'x'.repeat(65) }
  ]

  for (const invalid of invalidAttachRequests) {
    expect(() => parseAvatarAttachRequest({ ...validAttach, ...invalid })).toThrow(
      /invalid Avatar attach request/
    )
  }
})

test('accepts each inclusive protocol length boundary', () => {
  const deckRunId = `d${'x'.repeat(63)}`
  const deckName = 'x'.repeat(64)
  const projectDir = `C:/${'x'.repeat(4_093)}`

  expect(parseAvatarAttachRequest({ ...validAttach, deckRunId, deckName, projectDir })).toMatchObject({
    deckRunId,
    deckName,
    projectDir
  })
})

test('escapes every ampersand in a validated Deck name for the Tray menu', () => {
  expect(parseAvatarAttachRequest({ ...validAttach, deckName: 'A & B' }).deckName).toBe('A & B')
  expect(escapeAvatarTrayLabel('A & B & C')).toBe('A && B && C')
  expect(escapeAvatarTrayLabel('&A&&')).toBe('&&A&&&&')
})

test('accepts versioned bind, focus command, and command result frames', () => {
  const identity = { deckRunId: validAttach.deckRunId, broker_url: validAttach.broker_url }
  expect(AVATAR_COMMANDS).toEqual(['focus'])
  expect(parseAvatarDeckFrame({ type: 'bind', protocol_version: 1, ...identity })).toEqual({
    type: 'bind',
    protocol_version: 1,
    ...identity
  })
  expect(parseAvatarServerFrame({ type: 'bound' })).toEqual({ type: 'bound' })
  expect(parseAvatarServerFrame({ type: 'command', requestId: 'request-1', command: 'focus', ...identity })).toEqual({
    type: 'command',
    requestId: 'request-1',
    command: 'focus',
    ...identity
  })
  expect(parseAvatarDeckFrame({ type: 'command_result', requestId: 'request-1', ok: false, error: 'focus failed' })).toEqual({
    type: 'command_result',
    requestId: 'request-1',
    ok: false,
    error: 'focus failed'
  })
})

test('rejects invalid WebSocket frame versions, commands, and result shapes', () => {
  const identity = { deckRunId: validAttach.deckRunId, broker_url: validAttach.broker_url }
  expect(() => parseAvatarDeckFrame({ type: 'bind', protocol_version: 2, ...identity })).toThrow(
    /unsupported Avatar protocol version 2/
  )
  for (const frame of [
    { type: 'command', requestId: 'request-1', command: 'restart', ...identity },
    { type: 'command', requestId: '', command: 'focus', ...identity },
    { type: 'command_result', requestId: 'request-1', ok: 'true' },
    { type: 'unknown' }
  ]) {
    expect(() => parseAvatarServerFrame(frame)).toThrow(/invalid Avatar WebSocket frame/)
  }
})

test('reads the requestId of a command refused only for being outside AVATAR_COMMANDS', () => {
  const identity = { deckRunId: validAttach.deckRunId, broker_url: validAttach.broker_url }
  expect(unsupportedAvatarCommandRequestId({ type: 'command', requestId: 'request-9', command: 'restart', ...identity })).toBe('request-9')
  expect(unsupportedAvatarCommandRequestId({ type: 'command', requestId: 'request-9', command: 'focus', ...identity })).toBeNull()
  expect(unsupportedAvatarCommandRequestId({ type: 'command', requestId: '', command: 'restart', ...identity })).toBeNull()
  expect(unsupportedAvatarCommandRequestId({ type: 'command', requestId: 'request-9', command: 'restart', deckRunId: 'bad id' })).toBeNull()
  expect(unsupportedAvatarCommandRequestId({ type: 'bound', requestId: 'request-9', command: 'restart' })).toBeNull()
  expect(unsupportedAvatarCommandRequestId(null)).toBeNull()
})
