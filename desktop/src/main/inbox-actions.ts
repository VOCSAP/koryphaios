// The Deck main's half of the agent inbox tools: it checks the shape of what a
// tile sent, wraps the tile's author proof (signed by the run root) in an
// envelope signed by the caller's mandate, calls the run's broker once, and
// maps the HTTP status to a typed outcome. No electron import: bun tests load it.

import { buildInboxProof, INBOX_GATES } from './approval-auth'
import { isInboxEntryId, validateCloseReason } from '../../../shared/approval'
import type { InboxListItem, InboxListResponse } from '../../../shared/types'
import { inboxEntryKey, type InboxAckStatus, type InboxMessage } from '../shared/types'
import type { AnnounceDeps } from './broker-client'
import type { ReadyMandate } from './approval-runtime'
import type { CallerAuthority } from './deck-control'
import { logInfo, reportError } from './log'

const INSTANCE_TOKEN_MAX = 128
const CURSOR_MAX = 256
const BROKER_TIMEOUT_MS = 20_000

const LIST_PAYLOAD_KEYS = ['inbox_operation', 'instance_token']
const CLOSE_PAYLOAD_KEYS = ['entry_id', 'inbox_operation', 'instance_token', 'reason']

type AuthorProof = { payload: Record<string, string>; auth: Record<string, unknown> }

export type InboxActionRequest =
  | { op: 'list'; cursor: string | undefined; author: AuthorProof }
  | { op: 'close'; entryId: string; author: AuthorProof }

/** What an agent sees of one entry: the broker's pick-list without the Deck's local key. */
export type AgentInboxItem = Pick<InboxListItem, 'id' | 'type' | 'author' | 'created_at' | 'text' | 'closable'>

export type InboxActionOutcome =
  | { outcome: 'listed'; entries: AgentInboxItem[]; next_cursor: string | null }
  | { outcome: 'closed'; id: string }
  | { outcome: 'settled'; state: string }
  | { outcome: 'unknown' }
  | { outcome: 'forbidden' }
  | { outcome: 'not-closable' }
  | { outcome: 'invalid'; message: string }
  | { outcome: 'unavailable'; cause: string }

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function hasExactKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(o).sort()
  return own.length === keys.length && own.every((k, i) => k === keys[i])
}

/**
 * The body a tile posts to deck-control's /inbox (hostile input #4: the
 * strings come from an agent). The author payload must carry exactly the keys
 * of its operation, so it can assert no role or authority; the reason must
 * already be the cleaned value the tile signed. Other top-level members are
 * ignored, never forwarded.
 */
export function parseInboxRequest(body: unknown): InboxActionRequest | { invalid: string } {
  if (!isPlainObject(body)) return { invalid: 'the request must be an object' }
  const op = body.op
  if (op !== 'list' && op !== 'close') return { invalid: 'op must be list or close' }
  const author = body.author
  if (!isPlainObject(author) || !isPlainObject(author.payload) || !isPlainObject(author.auth)) {
    return { invalid: 'author proof is malformed' }
  }
  const payload = author.payload
  if (!hasExactKeys(payload, op === 'list' ? LIST_PAYLOAD_KEYS : CLOSE_PAYLOAD_KEYS)) {
    return { invalid: 'author payload carries unexpected fields' }
  }
  if (payload.inbox_operation !== op) return { invalid: 'author payload does not match op' }
  const token = payload.instance_token
  if (typeof token !== 'string' || token.length === 0 || token.length > INSTANCE_TOKEN_MAX) {
    return { invalid: 'instance_token is invalid' }
  }
  if (op === 'list') {
    const cursor = body.cursor
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > CURSOR_MAX)) {
      return { invalid: 'cursor is invalid' }
    }
    return {
      op,
      cursor: cursor as string | undefined,
      author: { payload: { inbox_operation: 'list', instance_token: token }, auth: author.auth }
    }
  }
  const entryId = payload.entry_id
  if (!isInboxEntryId(entryId)) return { invalid: 'id is not an inbox entry id' }
  const reason = validateCloseReason(payload.reason)
  if (!reason.ok) return { invalid: reason.error }
  if (reason.value !== payload.reason) return { invalid: 'reason must be signed in its cleaned form' }
  return {
    op,
    entryId,
    author: {
      payload: { inbox_operation: 'close', entry_id: entryId, reason: reason.value, instance_token: token },
      auth: author.auth
    }
  }
}

export interface LocalCourrier {
  history: InboxMessage[]
  acks: Record<string, InboxAckStatus>
}

export interface InboxActionDeps {
  mandate(callerId: string, tile: string, signal: AbortSignal): Promise<ReadyMandate | null>
  /** The Courrier's local state, read when a list is filtered. */
  localCourrier(): LocalCourrier
  fetchFn?: AnnounceDeps['fetchFn']
}

/**
 * A message the operator already dismissed, or one this Deck never received,
 * is not shown to an agent as waiting; questions are settled at the broker.
 */
function keptByCourrier(item: InboxListItem, local: LocalCourrier): boolean {
  if (item.type !== 'message') return true
  const message = local.history.find((m) => m.id === item.message_id && m.sentAt === item.sent_at)
  if (!message) return false
  return local.acks[inboxEntryKey({ kind: 'message', message })] !== 'acked'
}

const toAgentItem = (item: InboxListItem): AgentInboxItem => ({
  id: item.id,
  type: item.type,
  author: item.author,
  created_at: item.created_at,
  text: item.text,
  closable: item.closable
})

export function createInboxActions(deps: InboxActionDeps): {
  run(callerId: string, tile: string, authority: CallerAuthority, request: InboxActionRequest): Promise<InboxActionOutcome>
} {
  async function run(
    callerId: string,
    tile: string,
    authority: CallerAuthority,
    request: InboxActionRequest
  ): Promise<InboxActionOutcome> {
    const entryLabel = request.op === 'close' ? ` ${request.entryId}` : ''
    const record = (outcome: InboxActionOutcome, error?: unknown): InboxActionOutcome => {
      const line = `${callerId} (${authority}) ${request.op}${entryLabel}: ${outcome.outcome}`
      if (outcome.outcome === 'unavailable') reportError('inbox', `${line} (${outcome.cause})`, error)
      else logInfo('inbox', line)
      return outcome
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), BROKER_TIMEOUT_MS)
    try {
      const mandate = await deps.mandate(callerId, tile, controller.signal)
      if (!mandate) return record({ outcome: 'unavailable', cause: 'mandate not ready' })
      const body: Record<string, unknown> =
        request.op === 'close'
          ? {
              inbox_operation: 'close',
              entry_id: request.author.payload.entry_id,
              reason: request.author.payload.reason,
              author: request.author
            }
          : {
              inbox_operation: 'list',
              ...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
              author: request.author
            }
      const auth = buildInboxProof(
        mandate.privateKey,
        body,
        request.op === 'close' ? INBOX_GATES.mandateClose : INBOX_GATES.mandateList,
        { kind: 'session', operator_id: mandate.deps.identity.operatorId, token_id: mandate.tokenId }
      )
      const endpoint = mandate.deps.endpoint
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (endpoint.token) headers['Authorization'] = `Bearer ${endpoint.token}`
      let res: Response
      try {
        res = await (deps.fetchFn ?? fetch)(`${endpoint.url}/inbox/${request.op}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...body, auth }),
          signal: controller.signal
        })
      } catch (e) {
        return record({ outcome: 'unavailable', cause: 'broker unreachable' }, e)
      }
      let parsed: unknown = null
      try {
        parsed = await res.json()
      } catch (e) {
        reportError('inbox', `${callerId} ${request.op}: the broker answered ${res.status} without JSON`, e)
      }
      const answer = isPlainObject(parsed) ? parsed : {}
      switch (res.status) {
        case 200:
          if (request.op === 'close') return record({ outcome: 'closed', id: request.entryId })
          return record(listed(answer))
        case 400:
          return record({ outcome: 'invalid', message: typeof answer.error === 'string' ? answer.error : 'refused by the broker' })
        case 403:
          return record({ outcome: 'forbidden' })
        case 404:
          return record({ outcome: 'unknown' })
        case 409:
          return record({ outcome: 'settled', state: typeof answer.state === 'string' ? answer.state : 'settled' })
        case 422:
          return record({ outcome: 'not-closable' })
        default:
          return record({ outcome: 'unavailable', cause: `broker status ${res.status}` })
      }
    } finally {
      clearTimeout(timer)
    }
  }

  function listed(answer: Record<string, unknown>): InboxActionOutcome {
    const page = answer as Partial<InboxListResponse>
    if (!Array.isArray(page.entries)) return { outcome: 'unavailable', cause: 'malformed list answer' }
    const local = deps.localCourrier()
    return {
      outcome: 'listed',
      entries: page.entries.filter((item) => keptByCourrier(item, local)).map(toAgentItem),
      next_cursor: typeof page.next_cursor === 'string' ? page.next_cursor : null
    }
  }

  return { run }
}
