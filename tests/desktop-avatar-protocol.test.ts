import { expect, test } from 'bun:test'
import { displaySafe } from '../desktop/src/main/ttsr-dialog.ts'
import {
  AVATAR_PROTOCOL_VERSION,
  AvatarProtocolError,
  AVATAR_COMMANDS,
  AVATAR_NOTIFICATION_LEASE_MS,
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

test('accepts A3 context only when its capability is negotiated', () => {
  const context = { group_id: '11111111111111111111111111111111', project_key: 'project-1', scope_generation: 1 }
  expect(parseAvatarAttachRequest({ ...validAttach, capabilities: ['a3_context'], context })).toEqual({
    ...validAttach,
    capabilities: ['a3_context'],
    context
  })
  expect(() => parseAvatarAttachRequest({ ...validAttach, context })).toThrow(/invalid Avatar attach request/)
})

test('ignores an unknown capability while preserving the A1 attach request', () => {
  expect(parseAvatarAttachRequest({ ...validAttach, capabilities: ['future_avatar_capability'] })).toEqual({
    ...validAttach,
    capabilities: []
  })
})

test('deduplicates negotiated Avatar capabilities', () => {
  expect(parseAvatarAttachRequest({ ...validAttach, capabilities: ['a3_context', 'a3_context'] })).toEqual({
    ...validAttach,
    capabilities: ['a3_context']
  })
})

const { deckPid: _omittedPid, ...attachWithoutPid } = validAttach

test.each<[string, Record<string, unknown>]>([
  ['an absent key', attachWithoutPid],
  ['zero', { ...validAttach, deckPid: 0 }],
  ['NaN, which JSON transport would normalize to null', { ...validAttach, deckPid: Number.NaN }],
  ['a non-integer number', { ...validAttach, deckPid: 1.5 }],
  ['a numeric string', { ...validAttach, deckPid: '4242' }]
])('rejects an attach PID that is %s', (_label, request) => {
  expect(() => parseAvatarAttachRequest(request)).toThrow(expect.objectContaining({ code: 'invalid_attach_request' }))
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
  expect(AVATAR_COMMANDS).toEqual(['focus', 'open_question'])
  expect(parseAvatarServerFrame({ type: 'command', requestId: 'request-2', command: 'open_question', ...identity })).toEqual({
    type: 'command',
    requestId: 'request-2',
    command: 'open_question',
    ...identity
  })
  expect(unsupportedAvatarCommandRequestId({ type: 'command', requestId: 'request-2', command: 'open_question', ...identity })).toBeNull()
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

const a3Context = { group_id: '11111111111111111111111111111111', project_key: 'project-1', scope_generation: 1 }

test.each([
  ['a negative scope generation', { ...a3Context, scope_generation: -1 }],
  ['a fractional scope generation', { ...a3Context, scope_generation: 1.5 }],
  ['a scope generation beyond the safe integers', { ...a3Context, scope_generation: 2 ** 53 }],
  ['a scope generation that is not a number', { ...a3Context, scope_generation: '1' }],
  ['a missing scope generation', { group_id: '11111111111111111111111111111111', project_key: 'project-1' }],
  ['an empty group', { ...a3Context, group_id: '' }],
  ['an absurdly long group', { ...a3Context, group_id: 'g'.repeat(10_000) }],
  ['an absurdly long project key', { ...a3Context, project_key: 'p'.repeat(100_000) }],
  ['a group that is not a group digest', { ...a3Context, group_id: 'group-1' }],
  ['a group digest in upper case', { ...a3Context, group_id: 'A'.repeat(32) }],
  ['a group digest one character short', { ...a3Context, group_id: 'a'.repeat(31) }],
  ['a project key in mixed case', { ...a3Context, project_key: 'github.com/Owner/repo' }],
  ['a project key carrying NUL', { ...a3Context, project_key: `project${String.fromCharCode(0)}-1` }],
  ['a project key carrying a C1 control', { ...a3Context, project_key: `project${String.fromCharCode(0x85)}-1` }],
  ['a project key carrying a bidi override', { ...a3Context, project_key: `project${String.fromCharCode(0x202e)}-1` }],
  ['a project key carrying a bidi isolate', { ...a3Context, project_key: `project${String.fromCharCode(0x2068)}-1` }]
])('refuses an A3 context carrying %s', (_what, context) => {
  expect(() => parseAvatarAttachRequest({ ...validAttach, capabilities: ['a3_context'], context })).toThrow(/invalid Avatar attach request/)
})

test('a project key is refused for exactly the characters displaySafe neutralises', () => {
  const mismatches: string[] = []
  for (let code = 0; code <= 0xffff; code++) {
    if (code >= 0xd800 && code <= 0xdfff) continue
    const char = String.fromCharCode(code)
    if (char.toLowerCase() !== char) continue
    const neutralised = displaySafe(`a${char}b`) !== `a${char}b`
    let refused = false
    try {
      parseAvatarAttachRequest({ ...validAttach, capabilities: ['a3_context'], context: { ...a3Context, project_key: `a${char}b` } })
    } catch {
      refused = true
    }
    if (neutralised !== refused) mismatches.push(code.toString(16))
  }
  expect(mismatches).toEqual([])
})

const statusInput = (patch: Record<string, unknown> = {}) => ({
  type: 'notification_status',
  protocol_version: 1,
  avatarRunId: 'avatar-run-1',
  deckRunId: validAttach.deckRunId,
  broker_url: validAttach.broker_url,
  scope_generation: 3,
  seq: 1,
  replace: true,
  lease_ms: 15_000,
  ...patch
})

test('a notification_status frame of exactly nine well-typed keys parses, and the lease is 15000 ms', () => {
  expect(AVATAR_NOTIFICATION_LEASE_MS).toBe(15_000)
  expect(parseAvatarServerFrame(statusInput())).toEqual(statusInput())
  expect(parseAvatarServerFrame(statusInput({ replace: false, seq: 2, scope_generation: 0 }))).toMatchObject({ replace: false, seq: 2, scope_generation: 0 })
})

test('a notification_status frame is refused for an extra key, a missing key, a truthy boolean, a non-integer, a wrong lease or a bad identity', () => {
  const refused: Array<[string, unknown]> = [
    ['extra key', { ...statusInput(), note: 'x' }],
    ...Object.keys(statusInput()).map((key): [string, unknown] => {
      const { [key]: _omitted, ...rest } = statusInput()
      return [`missing ${key}`, rest]
    }),
    ['replace as a string', statusInput({ replace: 'true' })],
    ['replace as a number', statusInput({ replace: 1 })],
    ['replace null', statusInput({ replace: null })],
    ['seq 0', statusInput({ seq: 0 })],
    ['seq NaN', statusInput({ seq: Number.NaN })],
    ['seq fractional', statusInput({ seq: 1.5 })],
    ['seq as a string', statusInput({ seq: '2' })],
    ['seq beyond the safe range', statusInput({ seq: Number.MAX_SAFE_INTEGER + 1 })],
    ['scope generation negative', statusInput({ scope_generation: -1 })],
    ['scope generation as a string', statusInput({ scope_generation: '3' })],
    ['scope generation fractional', statusInput({ scope_generation: 0.5 })],
    ['lease above the fixed one', statusInput({ lease_ms: 15_001 })],
    ['lease below the fixed one', statusInput({ lease_ms: 14_999 })],
    ['lease as a string', statusInput({ lease_ms: '15000' })],
    ['lease infinite', statusInput({ lease_ms: Number.POSITIVE_INFINITY })],
    ['empty Avatar run id', statusInput({ avatarRunId: '' })],
    ['Avatar run id too long', statusInput({ avatarRunId: 'a'.repeat(65) })],
    ['Avatar run id with a bad first character', statusInput({ avatarRunId: '-run' })],
    ['Deck run id with a bad character', statusInput({ deckRunId: 'deck run' })],
    ['broker with credentials', statusInput({ broker_url: 'http://user:pass@127.0.0.1:7899' })],
    ['broker not http', statusInput({ broker_url: 'file:///x' })]
  ]
  for (const [name, frame] of refused) {
    expect(() => parseAvatarServerFrame(frame), name).toThrow(/invalid Avatar WebSocket frame/)
  }
  expect(() => parseAvatarServerFrame(statusInput({ protocol_version: 2 }))).toThrow(/unsupported Avatar protocol version 2/)
})

test('a3_notify_replace is a capability the attach parser keeps next to the two it depends on', () => {
  const context = { group_id: '1'.repeat(32), project_key: 'project-1', scope_generation: 1 }
  const request = parseAvatarAttachRequest({ ...validAttach, capabilities: ['a3_context', 'a3_inbox', 'a3_notify_replace'], context })
  expect(request.capabilities).toEqual(['a3_context', 'a3_inbox', 'a3_notify_replace'])
})
