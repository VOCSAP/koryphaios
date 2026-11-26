import type { AvatarDeckIdentity } from './avatar-state'
import type {
  Approval,
  ApprovalKind,
  ApprovalQuestion,
  ApprovalReplyRoute,
  ApprovalTextFlag,
  DangerView,
  DangerViewEntry,
  InboxCloseAuthority,
  InboxEntryState,
  InboxMessage
} from './types'

export const AVATAR_INBOX_PROTOCOL_VERSION = 1
/** Below the WebSocket maxPayload, so a frame the Deck built is never cut by the transport. */
export const MAX_INBOX_FRAME_BYTES = 56 * 1024
export const MAX_INBOX_APPROVALS = 50
export const MAX_INBOX_MESSAGES = 50
export const MAX_INBOX_CLOSED = 20
/** Equal to APPROVAL_TITLE_MAX, CLOSE_REASON_MAX and APPROVAL_ANSWER_MAX: that module is outside the renderer's program. */
export const MAX_INBOX_TITLE = 200
export const MAX_INBOX_REASON = 500
export const MAX_INBOX_ACTION_TEXT = 4_000
export const MAX_INBOX_TEXT = 2_000
export const MAX_INBOX_PEER_ID = 64
export const MAX_INBOX_TILE_NAME = 64
/** Equal to APPROVAL_OPTIONS_MAX and APPROVAL_OPTION_MAX. */
export const MAX_INBOX_OPTIONS = 10
export const MAX_INBOX_OPTION = 200
export const MAX_INBOX_TIMESTAMP = 64
export const MAX_INBOX_OUTCOME_REASON = 256
export const MAX_INBOX_DANGER = 16
/** Equal to the broker's danger id bound and to the longest rule message the Deck accepts. */
export const MAX_INBOX_DANGER_ID = 80
export const MAX_INBOX_DANGER_MESSAGE = 400

/** The broker's own validator of agent-written questions, injected by the main-process caller. */
export type InboxQuestionsValidator = (raw: unknown) => { ok: true; value: ApprovalQuestion[] } | { ok: false; error: string }

const APPROVAL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function isApprovalId(value: unknown): value is string {
  return typeof value === 'string' && APPROVAL_ID_PATTERN.test(value)
}

export const INBOX_ACTIONS = ['allow', 'deny', 'text', 'answers', 'acknowledge'] as const
export const INBOX_OUTCOMES = ['won', 'lost', 'refused'] as const
export type InboxActionKind = (typeof INBOX_ACTIONS)[number]
export type InboxOutcome = (typeof INBOX_OUTCOMES)[number]

const APPROVAL_KINDS: readonly ApprovalKind[] = ['permission', 'question', 'plan']
const REPLY_ROUTES: readonly ApprovalReplyRoute[] = ['channel', 'pty', 'hook']
const RELAYED_STATUSES = ['pending', 'expired_notif'] as const
const MESSAGE_STATES = ['open', 'responded', 'closed'] as const
const CLOSE_AUTHORITIES: readonly InboxCloseAuthority[] = ['author', 'lead', 'supervisor']
const TEXT_FLAGS: readonly ApprovalTextFlag[] = ['bidi', 'control', 'invisible']
const DANGER_SOURCES: readonly DangerViewEntry['source'][] = ['kory', 'user', 'repo']
const DANGER_VOICES: readonly DangerViewEntry['messageFrom'][] = ['deck', 'agent']
const REEVALUATIONS: readonly DangerView['reevaluation'][] = ['done', 'partial', 'unavailable']

export interface InboxRelayApproval {
  id: string
  kind: ApprovalKind
  status: (typeof RELAYED_STATUSES)[number]
  informational: boolean
  reply_route: ApprovalReplyRoute
  mergeable: boolean
  absorbed_permission: boolean
  title: string
  question: string
  options: string[]
  /** Index into `options` of the answer the agent recommends; absent when it names none. */
  recommended?: number | null
  questions: ApprovalQuestion[] | null
  created_at: string
  from_peer_id: string
  tile_name: string | null
  cut?: true
  /** Both sent only to an Avatar that negotiated a3_inbox_signals. */
  text_flags?: ApprovalTextFlag[]
  danger_view?: DangerView
}

export interface InboxRelayMessage {
  id: number
  from_peer_id: string
  text: string
  sent_at: string
  state: (typeof MESSAGE_STATES)[number]
  closed_at: string | null
  closed_by: InboxCloseAuthority | null
  reason: string | null
  cut?: true
}

export interface InboxRelayClosed {
  id: string
  title: string
  closed_at: string
  closed_by: InboxCloseAuthority | null
  reason: string | null
  from_peer_id?: string
  tile_name?: string | null
}

export interface InboxTruncation {
  approvals: number
  messages: number
  closed: number
}

export interface AvatarInboxContent {
  approvals: InboxRelayApproval[]
  messages: InboxRelayMessage[]
  closed: InboxRelayClosed[]
  truncated: InboxTruncation
}

export interface AvatarInboxSnapshotFrame extends AvatarDeckIdentity, AvatarInboxContent {
  type: 'inbox_snapshot'
  protocol_version: typeof AVATAR_INBOX_PROTOCOL_VERSION
  scope_generation: number
  seq: number
}

export interface AvatarInboxAction {
  approval_id: string
  action: InboxActionKind
  text?: string
  answers?: Record<string, string[]>
}

export class AvatarInboxProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AvatarInboxProtocolError'
  }
}

function invalid(what: string): never {
  throw new AvatarInboxProtocolError(`invalid Avatar inbox frame: ${what}`)
}

function codePoints(value: string): number {
  return Array.from(value).length
}

function cut(value: string, max: number): { value: string; cut: boolean } {
  const points = Array.from(value)
  return points.length <= max ? { value, cut: false } : { value: points.slice(0, max).join(''), cut: true }
}

function exactRecord(value: unknown, keys: readonly string[], optional: readonly string[], what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(what)
  const input = value as Record<string, unknown>
  for (const key of Object.keys(input)) {
    if (!keys.includes(key) && !optional.includes(key)) invalid(`${what} carries an unknown field ${key}`)
  }
  for (const key of keys) if (!(key in input)) invalid(`${what} misses ${key}`)
  return input
}

function boundedString(value: unknown, max: number, what: string, allowEmpty = true): string {
  if (typeof value !== 'string' || codePoints(value) > max || (!allowEmpty && value.length === 0)) invalid(what)
  return value
}

function nullableString(value: unknown, max: number, what: string): string | null {
  return value === null ? null : boundedString(value, max, what)
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (!(allowed as readonly unknown[]).includes(value)) invalid(what)
  return value as T
}

function bool(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') invalid(what)
  return value
}

function count(value: unknown, what: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) invalid(what)
  return value
}

function cutFlag(value: unknown, what: string): { cut?: true } {
  if (value === undefined) return {}
  if (value !== true) invalid(what)
  return { cut: true }
}

function boundedList<T>(value: unknown, max: number, what: string, item: (raw: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) invalid(what)
  return value.map(item)
}

const APPROVAL_FIELDS = [
  'id',
  'kind',
  'status',
  'informational',
  'reply_route',
  'mergeable',
  'absorbed_permission',
  'title',
  'question',
  'options',
  'questions',
  'created_at',
  'from_peer_id',
  'tile_name'
] as const
const DANGER_ENTRY_FIELDS = ['id', 'source', 'message', 'messageFrom', 'known', 'confirmed'] as const
const MESSAGE_FIELDS =['id', 'from_peer_id', 'text', 'sent_at', 'state', 'closed_at', 'closed_by', 'reason'] as const
const CLOSED_FIELDS = ['id', 'title', 'closed_at', 'closed_by', 'reason'] as const
const FRAME_FIELDS = [
  'type',
  'protocol_version',
  'deckRunId',
  'broker_url',
  'scope_generation',
  'seq',
  'approvals',
  'messages',
  'closed',
  'truncated'
] as const

function parseQuestions(value: unknown, validateQuestions: InboxQuestionsValidator): ApprovalQuestion[] | null {
  if (value === null) return null
  const result = validateQuestions(value)
  if (!result.ok) invalid('approval questions')
  return result.value
}

function parseRecommended(value: unknown, optionCount: number): { recommended?: number | null } {
  if (value === undefined) return {}
  if (value === null) return { recommended: null }
  const index = count(value, 'approval recommended')
  if (index >= optionCount) invalid('approval recommended')
  return { recommended: index }
}

function parseTextFlags(value: unknown): { text_flags?: ApprovalTextFlag[] } {
  if (value === undefined) return {}
  return { text_flags: boundedList(value, TEXT_FLAGS.length, 'approval text_flags', (flag) => oneOf(flag, TEXT_FLAGS, 'approval text flag')) }
}

function parseDangerEntry(raw: unknown): DangerViewEntry {
  const input = exactRecord(raw, DANGER_ENTRY_FIELDS, [], 'danger entry')
  return {
    id: boundedString(input.id, MAX_INBOX_DANGER_ID, 'danger id', false),
    source: oneOf(input.source, DANGER_SOURCES, 'danger source'),
    message: nullableString(input.message, MAX_INBOX_DANGER_MESSAGE, 'danger message'),
    messageFrom: oneOf(input.messageFrom, DANGER_VOICES, 'danger messageFrom'),
    known: bool(input.known, 'danger known'),
    confirmed: bool(input.confirmed, 'danger confirmed')
  }
}

function parseDangerView(value: unknown): { danger_view?: DangerView } {
  if (value === undefined) return {}
  const input = exactRecord(value, ['reevaluation', 'entries'], [], 'danger_view')
  return {
    danger_view: {
      reevaluation: oneOf(input.reevaluation, REEVALUATIONS, 'danger reevaluation'),
      entries: boundedList(input.entries, MAX_INBOX_DANGER, 'danger entries', parseDangerEntry)
    }
  }
}

function parseApproval(raw: unknown, validateQuestions: InboxQuestionsValidator): InboxRelayApproval {
  const input = exactRecord(raw, APPROVAL_FIELDS, ['cut', 'recommended', 'text_flags', 'danger_view'], 'approval')
  if (!isApprovalId(input.id)) invalid('approval id')
  const options = boundedList(input.options, MAX_INBOX_OPTIONS, 'approval options', (raw) =>
    boundedString(raw, MAX_INBOX_OPTION, 'approval option')
  )
  return {
    id: input.id as string,
    kind: oneOf(input.kind, APPROVAL_KINDS, 'approval kind'),
    status: oneOf(input.status, RELAYED_STATUSES, 'approval status'),
    informational: bool(input.informational, 'approval informational'),
    reply_route: oneOf(input.reply_route, REPLY_ROUTES, 'approval reply_route'),
    mergeable: bool(input.mergeable, 'approval mergeable'),
    absorbed_permission: bool(input.absorbed_permission, 'approval absorbed_permission'),
    title: boundedString(input.title, MAX_INBOX_TITLE, 'approval title'),
    question: boundedString(input.question, MAX_INBOX_TEXT, 'approval question'),
    options,
    ...parseRecommended(input.recommended, options.length),
    questions: parseQuestions(input.questions, validateQuestions),
    created_at: boundedString(input.created_at, MAX_INBOX_TIMESTAMP, 'approval created_at'),
    from_peer_id: boundedString(input.from_peer_id, MAX_INBOX_PEER_ID, 'approval from_peer_id'),
    tile_name: nullableString(input.tile_name, MAX_INBOX_TILE_NAME, 'approval tile_name'),
    ...cutFlag(input.cut, 'approval cut'),
    ...parseTextFlags(input.text_flags),
    ...parseDangerView(input.danger_view)
  }
}

function parseMessage(raw: unknown): InboxRelayMessage {
  const input = exactRecord(raw, MESSAGE_FIELDS, ['cut'], 'message')
  return {
    id: count(input.id, 'message id', 1),
    from_peer_id: boundedString(input.from_peer_id, MAX_INBOX_PEER_ID, 'message from_peer_id'),
    text: boundedString(input.text, MAX_INBOX_TEXT, 'message text'),
    sent_at: boundedString(input.sent_at, MAX_INBOX_TIMESTAMP, 'message sent_at'),
    state: oneOf(input.state, MESSAGE_STATES, 'message state'),
    closed_at: nullableString(input.closed_at, MAX_INBOX_TIMESTAMP, 'message closed_at'),
    closed_by: input.closed_by === null ? null : oneOf(input.closed_by, CLOSE_AUTHORITIES, 'message closed_by'),
    reason: nullableString(input.reason, MAX_INBOX_REASON, 'message reason'),
    ...cutFlag(input.cut, 'message cut')
  }
}

function parseClosed(raw: unknown): InboxRelayClosed {
  const input = exactRecord(raw, CLOSED_FIELDS, ['from_peer_id', 'tile_name'], 'closed question')
  if (!isApprovalId(input.id)) invalid('closed question id')
  return {
    id: input.id as string,
    title: boundedString(input.title, MAX_INBOX_TITLE, 'closed question title'),
    closed_at: boundedString(input.closed_at, MAX_INBOX_TIMESTAMP, 'closed question closed_at'),
    closed_by: input.closed_by === null ? null : oneOf(input.closed_by, CLOSE_AUTHORITIES, 'closed question closed_by'),
    reason: nullableString(input.reason, MAX_INBOX_REASON, 'closed question reason'),
    ...(input.from_peer_id === undefined
      ? {}
      : { from_peer_id: boundedString(input.from_peer_id, MAX_INBOX_PEER_ID, 'closed question from_peer_id') }),
    ...(input.tile_name === undefined
      ? {}
      : { tile_name: nullableString(input.tile_name, MAX_INBOX_TILE_NAME, 'closed question tile_name') })
  }
}

export function inboxFrameBytes(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * Validates the body of an inbox_snapshot whose type, version and Deck identity
 * the caller has already checked. Every field outside the pick-list is refused,
 * so a projection that leaks an Approval member cannot reach the Avatar.
 */
export function parseAvatarInboxContent(
  value: unknown,
  validateQuestions: InboxQuestionsValidator
): Omit<AvatarInboxSnapshotFrame, 'deckRunId' | 'broker_url' | 'protocol_version'> {
  const input = exactRecord(value, FRAME_FIELDS, [], 'inbox snapshot')
  if (input.type !== 'inbox_snapshot') invalid('type')
  const truncated = exactRecord(input.truncated, ['approvals', 'messages', 'closed'], [], 'truncated')
  return {
    type: 'inbox_snapshot',
    scope_generation: count(input.scope_generation, 'scope_generation'),
    seq: count(input.seq, 'seq', 1),
    approvals: boundedList(input.approvals, MAX_INBOX_APPROVALS, 'approvals', (raw) => parseApproval(raw, validateQuestions)),
    messages: boundedList(input.messages, MAX_INBOX_MESSAGES, 'messages', parseMessage),
    closed: boundedList(input.closed, MAX_INBOX_CLOSED, 'closed', parseClosed),
    truncated: {
      approvals: count(truncated.approvals, 'truncated approvals'),
      messages: count(truncated.messages, 'truncated messages'),
      closed: count(truncated.closed, 'truncated closed')
    }
  }
}

export interface InboxRelayMessageSource {
  message: InboxMessage
  entry: InboxEntryState | undefined
}

export interface InboxRelaySources {
  approvals: readonly Approval[]
  messages: readonly InboxRelayMessageSource[]
  closed: readonly Approval[]
  tileName(approval: Approval): string | null
  validateQuestions: InboxQuestionsValidator
  /** True when this Avatar negotiated a3_inbox_signals; an older one refuses the two signal fields. */
  signals: boolean
}

/**
 * The warning signals of an approval within the relay's bounds. `cut` is true
 * when any of them could not be carried whole, so the approval is marked and
 * cannot be allowed from a partial list.
 */
function projectSignals(approval: Approval): { cut: boolean; fields: Pick<InboxRelayApproval, 'text_flags' | 'danger_view'> } {
  const raised: readonly ApprovalTextFlag[] = approval.text_flags ?? []
  const flags = TEXT_FLAGS.filter((flag) => raised.includes(flag))
  let lost = raised.some((flag) => !TEXT_FLAGS.includes(flag))
  const view = approval.danger_view
  const fitting = (view?.entries ?? []).filter((entry) => codePoints(entry.id) <= MAX_INBOX_DANGER_ID)
  const entries = fitting.slice(0, MAX_INBOX_DANGER).map((entry) => {
    const message = entry.message === null ? null : cut(entry.message, MAX_INBOX_DANGER_MESSAGE)
    if (message?.cut) lost = true
    return { ...entry, message: message?.value ?? null }
  })
  if (entries.length !== (view?.entries.length ?? 0)) lost = true
  return {
    cut: lost,
    fields: {
      ...(flags.length > 0 ? { text_flags: flags } : {}),
      ...(view ? { danger_view: { reevaluation: view.reevaluation, entries } } : {})
    }
  }
}

function projectApproval(
  approval: Approval,
  tileName: string | null,
  validateQuestions: InboxQuestionsValidator,
  signals: boolean
): InboxRelayApproval | null {
  if (approval.status !== 'pending' && approval.status !== 'expired_notif') return null
  const title = cut(approval.title, MAX_INBOX_TITLE)
  const question = cut(approval.question, MAX_INBOX_TEXT)
  const options = approval.options.slice(0, MAX_INBOX_OPTIONS).map((option) => cut(option, MAX_INBOX_OPTION))
  const optionsCut = approval.options.length > MAX_INBOX_OPTIONS || options.some((option) => option.cut)
  const recommended = approval.recommended
  const keepsMarker =
    typeof recommended === 'number' && Number.isSafeInteger(recommended) && recommended >= 0 && recommended < options.length
  const from = cut(approval.origin.from_peer, MAX_INBOX_PEER_ID)
  const createdAt = cut(approval.created_at, MAX_INBOX_TIMESTAMP)
  const tile = tileName === null ? null : cut(tileName, MAX_INBOX_TILE_NAME)
  const questions = approval.questions === null ? null : validateQuestions(approval.questions)
  const questionsLost = questions !== null && !questions.ok
  const signal = signals ? projectSignals(approval) : null
  const wasCut =
    title.cut || question.cut || optionsCut || from.cut || createdAt.cut || (tile?.cut ?? false) || questionsLost || (signal?.cut ?? false)
  return {
    id: approval.id,
    kind: approval.kind,
    status: approval.status,
    informational: approval.informational,
    reply_route: approval.reply_route,
    mergeable: approval.mergeable,
    absorbed_permission: approval.absorbed_permission,
    title: title.value,
    question: question.value,
    options: options.map((option) => option.value),
    ...(keepsMarker ? { recommended } : {}),
    questions: questions !== null && questions.ok ? questions.value : null,
    created_at: createdAt.value,
    from_peer_id: from.value,
    tile_name: tile?.value ?? null,
    ...(wasCut ? { cut: true as const } : {}),
    ...signal?.fields
  }
}

function projectMessage({ message, entry }: InboxRelayMessageSource): InboxRelayMessage {
  const from = cut(message.from, MAX_INBOX_PEER_ID)
  const text = cut(message.text, MAX_INBOX_TEXT)
  const sentAt = cut(message.sentAt, MAX_INBOX_TIMESTAMP)
  const closed = entry?.state === 'closed'
  const closedAt = closed && entry.settledAt !== null ? cut(entry.settledAt, MAX_INBOX_TIMESTAMP) : null
  const reason = closed && entry.closeReason !== undefined ? cut(entry.closeReason, MAX_INBOX_REASON) : null
  const wasCut = from.cut || text.cut || sentAt.cut || (closedAt?.cut ?? false) || (reason?.cut ?? false)
  return {
    id: message.id,
    from_peer_id: from.value,
    text: text.value,
    sent_at: sentAt.value,
    state: entry?.state ?? 'open',
    closed_at: closedAt?.value ?? null,
    closed_by: closed ? (entry.closedByAuthority ?? null) : null,
    reason: reason?.value ?? null,
    ...(wasCut ? { cut: true as const } : {})
  }
}

function projectClosed(approval: Approval, tileName: string | null): InboxRelayClosed {
  return {
    id: approval.id,
    title: cut(approval.title, MAX_INBOX_TITLE).value,
    closed_at: cut(approval.answered_at ?? approval.created_at, MAX_INBOX_TIMESTAMP).value,
    closed_by: approval.closed_by_authority ?? null,
    reason: approval.close_reason === undefined ? null : cut(approval.close_reason, MAX_INBOX_REASON).value,
    from_peer_id: cut(approval.origin.from_peer, MAX_INBOX_PEER_ID).value,
    tile_name: tileName === null ? null : cut(tileName, MAX_INBOX_TILE_NAME).value
  }
}

function newestLast<T>(items: readonly T[], key: (item: T) => string | number): T[] {
  return [...items].sort((a, b) => {
    const left = key(a)
    const right = key(b)
    return left < right ? -1 : left > right ? 1 : 0
  })
}

function keepNewest<T>(items: T[], max: number): { kept: T[]; dropped: number } {
  return items.length <= max ? { kept: items, dropped: 0 } : { kept: items.slice(items.length - max), dropped: items.length - max }
}

/**
 * The inbox content the Deck relays: each source reduced to its pick-list,
 * oldest entries dropped first, texts cut and marked, until the whole frame
 * fits MAX_INBOX_FRAME_BYTES. Closed questions go first, then messages, then
 * the approvals the operator can still act on.
 */
export function projectAvatarInbox(sources: InboxRelaySources, frame: (content: AvatarInboxContent) => string): AvatarInboxContent {
  const approvals = keepNewest(
    newestLast(
      sources.approvals.flatMap((a) => projectApproval(a, sources.tileName(a), sources.validateQuestions, sources.signals) ?? []),
      (a) => a.created_at
    ),
    MAX_INBOX_APPROVALS
  )
  const messages = keepNewest(newestLast(sources.messages.map(projectMessage), (m) => m.id), MAX_INBOX_MESSAGES)
  const closed = keepNewest(
    newestLast(sources.closed.map((approval) => projectClosed(approval, sources.tileName(approval))), (c) => c.closed_at),
    MAX_INBOX_CLOSED
  )
  const content: AvatarInboxContent = {
    approvals: approvals.kept,
    messages: messages.kept,
    closed: closed.kept,
    truncated: { approvals: approvals.dropped, messages: messages.dropped, closed: closed.dropped }
  }
  const order: Array<'closed' | 'messages' | 'approvals'> = ['closed', 'messages', 'approvals']
  while (inboxFrameBytes(frame(content)) > MAX_INBOX_FRAME_BYTES) {
    const list = order.find((name) => content[name].length > 0)
    if (list === undefined) break
    content[list].shift()
    content.truncated[list] += 1
  }
  return content
}

export function buildAvatarInboxSnapshot(
  identity: AvatarDeckIdentity,
  scopeGeneration: number,
  seq: number,
  content: AvatarInboxContent
): AvatarInboxSnapshotFrame {
  return {
    type: 'inbox_snapshot',
    protocol_version: AVATAR_INBOX_PROTOCOL_VERSION,
    deckRunId: identity.deckRunId,
    broker_url: identity.broker_url,
    scope_generation: scopeGeneration,
    seq,
    approvals: content.approvals,
    messages: content.messages,
    closed: content.closed,
    truncated: content.truncated
  }
}

/**
 * The gestures the Courrier offers on a relayed approval, and none on a cut
 * one but deny and acknowledge: the operator must not approve text it was not
 * shown in full.
 */
export function inboxActionAllowed(approval: InboxRelayApproval, action: InboxActionKind): boolean {
  if (approval.cut === true && action !== 'deny' && action !== 'acknowledge') return false
  switch (action) {
    case 'allow':
    case 'deny':
      return !approval.informational && !approval.absorbed_permission
    case 'text':
      return approval.kind !== 'permission' && !approval.absorbed_permission && !approval.informational
    case 'answers':
      return approval.questions !== null && !approval.informational
    case 'acknowledge':
      return approval.kind !== 'permission' && approval.reply_route === 'channel' && !approval.mergeable
  }
}

/** The payload of an inbox_action command; text and answers are refused, never cut. */
export function parseAvatarInboxAction(value: unknown): AvatarInboxAction {
  const input = exactRecord(value, ['approval_id', 'action'], ['text', 'answers'], 'inbox action')
  if (!isApprovalId(input.approval_id)) invalid('inbox action approval_id')
  const action = oneOf(input.action, INBOX_ACTIONS, 'inbox action kind')
  if (action === 'text') {
    if (input.answers !== undefined) invalid('inbox action text carries answers')
    return { approval_id: input.approval_id as string, action, text: boundedString(input.text, MAX_INBOX_ACTION_TEXT, 'inbox action text', false) }
  }
  if (action === 'answers') {
    if (input.text !== undefined) invalid('inbox action answers carries text')
    if (!input.answers || typeof input.answers !== 'object' || Array.isArray(input.answers)) invalid('inbox action answers')
    return { approval_id: input.approval_id as string, action, answers: input.answers as Record<string, string[]> }
  }
  if (input.text !== undefined || input.answers !== undefined) invalid(`inbox action ${action} carries a payload`)
  return { approval_id: input.approval_id as string, action }
}
