// The Deck is the only holder of the operator credential and the only
// participant that can settle an approval: it mints restricted per-session
// credentials for spawned agents, raises approvals for sessions no hook covers,
// and applies settled verdicts by typing into the tile.
// Applying a verdict is remote input reaching a terminal: it is sanitised
// broker-side on claim and again here, and the submitting Enter is added by
// this code, never by the received text.

import { buildAuthProof, sanitizeAnswerForPty, type Approval } from './approval-auth'
import type { OperatorIdentity } from './operator-identity'
import type { BrokerEndpoint } from './broker-client'

export interface ApprovalDeps {
  endpoint: BrokerEndpoint
  identity: OperatorIdentity
  /**
   * The WINDOW's project key (card 4df14b5b). Required, not optional: the
   * broker's /approval/list now refuses a request that omits it (or sends an
   * empty string), because operator_id alone does not distinguish two Deck
   * windows on two different repos -- an absent field here must fail at
   * COMPILE time, not surface as a silent cross-project leak or a runtime
   * 400 discovered by an operator instead of a typecheck.
   */
  projectKey: string
  fetchImpl?: typeof fetch
}

async function signedPost<T>(
  deps: ApprovalDeps,
  path: string,
  payload: Record<string, unknown>
): Promise<T> {
  const f = deps.fetchImpl ?? fetch
  const body = { ...payload, public_key: deps.identity.publicKey }
  const auth = buildAuthProof(deps.identity.privateKey, body, {
    kind: 'operator',
    operator_id: deps.identity.operatorId
  })
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (deps.endpoint.token) headers.authorization = `Bearer ${deps.endpoint.token}`
  const res = await f(`${deps.endpoint.url}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, auth })
  })
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`)
  return (await res.json()) as T
}

/** Register a session's public key so its agent may raise approvals. */
export async function mintSessionToken(
  deps: ApprovalDeps,
  args: { sessionPublicKey: string; sessionRef: string; ttlHours?: number }
): Promise<{ token_id: string; expires_at: string }> {
  return signedPost(deps, '/approval/token-mint', {
    session_public_key: args.sessionPublicKey,
    session_ref: args.sessionRef,
    // Card 1def56da: the window's project is PINNED into the credential here,
    // by the operator, so the agent that later holds the token cannot choose
    // the project its blocking questions are filed under. Same discipline as
    // session_ref, extended to the dimension that became a scope with card
    // 4df14b5b. The broker refuses a mint without it.
    project_key: deps.projectKey,
    ttl_hours: args.ttlHours ?? 24
  })
}

/** Revoke a session's credential — called when the tile closes. */
export async function revokeSessionToken(
  deps: ApprovalDeps,
  sessionRef: string
): Promise<{ revoked: number }> {
  return signedPost(deps, '/approval/token-revoke', { session_ref: sessionRef })
}

export async function addApproval(
  deps: ApprovalDeps,
  args: {
    kind: 'permission' | 'question' | 'plan'
    title: string
    question: string
    options?: string[]
    sessionRef: string
    tileRef?: string
    projectKey: string
    host: string
    fromPeer?: string
    /** Peer to hand the answer to. Set => 'channel' route (C-9). */
    replyPeerId?: string | null
    groupId?: string
  }
): Promise<Approval> {
  const res = await signedPost<{ approval: Approval }>(deps, '/approval/add', {
    kind: args.kind,
    title: args.title,
    question: args.question,
    options: args.options ?? [],
    // project_key is mandatory at the top level on every approval route, not
    // only inside `origin`: the broker filters on this field and does not read
    // origin.project_key.
    project_key: deps.projectKey,
    session_ref: args.sessionRef,
    tile_ref: args.tileRef ?? args.sessionRef,
    // A resolved peer means the broker can deliver the answer as a message and
    // nothing has to be typed. Without one (peer not resolved yet, or a CLI
    // with no push channel) the broker downgrades to 'pty' on its own.
    reply_route: args.replyPeerId ? 'channel' : 'pty',
    reply_peer_id: args.replyPeerId ?? undefined,
    origin: {
      host: args.host,
      os_user_hash: deps.identity.osUserHash,
      project_key: args.projectKey,
      from_peer: args.fromPeer ?? '',
      group_id: args.groupId ?? ''
    }
  })
  return res.approval
}

/**
 * Settle an approval as the operator. Used when the answer is given IN the
 * Deck — which is what invalidates the phone notification (the broker's
 * conditional update makes the two mutually exclusive).
 *
 * A 409 is an ordinary outcome, not a failure: it means the phone won the
 * race. Callers get `null` for it.
 */
export async function claimApproval(
  deps: ApprovalDeps,
  args: { id: string; answerKind: 'allow' | 'deny' | 'text'; answerText?: string }
): Promise<Approval | null> {
  try {
    const res = await signedPost<{ approval: Approval }>(deps, '/approval/claim', {
      id: args.id,
      // project_key is required here: without it the broker refuses the claim
      // and the Deck cannot settle any approval.
      project_key: deps.projectKey,
      via: 'deck',
      answer_kind: args.answerKind,
      answer_text: args.answerText
    })
    return res.approval
  } catch (e) {
    if (e instanceof Error && /: 409$/.test(e.message)) return null
    throw e
  }
}

export interface ChannelStatus {
  kind: 'telegram' | 'discord' | 'ntfy'
  configured: boolean
  connected: boolean
  bot_label: string
  token_hint: string
  paired: number
  paired_labels: string[]
}

/** Channels this operator has configured, with their live state. */
export async function listChannels(deps: ApprovalDeps): Promise<ChannelStatus[]> {
  const res = await signedPost<{ channels: ChannelStatus[] }>(deps, '/approval/channel-list', {})
  return res.channels ?? []
}

/**
 * Hand a channel's secret to the broker, which seals it and starts the gateway.
 *
 * The secret travels ONCE, over this operator-signed route, precisely so the
 * operator never needs shell access to the broker host — many of them do not
 * have any. It is never read back: only a hint ever returns.
 *
 * Telegram and Discord send a bot token. ntfy sends the relay address (and,
 * optionally, an access token): it has no bot, and the broker mints the two
 * topics itself (PLAN N5).
 */
export async function connectChannel(
  deps: ApprovalDeps,
  args: { kind: 'telegram' | 'discord' | 'ntfy'; token?: string; server?: string }
): Promise<{
  kind: string
  label: string
  hint: string
  pairing_code: string
  deep_link: string
  invite_url: string
  mobile_payload: string
}> {
  return signedPost(deps, '/approval/channel-connect', {
    kind: args.kind,
    token: args.token ?? '',
    server: args.server ?? ''
  })
}

export async function disconnectChannel(
  deps: ApprovalDeps,
  kind: 'telegram' | 'discord' | 'ntfy'
): Promise<{ removed: number }> {
  return signedPost(deps, '/approval/channel-disconnect', { kind })
}

/** Approvals answered elsewhere and not yet applied to their session. */
export async function fetchUndeliveredVerdicts(deps: ApprovalDeps): Promise<Approval[]> {
  const res = await signedPost<{ approvals: Approval[] }>(deps, '/approval/list', {
    project_key: deps.projectKey,
    undelivered_only: true
  })
  return res.approvals ?? []
}

/**
 * Approvals the Deck can still answer locally (card 469f3176: the local
 * Courrier). Non-destructive, like the graph-drafts poll -- nothing is
 * consumed by listing.
 *
 * 'pending' and 'expired_notif' are exactly the statuses settleApproval
 * accepts for `via: 'deck'` (an expired NOTIFICATION does not mean the
 * session stopped waiting, see broker.ts's settleApproval doc comment).
 * `/approval/list`'s `status` field takes a single value, so this issues two
 * requests rather than inventing a multi-status filter server-side for one
 * caller.
 */
export async function fetchPendingApprovals(deps: ApprovalDeps): Promise<Approval[]> {
  const [pending, expired] = await Promise.all([
    signedPost<{ approvals: Approval[] }>(deps, '/approval/list', {
      project_key: deps.projectKey,
      status: 'pending'
    }),
    signedPost<{ approvals: Approval[] }>(deps, '/approval/list', {
      project_key: deps.projectKey,
      status: 'expired_notif'
    })
  ])
  return [...(pending.approvals ?? []), ...(expired.approvals ?? [])].sort((a, b) =>
    b.created_at.localeCompare(a.created_at)
  )
}

export async function markVerdictsDelivered(deps: ApprovalDeps, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  // Card 1def56da, hyp_17ec1784. Third and last of the Deck calls that took a
  // 400: without it the verdicts stay marked undelivered forever and the Deck
  // re-offers answers it has already applied.
  const res = await signedPost<{ marked: number }>(deps, '/approval/delivered', {
    project_key: deps.projectKey,
    ids
  })
  return res.marked
}

/**
 * The single return path for every verdict not returned via ask_operator, so
 * this mapping is load-bearing: allow types a bare Enter (the attention
 * detector only fires on the highlighted first option), deny sends Escape
 * rather than a numbered choice (a wrong guess could select "don't ask again"),
 * text is sanitised then followed by exactly one Enter added here.
 * Returns null when nothing safe can be typed; the caller must leave the
 * session alone rather than improvise.
 */
export function buildKeystrokes(approval: Approval): string | null {
  switch (approval.answer_kind) {
    case 'allow':
      return '\r'
    case 'deny':
      return '\x1b'
    case 'text': {
      const clean = sanitizeAnswerForPty(approval.answer_text ?? '')
      if (!clean.ok) return null
      // The Enter is ours. The text can never carry its own (sanitizeAnswerForPty
      // collapses every CR/LF), so a remote answer cannot submit early nor run
      // a second command.
      return `${clean.value}\r`
    }
    default:
      return null
  }
}

/**
 * Measured from `answered_at`, not from when this Deck first observed the
 * verdict, so a Deck restart and two Decks polling the same approval reach the
 * same deadline.
 * 90s is roughly 9 poll ticks and stays inside one operator gesture: short
 * enough that a dismissed prompt still on screen gets retried, long enough not
 * to answer a since-changed question.
 */
export const VERDICT_DEFER_MS = 90_000

/**
 * What the poller must do with one settled verdict.
 *
 *  - `apply`   type it into the tile;
 *  - `settle`  nothing to type and nothing ever will: mark it delivered;
 *  - `defer`   the tile is alive but not asking right now: leave the verdict
 *              UNDELIVERED so it comes back at the next poll;
 *  - `abandon` deferred long enough: mark it delivered, but the caller must
 *              leave a trace -- the operator answered and nothing was typed.
 */
export type VerdictDisposition = 'apply' | 'settle' | 'defer' | 'abandon'

/**
 * The `waiting` guard is load-bearing: an answer that arrives after the
 * operator already dealt with the prompt locally must not be typed into
 * whatever is on screen now.
 * A live tile that is not currently flagged is deferred rather than settled, so
 * the verdict is applied the moment the session asks again, bounded by
 * VERDICT_DEFER_MS before it is abandoned with a trace.
 */
export function classifyVerdict(
  approval: Approval,
  session: { exists: boolean; waiting: boolean } | null,
  now: number = Date.now()
): VerdictDisposition {
  // The broker already handed a 'channel' answer to the peer as a message;
  // typing it in as well would deliver it twice.
  if (approval.reply_route === 'channel') return 'settle'
  // No tile to type into, and none will appear: this one is genuinely over.
  // Checked before the 'answered' check below on purpose: an unanswered
  // approval whose tile has vanished would otherwise fall through to
  // 'settle' too, but that path is unreachable in practice -- the broker
  // only lists an approval as undelivered once status='answered' and
  // answered_at is set (broker.ts undelivered_only filter, ~line 2697).
  if (!session?.exists) return 'settle'
  // Not settled at all (the undelivered list should never carry these). Hold
  // it: marking an unanswered approval delivered would destroy the operator's
  // only chance to answer it.
  if (approval.status !== 'answered' || approval.answer_kind === null) return 'defer'
  if (session.waiting) return 'apply'
  // Alive, answered, but its flag is down. NaN-safe on purpose: an absent or
  // malformed answered_at has no deadline to compare against, so it falls to
  // the traced outcome rather than deferring forever (every comparison against
  // NaN is false, which would otherwise read as "still inside the window").
  const answeredAt = Date.parse(approval.answered_at ?? '')
  if (!Number.isFinite(answeredAt)) return 'abandon'
  return now - answeredAt < VERDICT_DEFER_MS ? 'defer' : 'abandon'
}

/**
 * Whether a verdict may be typed into a session right now.
 *
 * One truth (derived from classifyVerdict, never duplicated): today
 * classifyVerdict is the only production consumer (index.ts, which needs the
 * full disposition, not just apply/no), and canApplyVerdict itself is
 * exercised by the test suite, which cross-checks it against classifyVerdict
 * for every session state.
 */
export function canApplyVerdict(
  approval: Approval,
  session: { exists: boolean; waiting: boolean } | null
): boolean {
  return classifyVerdict(approval, session) === 'apply'
}
