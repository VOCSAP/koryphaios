// Deck-side approval client (PLAN-notifications-mobiles N1/N2.c).
//
// The Deck is the only holder of the OPERATOR credential, so it is the only
// participant that can settle an approval. Its three jobs:
//
//  1. mint a RESTRICTED per-session credential for each spawned agent, so the
//     agent (hook + ask_operator) can raise approvals without ever being able
//     to answer one — including from inside a sandbox container (PLAN §6.8);
//  2. raise approvals itself for the sessions no hook covers (non-Claude CLIs,
//     via the attention detector);
//  3. collect settled approvals and APPLY them by typing into the tile. Since
//     the hooks do not block, this is the only way a verdict reaches a session
//     (bar ask_operator, whose return value IS the answer).
//
// Job 3 is where the danger is: the answer is remote input reaching a
// terminal. It is sanitised broker-side on claim AND again here, and the
// submitting Enter is added by this code — never by the received text.
//
// Node builtins + fetch only (no electron import) so it is unit-testable under
// bun, matching broker-client.ts.

import { buildAuthProof, sanitizeAnswerForPty, type Approval } from './approval-auth'
import type { OperatorIdentity } from './operator-identity'
import type { BrokerEndpoint } from './broker-client'

export interface ApprovalDeps {
  endpoint: BrokerEndpoint
  identity: OperatorIdentity
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
    signedPost<{ approvals: Approval[] }>(deps, '/approval/list', { status: 'pending' }),
    signedPost<{ approvals: Approval[] }>(deps, '/approval/list', { status: 'expired_notif' })
  ])
  return [...(pending.approvals ?? []), ...(expired.approvals ?? [])].sort((a, b) =>
    b.created_at.localeCompare(a.created_at)
  )
}

export async function markVerdictsDelivered(deps: ApprovalDeps, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  const res = await signedPost<{ marked: number }>(deps, '/approval/delivered', { ids })
  return res.marked
}

/**
 * Translate a settled approval into the exact bytes to type into a PTY.
 *
 * This is the SINGLE return path: the hooks detect but never answer (they do
 * not block, so Claude Code keeps its own dialog up), which means every verdict
 * that is not an ask_operator return value lands here. That makes the
 * conservatism below load-bearing rather than incidental.
 *
 * Conservative on purpose:
 *  - allow -> a bare Enter, accepting the highlighted first option (the
 *    attention detector only fires on `❯ 1.`, so option 1 IS the selection);
 *  - deny  -> Escape, which every Claude Code chooser treats as "cancel".
 *    Picking a numbered "no" would mean guessing an index that varies between
 *    prompts — and guessing wrong could select "yes, and don't ask again";
 *  - text  -> the sanitised answer, then exactly one Enter added HERE.
 *
 * Returns null when nothing safe can be typed, in which case the caller must
 * leave the session alone rather than improvise.
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
 * How long a verdict may wait for its tile to ask again (card 9c6de1e1).
 *
 * Measured from `answered_at`, not from when this Deck first saw the verdict:
 * the anchor then survives a Deck restart, and two Decks polling the same
 * approval reach the same conclusion instead of each starting their own clock.
 *
 * The value trades two opposite risks. Too short and the fix does nothing (the
 * dismissed prompt is still on screen, and a repaint that re-arms the flag
 * arrives seconds later). Too long and the session may have moved on to a
 * DIFFERENT question by the time it flags again, and would receive the old
 * answer -- exactly what the `waiting` guard exists to prevent. 90s is ~9 poll
 * ticks (INBOX_POLL_MS = 10s) and stays well inside one operator gesture.
 *
 * A BET, not a setting: it exists only because no signal distinguishes a
 * repaint of the same still-blocked prompt from a brand-new question -- both
 * reach the Deck as a fresh `waiting:true`. The bet is deliberately on the
 * recoverable side (a lost answer the operator can retype, never an answer
 * typed into the WRONG question). Should a prompt identity ever travel with an
 * approval, match on it and DELETE this constant rather than tune it.
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
 * Decide what happens to a verdict that was settled elsewhere (phone).
 *
 * The `waiting` guard is the load-bearing one: an answer that arrives after
 * the operator already dealt with the prompt locally must not be typed into
 * whatever is on screen now. What card 9c6de1e1 fixed is not that guard but
 * its OUTCOME -- the poller used to answer a single boolean and treat every
 * `false` as "settled, stop sending it", which silently BURNED the answer when
 * the operator had merely dismissed the attention badge (session-service's
 * `clearAttention` drops the tile from `waitingTiles` by design) while the
 * agent was still sitting at the very same prompt.
 *
 * So a live tile that is not currently flagged is deferred, not settled: the
 * broker keeps the verdict on its undelivered list, and it is applied the
 * moment the session asks again -- bounded by VERDICT_DEFER_MS, past which it
 * is abandoned WITH a trace rather than quietly dropped.
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
