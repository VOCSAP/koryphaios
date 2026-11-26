import { expect, test } from 'bun:test'
import {
  APPROVAL_ANSWER_MAX,
  APPROVAL_OPTION_MAX,
  APPROVAL_OPTIONS_MAX,
  APPROVAL_TITLE_MAX,
  CLOSE_REASON_MAX,
  validateQuestions
} from '../shared/approval.ts'
import {
  buildAvatarInboxSnapshot,
  inboxActionAllowed,
  inboxFrameBytes,
  MAX_INBOX_ACTION_TEXT,
  MAX_INBOX_APPROVALS,
  MAX_INBOX_DANGER,
  MAX_INBOX_DANGER_ID,
  MAX_INBOX_DANGER_MESSAGE,
  MAX_INBOX_FRAME_BYTES,
  MAX_INBOX_OPTION,
  MAX_INBOX_OPTIONS,
  MAX_INBOX_PEER_ID,
  MAX_INBOX_REASON,
  MAX_INBOX_TEXT,
  MAX_INBOX_TILE_NAME,
  MAX_INBOX_TITLE,
  parseAvatarInboxAction,
  projectAvatarInbox,
  type AvatarInboxContent,
  type InboxRelaySources
} from '../desktop/src/shared/avatar-inbox-protocol.ts'
import {
  invalidInboxActionRequestId,
  parseAvatarDeckFrame,
  parseAvatarInboxSnapshotFrame,
  parseAvatarServerFrame,
  unsupportedAvatarCommandRequestId
} from '../desktop/src/shared/avatar-protocol.ts'
import type { Approval, DangerViewEntry, InboxMessage } from '../desktop/src/shared/types.ts'

const identity = { deckRunId: 'deck-run-1', broker_url: 'http://127.0.0.1:7899' }
const SECRET_OPERATOR = 'operator-id-that-must-never-leave-the-deck'
const SECRET_SESSION = 'session-ref-that-must-never-leave-the-deck'
const SECRET_ANSWER = 'answer-text-that-must-never-leave-the-deck'

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

function approval(n: number, overrides: Partial<Approval> = {}): Approval {
  return {
    id: uuid(n),
    operator_id: SECRET_OPERATOR,
    origin: {
      host: 'host-a',
      os_user_hash: 'hash',
      project_key: 'github.com/owner/repo',
      group_id: 'f'.repeat(32),
      from_peer: 'peer-a',
      session_ref: SECRET_SESSION,
      tile_ref: 'tile-1'
    },
    kind: 'question',
    title: `Question ${n}`,
    question: 'Proceed?',
    options: [],
    status: 'pending',
    reply_route: 'channel',
    mergeable: false,
    absorbed_permission: false,
    informational: false,
    answered_via: null,
    answer_kind: null,
    answer_text: SECRET_ANSWER,
    questions: null,
    answers: null,
    created_at: `2026-11-17T08:${String(n % 60).padStart(2, '0')}:00.000Z`,
    notif_expires_at: '2026-11-17T09:00:00.000Z',
    answered_at: null,
    delivered_at: null,
    ...overrides
  }
}

function message(id: number, text = `message ${id}`): InboxMessage {
  return { id, from: 'peer-b', text, sentAt: `2026-11-17T07:00:${String(id % 60).padStart(2, '0')}.000Z` }
}

function sources(overrides: Partial<InboxRelaySources> = {}): InboxRelaySources {
  return {
    approvals: [approval(1)],
    messages: [{ message: message(1), entry: undefined }],
    closed: [],
    tileName: () => 'Tile one',
    validateQuestions,
    signals: false,
    ...overrides
  }
}

function frameText(content: AvatarInboxContent, seq = 1): string {
  return JSON.stringify(buildAvatarInboxSnapshot(identity, 3, seq, content))
}

function project(input: InboxRelaySources): AvatarInboxContent {
  return projectAvatarInbox(input, (content) => frameText(content, Number.MAX_SAFE_INTEGER))
}

test('the local bounds equal the broker limits they mirror', () => {
  expect([MAX_INBOX_TITLE, MAX_INBOX_REASON, MAX_INBOX_ACTION_TEXT, MAX_INBOX_OPTIONS, MAX_INBOX_OPTION]).toEqual([
    APPROVAL_TITLE_MAX,
    CLOSE_REASON_MAX,
    APPROVAL_ANSWER_MAX,
    APPROVAL_OPTIONS_MAX,
    APPROVAL_OPTION_MAX
  ])
})

test('a snapshot the Deck builds always passes the Avatar parse, with the pick-list only', () => {
  const closed = approval(9, {
    status: 'closed',
    answered_at: '2026-11-17T08:30:00.000Z',
    close_reason: 'answered elsewhere',
    closed_by_authority: 'lead'
  })
  const questions = [{ question: 'Which?', header: 'Pick', options: [{ label: 'One', description: '' }], multi_select: false }]
  const content = project(
    sources({
      approvals: [approval(1, { questions }), approval(2, { status: 'expired_notif', informational: true }), approval(3, { status: 'answered' })],
      messages: [
        { message: message(1), entry: undefined },
        { message: message(2), entry: { state: 'closed', settledAt: '2026-11-17T08:40:00.000Z', closeReason: 'done', closedByAuthority: 'lead' } }
      ],
      closed: [closed]
    })
  )
  const text = frameText(content)
  const parsed = parseAvatarInboxSnapshotFrame(JSON.parse(text), validateQuestions)

  expect(parsed.approvals.map((a) => [a.id, a.status, a.informational])).toEqual([
    [uuid(1), 'pending', false],
    [uuid(2), 'expired_notif', true]
  ])
  expect(parsed.approvals[0]!.questions).toEqual(questions)
  expect(parsed.approvals[0]!.tile_name).toBe('Tile one')
  expect(parsed.messages[1]).toMatchObject({ state: 'closed', closed_by: 'lead', reason: 'done', closed_at: '2026-11-17T08:40:00.000Z' })
  expect(parsed.closed).toEqual([
    {
      id: uuid(9),
      title: 'Question 9',
      closed_at: '2026-11-17T08:30:00.000Z',
      closed_by: 'lead',
      reason: 'answered elsewhere',
      from_peer_id: 'peer-a',
      tile_name: 'Tile one'
    }
  ])
  for (const secret of [SECRET_OPERATOR, SECRET_SESSION, SECRET_ANSWER, 'tile-1', 'os_user_hash', 'github.com/owner/repo']) {
    expect(text, `the frame must not carry ${secret}`).not.toContain(secret)
  }
})

test('the chips of a question travel to the Avatar, bounded and marked when cut', () => {
  const chips = project(sources({ approvals: [approval(1, { options: ['Yes', 'No'] })] }))
  expect(chips.approvals[0]!.options).toEqual(['Yes', 'No'])
  expect(chips.approvals[0]!.cut).toBeUndefined()
  expect(parseAvatarInboxSnapshotFrame(JSON.parse(frameText(chips)), validateQuestions).approvals[0]!.options).toEqual(['Yes', 'No'])

  const many = Array.from({ length: MAX_INBOX_OPTIONS + 2 }, (_, i) => `option ${i}`)
  const capped = project(sources({ approvals: [approval(1, { options: many })] }))
  expect(capped.approvals[0]!.options).toEqual(many.slice(0, MAX_INBOX_OPTIONS))
  expect(capped.approvals[0]!.cut).toBe(true)
  const long = project(sources({ approvals: [approval(1, { options: ['o'.repeat(MAX_INBOX_OPTION + 5)] })] }))
  expect(Array.from(long.approvals[0]!.options[0]!).length).toBe(MAX_INBOX_OPTION)
  expect(long.approvals[0]!.cut).toBe(true)

  const frame = JSON.parse(frameText(chips)) as Record<string, any>
  frame.approvals[0].options = ['o'.repeat(MAX_INBOX_OPTION + 1)]
  expect(() => parseAvatarInboxSnapshotFrame(frame, validateQuestions)).toThrow()
  frame.approvals[0].options = many
  expect(() => parseAvatarInboxSnapshotFrame(frame, validateQuestions)).toThrow()
  delete frame.approvals[0].options
  expect(() => parseAvatarInboxSnapshotFrame(frame, validateQuestions)).toThrow()
})

test('a recommended marker travels with the chips and is kept only inside the options the frame carries', () => {
  const marked = project(sources({ approvals: [approval(1, { options: ['Yes', 'No'], recommended: 1 })] }))
  expect(marked.approvals[0]!.recommended).toBe(1)
  expect(parseAvatarInboxSnapshotFrame(JSON.parse(frameText(marked)), validateQuestions).approvals[0]!.recommended).toBe(1)

  const unmarked = project(
    sources({ approvals: [approval(1, { options: ['Yes', 'No'] }), approval(2, { options: ['Yes'], recommended: null })] })
  )
  expect(
    unmarked.approvals.every((a) => !('recommended' in a)),
    'no marker, no key: a frame without markers is unchanged'
  ).toBe(true)

  const many = Array.from({ length: MAX_INBOX_OPTIONS + 2 }, (_, i) => `option ${i}`)
  const lastKept = project(sources({ approvals: [approval(1, { options: many, recommended: MAX_INBOX_OPTIONS - 1 })] }))
  expect(lastKept.approvals[0]!.recommended).toBe(MAX_INBOX_OPTIONS - 1)
  for (const past of [MAX_INBOX_OPTIONS, MAX_INBOX_OPTIONS + 1]) {
    const dropped = project(sources({ approvals: [approval(1, { options: many, recommended: past })] }))
    expect(dropped.approvals[0]!.options).toHaveLength(MAX_INBOX_OPTIONS)
    expect('recommended' in dropped.approvals[0]!, `marker ${past} points past the kept options`).toBe(false)
  }

  for (const bad of [-1, 2, 0.5, Number.NaN]) {
    const content = project(sources({ approvals: [approval(1, { options: ['Yes', 'No'], recommended: bad })] }))
    expect('recommended' in content.approvals[0]!, `marker ${bad} is no index into two options`).toBe(false)
  }
})

test('the Avatar refuses a recommended marker that is no index into its options, and still refuses an unknown key', () => {
  const base = project(sources({ approvals: [approval(1, { options: ['Yes', 'No'], recommended: 0 })] }))
  const parse = (patch: (approvalRecord: Record<string, any>) => void) => {
    const frame = JSON.parse(frameText(base)) as Record<string, any>
    patch(frame.approvals[0])
    return parseAvatarInboxSnapshotFrame(frame, validateQuestions)
  }

  expect(parse(() => undefined).approvals[0]!.recommended).toBe(0)
  expect(parse((a) => delete a.recommended).approvals[0]!.recommended).toBeUndefined()
  expect(parse((a) => (a.recommended = null)).approvals[0]!.recommended).toBeNull()
  for (const bad of [2, -1, 0.5, '0', true, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => parse((a) => (a.recommended = bad)), `recommended ${String(bad)}`).toThrow('approval recommended')
  }
  expect(() => parse((a) => (a.options = [])), 'a marker with no option to point at').toThrow('approval recommended')
  expect(() => parse((a) => (a.recomended = 0))).toThrow('unknown field recomended')
})

test('the Deck keeps the newest entries of each list and counts the dropped ones', () => {
  const content = project(sources({ approvals: Array.from({ length: MAX_INBOX_APPROVALS + 7 }, (_, i) => approval(i + 1)) }))
  expect(content.approvals).toHaveLength(MAX_INBOX_APPROVALS)
  expect(content.truncated.approvals).toBe(7)
  expect(content.approvals.map((a) => a.id)).not.toContain(uuid(1))
  expect(content.approvals.map((a) => a.id)).toContain(uuid(MAX_INBOX_APPROVALS + 7))
})

test('long texts are cut and marked, and the whole frame stays within its budget', () => {
  const long = 'x'.repeat(MAX_INBOX_TEXT * 3)
  const content = project(
    sources({
      approvals: Array.from({ length: 40 }, (_, i) => approval(i + 1, { question: long })),
      messages: Array.from({ length: 50 }, (_, i) => ({ message: message(i + 1, long), entry: undefined }))
    })
  )
  const text = frameText(content)
  expect(inboxFrameBytes(text)).toBeLessThanOrEqual(MAX_INBOX_FRAME_BYTES)
  expect(content.truncated.messages + content.truncated.approvals).toBeGreaterThan(0)
  expect(content.approvals.every((a) => a.cut === true && Array.from(a.question).length === MAX_INBOX_TEXT)).toBe(true)
  expect(() => parseAvatarInboxSnapshotFrame(JSON.parse(text), validateQuestions)).not.toThrow()
})

test.each([
  ['an Approval member outside the pick-list', (f: Record<string, any>) => { f.approvals[0].operator_id = SECRET_OPERATOR }],
  ['a session_ref on a message', (f: Record<string, any>) => { f.messages[0].session_ref = SECRET_SESSION }],
  ['an extra top-level field', (f: Record<string, any>) => { f.run_ref = 'r' }],
  ['a question over its bound', (f: Record<string, any>) => { f.approvals[0].question = 'q'.repeat(MAX_INBOX_TEXT + 1) }],
  ['a status the Avatar cannot act on', (f: Record<string, any>) => { f.approvals[0].status = 'answered' }],
  ['a seq of zero', (f: Record<string, any>) => { f.seq = 0 }],
  ['malformed structured questions', (f: Record<string, any>) => { f.approvals[0].questions = [{ question: '' }] }],
  ['too many approvals', (f: Record<string, any>) => { f.approvals = Array.from({ length: MAX_INBOX_APPROVALS + 1 }, () => f.approvals[0]) }],
  ['another protocol version', (f: Record<string, any>) => { f.protocol_version = 2 }]
])('the Avatar refuses a snapshot carrying %s', (_what, mutate) => {
  const frame = JSON.parse(frameText(project(sources()))) as Record<string, any>
  mutate(frame)
  expect(() => parseAvatarInboxSnapshotFrame(frame, validateQuestions)).toThrow()
})

test('a closed question relays who closed it, null for a row the broker stamped no authority on', () => {
  const closedAt = '2026-11-17T08:30:00.000Z'
  const content = project(
    sources({
      closed: [
        approval(7, { status: 'closed', answered_at: closedAt, closed_by_authority: 'supervisor' }),
        approval(8, { status: 'closed', answered_at: closedAt })
      ]
    })
  )
  expect(content.closed.map((c) => [c.id, c.closed_by])).toEqual([
    [uuid(7), 'supervisor'],
    [uuid(8), null]
  ])
  const parsed = parseAvatarInboxSnapshotFrame(JSON.parse(frameText(content)), validateQuestions)
  expect(parsed.closed.map((c) => c.closed_by)).toEqual(['supervisor', null])
})

test('a closed question from an older Deck may omit both sender fields', () => {
  const frame = JSON.parse(
    frameText(project(sources({ closed: [approval(9, { status: 'closed', answered_at: '2026-11-17T08:30:00.000Z' })] })))
  ) as Record<string, any>
  delete frame.closed[0].from_peer_id
  delete frame.closed[0].tile_name

  const [closed] = parseAvatarInboxSnapshotFrame(frame, validateQuestions).closed
  expect(closed).not.toHaveProperty('from_peer_id')
  expect(closed).not.toHaveProperty('tile_name')
})

test.each([
  ['an authority outside author, lead and supervisor', (c: Record<string, any>) => { c.closed_by = 'operator' }],
  ['no closed_by at all', (c: Record<string, any>) => { delete c.closed_by }],
  ['a non-string from_peer_id', (c: Record<string, any>) => { c.from_peer_id = 42 }],
  ['a from_peer_id over 64 code points', (c: Record<string, any>) => { c.from_peer_id = 'p'.repeat(MAX_INBOX_PEER_ID + 1) }],
  ['a non-string tile_name', (c: Record<string, any>) => { c.tile_name = { forged: true } }],
  ['a tile_name over 64 code points', (c: Record<string, any>) => { c.tile_name = 't'.repeat(MAX_INBOX_TILE_NAME + 1) }]
])('the Avatar refuses a closed question carrying %s', (_what, mutate) => {
  const frame = JSON.parse(
    frameText(project(sources({ closed: [approval(9, { status: 'closed', answered_at: '2026-11-17T08:30:00.000Z' })] })))
  ) as Record<string, any>
  mutate(frame.closed[0])
  expect(() => parseAvatarInboxSnapshotFrame(frame, validateQuestions)).toThrow()
})

test('an inbox snapshot is not a frame parseAvatarDeckFrame accepts', () => {
  expect(() => parseAvatarDeckFrame(JSON.parse(frameText(project(sources()))))).toThrow()
})

test('parses each inbox action and refuses a payload outside its kind', () => {
  const id = uuid(1)
  expect(parseAvatarInboxAction({ approval_id: id, action: 'allow' })).toEqual({ approval_id: id, action: 'allow' })
  expect(parseAvatarInboxAction({ approval_id: id, action: 'acknowledge' })).toEqual({ approval_id: id, action: 'acknowledge' })
  expect(parseAvatarInboxAction({ approval_id: id, action: 'text', text: 'go' })).toEqual({ approval_id: id, action: 'text', text: 'go' })
  expect(parseAvatarInboxAction({ approval_id: id, action: 'answers', answers: { 'Which?': ['One'] } })).toEqual({
    approval_id: id,
    action: 'answers',
    answers: { 'Which?': ['One'] }
  })
  for (const bad of [
    { approval_id: id, action: 'terminal' },
    { approval_id: id, action: 'handback' },
    { approval_id: 'not-an-id', action: 'allow' },
    { approval_id: `m_${id}`, action: 'allow' },
    { approval_id: id, action: 'text' },
    { approval_id: id, action: 'text', text: '' },
    { approval_id: id, action: 'text', text: 't'.repeat(MAX_INBOX_ACTION_TEXT + 1) },
    { approval_id: id, action: 'allow', text: 'smuggled' },
    { approval_id: id, action: 'answers', answers: ['One'] },
    { approval_id: id, action: 'allow', via: 'deck' }
  ]) {
    expect(() => parseAvatarInboxAction(bad), JSON.stringify(bad)).toThrow()
  }
})

test('the Deck reads an inbox_action command and tells a refused payload from an unknown command', () => {
  const command = { type: 'command' as const, requestId: 'request-1', command: 'inbox_action' as const, ...identity }
  expect(parseAvatarServerFrame({ ...command, inbox: { approval_id: uuid(1), action: 'deny' } })).toEqual({
    ...command,
    inbox: { approval_id: uuid(1), action: 'deny' }
  })
  const refused = { ...command, inbox: { approval_id: uuid(1), action: 'terminal' } }
  expect(() => parseAvatarServerFrame(refused)).toThrow()
  expect(invalidInboxActionRequestId(refused)).toBe('request-1')
  expect(unsupportedAvatarCommandRequestId(refused)).toBeNull()
  expect(invalidInboxActionRequestId({ ...command, command: 'restart' })).toBeNull()
})

test('a command result carries an inbox outcome and its reason, within bounds', () => {
  expect(parseAvatarDeckFrame({ type: 'command_result', requestId: 'request-1', ok: true, outcome: 'refused', reason: 'gone' })).toEqual({
    type: 'command_result',
    requestId: 'request-1',
    ok: true,
    outcome: 'refused',
    reason: 'gone'
  })
  expect(() => parseAvatarDeckFrame({ type: 'command_result', requestId: 'request-1', ok: true, outcome: 'maybe' })).toThrow()
  expect(() => parseAvatarDeckFrame({ type: 'command_result', requestId: 'request-1', ok: true, reason: 'r'.repeat(257) })).toThrow()
})

const dangerEntry = (n: number, patch: Partial<DangerViewEntry> = {}): DangerViewEntry => ({
  id: `kory/rule-${n}`,
  source: 'kory',
  message: `message ${n}`,
  messageFrom: 'deck',
  known: true,
  confirmed: true,
  ...patch
})

const permission = (entries: DangerViewEntry[], text_flags: Approval['text_flags'] = ['bidi']): Approval =>
  approval(1, { kind: 'permission', reply_route: 'hook', text_flags, danger_view: { reevaluation: 'partial', entries } })

const parsedFirst = (content: AvatarInboxContent) =>
  parseAvatarInboxSnapshotFrame(JSON.parse(frameText(content)), validateQuestions).approvals[0]!

test('text flags and the danger view reach only an Avatar that negotiated them', () => {
  const approvals = [permission([dangerEntry(1)])]
  const sent = parsedFirst(project(sources({ approvals, signals: true })))
  expect(sent.text_flags).toEqual(['bidi'])
  expect(sent.danger_view).toEqual({ reevaluation: 'partial', entries: [dangerEntry(1)] })
  expect(sent.cut, 'signals within the bounds do not cut the approval').toBeUndefined()

  const older = project(sources({ approvals })).approvals[0]!
  expect(Object.keys(older).filter((key) => key === 'text_flags' || key === 'danger_view')).toEqual([])
  expect(older.cut).toBeUndefined()
})

test('a signal the relay cannot carry whole marks the approval cut, so it is never allowed from a partial list', () => {
  const relayed = (source: Approval) => parsedFirst(project(sources({ approvals: [source], signals: true })))
  const bound = Array.from({ length: MAX_INBOX_DANGER }, (_, i) => dangerEntry(i))
  expect(relayed(permission(bound)).cut).toBeUndefined()

  const many = relayed(permission([...bound, dangerEntry(99)]))
  expect(many.danger_view!.entries.map((e) => e.id)).toEqual(bound.map((e) => e.id))
  expect(many.cut).toBe(true)
  expect(inboxActionAllowed(many, 'allow')).toBe(false)

  const longId = relayed(permission([dangerEntry(1), dangerEntry(2, { id: `repo/${'a'.repeat(MAX_INBOX_DANGER_ID)}`, source: 'repo' })]))
  expect(longId.danger_view!.entries.map((e) => e.id), 'an id is never shortened into another rule name').toEqual(['kory/rule-1'])
  expect(longId.cut).toBe(true)

  const longMessage = relayed(permission([dangerEntry(1, { message: 'm'.repeat(MAX_INBOX_DANGER_MESSAGE + 1) })]))
  expect(longMessage.danger_view!.entries[0]!.message).toHaveLength(MAX_INBOX_DANGER_MESSAGE)
  expect(longMessage.cut).toBe(true)

  const unknownFlag = relayed(permission([], ['bidi', 'novel' as never]))
  expect(unknownFlag.text_flags).toEqual(['bidi'])
  expect(unknownFlag.cut).toBe(true)
})

test('the Avatar parse refuses a signal outside its bounds or its closed sets', () => {
  const base = project(sources({ approvals: [permission([dangerEntry(1)])], signals: true }))
  const parse = (patch: Record<string, unknown>) =>
    parseAvatarInboxSnapshotFrame(
      JSON.parse(frameText({ ...base, approvals: [{ ...base.approvals[0]!, ...patch }] })),
      validateQuestions
    )
  const view = (entries: unknown[], extra: Record<string, unknown> = {}) => ({ danger_view: { reevaluation: 'done', entries, ...extra } })
  expect(() => parse({}), 'the untouched frame is accepted').not.toThrow()
  expect(() => parse(view([dangerEntry(1, { message: null })]))).not.toThrow()

  const refused: Array<[string, Record<string, unknown>]> = [
    ['unknown flag', { text_flags: ['novel'] }],
    ['too many flags', { text_flags: ['bidi', 'bidi', 'bidi', 'bidi'] }],
    ['flags not a list', { text_flags: 'bidi' }],
    ['too many entries', view(Array.from({ length: MAX_INBOX_DANGER + 1 }, (_, i) => dangerEntry(i)))],
    ['long id', view([dangerEntry(1, { id: 'a'.repeat(MAX_INBOX_DANGER_ID + 1) })])],
    ['empty id', view([dangerEntry(1, { id: '' })])],
    ['long message', view([dangerEntry(1, { message: 'm'.repeat(MAX_INBOX_DANGER_MESSAGE + 1) })])],
    ['unknown source', view([dangerEntry(1, { source: 'agent' as never })])],
    ['unknown voice', view([dangerEntry(1, { messageFrom: 'kory' as never })])],
    ['known not a boolean', view([dangerEntry(1, { known: 'yes' as never })])],
    ['confirmed not a boolean', view([dangerEntry(1, { confirmed: 1 as never })])],
    ['extra entry field', view([{ ...dangerEntry(1), command: 'x' }])],
    ['extra view field', view([], { raw: [] })],
    ['unknown reevaluation', { danger_view: { reevaluation: 'safe', entries: [] } }]
  ]
  for (const [name, patch] of refused) expect(() => parse(patch), name).toThrow()
})
