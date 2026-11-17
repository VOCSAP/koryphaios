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
  inboxFrameBytes,
  MAX_INBOX_ACTION_TEXT,
  MAX_INBOX_APPROVALS,
  MAX_INBOX_FRAME_BYTES,
  MAX_INBOX_OPTION,
  MAX_INBOX_OPTIONS,
  MAX_INBOX_REASON,
  MAX_INBOX_TEXT,
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
import type { Approval, InboxMessage } from '../desktop/src/shared/types.ts'

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
  const closed = approval(9, { status: 'closed', answered_at: '2026-11-17T08:30:00.000Z', close_reason: 'answered elsewhere' })
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
  expect(parsed.closed).toEqual([{ id: uuid(9), title: 'Question 9', closed_at: '2026-11-17T08:30:00.000Z', reason: 'answered elsewhere' }])
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
