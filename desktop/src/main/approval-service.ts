// The Deck is the only holder of the operator credential and the only
// participant that can settle an approval: it mints restricted per-session
// credentials for spawned agents, raises approvals for sessions no hook covers,
// and applies settled verdicts by typing into the tile.
// Applying a verdict is remote input reaching a terminal: it is sanitised
// broker-side on claim and again here, and the submitting Enter is added by
// this code, never by the received text.

import {
  APPROVAL_ANSWER_MAX,
  APPROVAL_OPTIONS_MAX,
  APPROVAL_QUESTION_MAX,
  APPROVAL_QUESTIONS_MAX,
  buildAuthProof,
  sanitizeAnswerForPty,
  type Approval,
  type ApprovalAddResponse
} from './approval-auth'
import type { OperatorIdentity } from './operator-identity'
import type { BrokerEndpoint } from './broker-client'
import { commandHash } from './launch-approval'
import { reportError } from './log'

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
  payload: Record<string, unknown>,
  signal?: AbortSignal
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
    body: JSON.stringify({ ...body, auth }),
    signal
  })
  if (!res.ok) {
    // The status stays last: callers match a lost race with /: 409$/.
    const raw = (await res.text()).trim()
    let detail = raw
    try {
      const parsed = JSON.parse(raw) as { error?: unknown }
      if (typeof parsed.error === 'string') detail = parsed.error
    } catch {
      // Not JSON: the raw body is the operator's only clue, kept as is.
    }
    throw new Error(detail ? `${path} failed: ${detail.slice(0, 300)}: ${res.status}` : `${path} failed: ${res.status}`)
  }
  return (await res.json()) as T
}

/** Register a session's public key so its agent may raise approvals. */
export async function mintSessionToken(
  deps: ApprovalDeps,
  args: { sessionPublicKey: string; sessionRef: string; ttlHours?: number }
): Promise<{ token_id: string; expires_at: string; capabilities?: { renew_only?: boolean } }> {
  return signedPost(deps, '/approval/token-mint', {
    session_public_key: args.sessionPublicKey,
    session_ref: args.sessionRef,
    project_key: deps.projectKey,
    ttl_hours: args.ttlHours ?? 24
  })
}

export async function renewSessionToken(
  deps: ApprovalDeps,
  args: { sessionPublicKey: string; sessionRef: string; signal?: AbortSignal }
): Promise<{ token_id: string; expires_at: string; capabilities?: { renew_only?: boolean } }> {
  return signedPost(deps, '/approval/token-mint', {
    session_public_key: args.sessionPublicKey,
    session_ref: args.sessionRef,
    project_key: deps.projectKey,
    ttl_hours: 24,
    renew_only: true
  }, args.signal)
}

export async function revokeSessionToken(
  deps: ApprovalDeps,
  tokenId: string
): Promise<{ revoked: number }> {
  return signedPost(deps, '/approval/token-revoke', { token_id: tokenId })
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
    /**
     * Required, not optional: every caller must state whether this row may
     * merge with another pending row on the same tile (chantier
     * 3189b002+874e9053), so an omission fails at compile time here rather
     * than defaulting silently.
     */
    merge: 'tile' | 'never'
  }
): Promise<ApprovalAddResponse['approval']> {
  const res = await signedPost<ApprovalAddResponse>(deps, '/approval/add', {
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
    merge: args.merge,
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
  args: { id: string } & (
    | { answerKind: 'allow' | 'deny' | 'text'; answerText?: string }
    | { answerKind: 'answers'; answers: Record<string, string[]> }
    | { handback: true }
  )
): Promise<Approval | null> {
  try {
    const res = await signedPost<{ approval: Approval }>(deps, '/approval/claim', {
      id: args.id,
      // project_key is required here: without it the broker refuses the claim
      // and the Deck cannot settle any approval.
      project_key: deps.projectKey,
      via: 'deck',
      // The broker refuses a handback carrying any answer field, so each
      // shape sends only its own members.
      ...('handback' in args
        ? { handback: true }
        : args.answerKind === 'answers'
          ? { answer_kind: 'answers', answers: args.answers }
          : { answer_kind: args.answerKind, answer_text: args.answerText })
    })
    return res.approval
  } catch (e) {
    if (e instanceof Error && /: 409$/.test(e.message)) return null
    throw e
  }
}

/**
 * Shape and size check of an `answers` verdict arriving over IPC, before it is
 * signed and sent. Whether each key is a real question and each value a real
 * option is the broker's call, against the row it holds. Null when malformed.
 */
export function parseApprovalAnswers(raw: unknown): Record<string, string[]> | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const proto = Object.getPrototypeOf(raw)
  if (proto !== Object.prototype && proto !== null) return null
  const keys = Object.keys(raw)
  if (keys.length === 0 || keys.length > APPROVAL_QUESTIONS_MAX) return null
  const codePoints = (s: string): number => Array.from(s).length
  // Keys are question texts an agent chose: "__proto__" must stay an own key.
  const out = Object.create(null) as Record<string, string[]>
  for (const key of keys) {
    if (codePoints(key) > APPROVAL_QUESTION_MAX) return null
    const values = (raw as Record<string, unknown>)[key]
    if (!Array.isArray(values) || values.length === 0 || values.length > APPROVAL_OPTIONS_MAX + 1) return null
    const strings: string[] = []
    for (let i = 0; i < values.length; i++) {
      const v: unknown = values[i]
      if (typeof v !== 'string' || codePoints(v) > APPROVAL_ANSWER_MAX) return null
      strings.push(v)
    }
    out[key] = strings
  }
  return out
}

/** The `approvals:answers` handler: `call` is reached only with a payload parseApprovalAnswers accepted. */
export function handleAnswersIpc(
  id: unknown,
  raw: unknown,
  call: (id: string, answers: Record<string, string[]>) => Promise<boolean>
): Promise<boolean> {
  const answers = parseApprovalAnswers(raw)
  if (!answers) {
    reportError('approvals', 'approvals:answers received a malformed answers payload')
    return Promise.reject(new Error('approvals:answers: malformed answers'))
  }
  return call(String(id ?? ''), answers)
}

/**
 * Settle as answered on the tile itself, verdict unknown: the broker relays
 * nothing to the agent and nothing is ever typed. Same 409 contract as
 * claimApproval.
 */
export async function settleAnsweredInTerminal(deps: ApprovalDeps, id: string): Promise<Approval | null> {
  try {
    const res = await signedPost<{ approval: Approval }>(deps, '/approval/claim', {
      id,
      project_key: deps.projectKey,
      via: 'deck',
      terminal: true
    })
    return res.approval
  } catch (e) {
    if (e instanceof Error && /: 409$/.test(e.message)) return null
    throw e
  }
}

/**
 * The tile stopped waiting because the operator answered it in its terminal:
 * close every tile notification still open for it (the Deck's question and the
 * hook's permission alike), and mark delivered any verdict answered elsewhere
 * that was still to be typed, so it can never land in the tile's NEXT dialog.
 * Guarded requests (`mergeable` false) gate an action and are left alone.
 */
export async function settleTileAnsweredInTerminal(
  deps: ApprovalDeps,
  tile: string
): Promise<{ settled: string[]; lost: string[]; delivered: string[] }> {
  const onTile = (a: Approval): boolean => a.mergeable && (a.origin.tile_ref || a.origin.session_ref) === tile
  const settled: string[] = []
  const lost: string[] = []
  for (const approval of (await fetchPendingApprovals(deps)).filter(onTile)) {
    if (await settleAnsweredInTerminal(deps, approval.id)) settled.push(approval.id)
    else lost.push(approval.id)
  }
  const delivered = (await fetchUndeliveredVerdicts(deps)).filter(onTile).map((a) => a.id)
  await markVerdictsDelivered(deps, delivered)
  return { settled, lost, delivered }
}

/** Settle as acknowledged (read, no answer). Same 409 contract as claimApproval. */
export async function ackApproval(deps: ApprovalDeps, id: string): Promise<Approval | null> {
  try {
    const res = await signedPost<{ approval: Approval }>(deps, '/approval/claim', {
      id,
      project_key: deps.projectKey,
      via: 'deck',
      acknowledge: true
    })
    return res.approval
  } catch (e) {
    if (e instanceof Error && /: 409$/.test(e.message)) return null
    throw e
  }
}

/**
 * Long-poll a raised approval for its verdict (card 02e1c07c). The broker
 * bounds the wait itself and answers `pending: true` on timeout rather than
 * blocking the HTTP call indefinitely -- this wrapper never invents its own
 * timeout on top.
 */
export async function waitApproval(
  deps: ApprovalDeps,
  args: { id: string; timeoutSec?: number }
): Promise<{ pending: true } | { pending: false; approval: Approval }> {
  const res = await signedPost<{ approval?: Approval; pending?: boolean }>(deps, '/approval/wait', {
    id: args.id,
    timeout_sec: args.timeoutSec
  })
  if (res.pending) return { pending: true }
  if (!res.approval) throw new Error('/approval/wait returned neither an approval nor pending')
  return { pending: false, approval: res.approval }
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
  // The broker already handed a 'channel' answer to the peer as a message, and
  // a 'hook' answer is returned to Claude Code by the module waiting on it;
  // typing either in as well would deliver it twice.
  if (approval.reply_route === 'channel' || approval.reply_route === 'hook') return 'settle'
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
  // Alive, answered, but its flag is down.
  return withinDeferWindow(approval, now) ? 'defer' : 'abandon'
}

/**
 * Whether an answered verdict may still wait for its dialog. NaN-safe on
 * purpose: an absent or malformed answered_at has no deadline to compare
 * against, so it falls to the traced outcome rather than waiting forever
 * (every comparison against NaN is false).
 */
export function withinDeferWindow(approval: Pick<Approval, 'answered_at'>, now: number = Date.now()): boolean {
  const answeredAt = Date.parse(approval.answered_at ?? '')
  return Number.isFinite(answeredAt) && now - answeredAt < VERDICT_DEFER_MS
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

/**
 * Deterministic identity for a resolved plan (card 02e1c07c): the same mode
 * and the same RESOLVED plan, in the same order, hash to the same key, so a
 * retry re-attaches to the same in-flight or already-settled approval
 * instead of raising a second one for an identical request.
 */
export function spawnPlanFootprint(mode: string, plan: unknown): string {
  return commandHash(JSON.stringify({ mode, plan }))
}

/**
 * Whether a settled approval authorises a grant right now (card 02e1c07c).
 * Refuses on anything but a fresh 'allow' -- a denial, a still-pending row,
 * an unparseable timestamp, an answered_at in the FUTURE (clock skew between
 * broker and Deck, or a Deck clock rollback -- a negative age is not
 * "younger than maxAgeMs", it is untrustworthy), or one answered longer ago
 * than `maxAgeMs` -- checked at every OBSERVATION, not only once at grant
 * time: a grant lost across a Deck restart (its in-memory cache gone) has
 * nothing left to trust but a re-read of this same broker row, and this
 * function is what makes that re-read degrade to 'refuse' rather than a
 * silently reused stale (or bogusly future-dated) authorisation.
 */
export function decideSpawnGrant(approval: Approval, now: number, maxAgeMs: number): 'grant' | 'refuse' {
  if (approval.status !== 'answered' || approval.answer_kind !== 'allow') return 'refuse'
  const answeredAt = Date.parse(approval.answered_at ?? '')
  if (!Number.isFinite(answeredAt)) return 'refuse'
  const age = now - answeredAt
  if (age < 0 || age > maxAgeMs) return 'refuse'
  return 'grant'
}

/** Dependency-injected I/O for arbitrateSpawnGrant -- no electron/dialog reference. */
export interface SpawnGrantIO {
  raise: () => Promise<{ id: string }>
  wait: (id: string) => Promise<{ pending: true } | { pending: false; approval: Approval }>
  now: () => number
  onEvent?: (verdict: 'granted' | 'refused') => void
}

/**
 * One in-flight or settled grant. `approval` is the raw observed row, not a
 * pre-digested verdict (review fix round 3, card 02e1c07c): a coarse
 * 'grant'/'refuse' cached string threw away `answered_at`, so a cache-hit had
 * no way to re-check freshness and returned a 9-hour-stale grant as if it
 * had just been observed. Caching the row itself and running decideSpawnGrant
 * on EVERY read -- fresh or cached -- means there is exactly one place that
 * decides freshness, and it never gets bypassed by a second code path.
 */
export type SpawnGrantEntry = { approvalId: string; approval?: Approval }
export type SpawnGrantStore = Map<string, SpawnGrantEntry>

/**
 * The async arbiter behind card 02e1c07c: raises (or re-attaches to) one
 * guarded approval and returns its disposition, without ever opening a
 * synchronous dialog -- this module has no import of `electron` at all, so a
 * caller cannot reach a blocking message box through this path even by
 * accident.
 * NEVER deletes `store` on its own (review fix, card 02e1c07c): the observed
 * row is WRITTEN into the cache the moment it settles, and a later call for
 * the SAME key re-evaluates decideSpawnGrant against that SAME row with the
 * CURRENT clock, zero network round trip -- consumption (forgetting the key
 * so a future request re-asks the operator) is the CALLER's job, done
 * exactly once via consumeSpawnGrant below, once the whole composite request
 * this key belongs to has settled. Without this split, a batch of N>=1
 * sibling grants would lose an already-decided sibling's verdict the moment
 * any OTHER sibling is still pending, and a retry would re-raise a duplicate
 * approval for it.
 */
export async function arbitrateSpawnGrant(
  key: string,
  store: SpawnGrantStore,
  io: SpawnGrantIO,
  maxAgeMs: number
): Promise<{ pending: true } | { pending: false; granted: boolean }> {
  const cached = store.get(key)
  if (cached?.approval) {
    return { pending: false, granted: decideSpawnGrant(cached.approval, io.now(), maxAgeMs) === 'grant' }
  }
  let approvalId = cached?.approvalId
  // Tracks whether THIS call is the one that minted approvalId: only then is
  // it safe to roll the store entry back on a wait() failure. A wait()
  // failure against an approvalId that already existed (a retry re-attaching
  // to an approval already raised at the broker) must NOT delete the entry
  // -- the next retry would otherwise raise a brand new, duplicate approval
  // for a request the broker already has pending, which is worse than the
  // cap staying occupied.
  const justRaised = !approvalId
  if (!approvalId) {
    const raised = await io.raise()
    approvalId = raised.id
    store.set(key, { approvalId })
  }
  let waited: Awaited<ReturnType<SpawnGrantIO['wait']>>
  try {
    waited = await io.wait(approvalId)
  } catch (e) {
    if (justRaised) store.delete(key)
    throw e
  }
  if (waited.pending) return { pending: true }
  store.set(key, { approvalId, approval: waited.approval })
  const verdict = decideSpawnGrant(waited.approval, io.now(), maxAgeMs)
  io.onEvent?.(verdict === 'grant' ? 'granted' : 'refused')
  return { pending: false, granted: verdict === 'grant' }
}

/** Forget a settled grant (review fix, card 02e1c07c): the ONLY place a key is ever deleted. */
export function consumeSpawnGrant(key: string, store: SpawnGrantStore): void {
  store.delete(key)
}

/**
 * In-flight grants (raised, not yet observed as settled) under one callerId
 * (review fix round 3, card 02e1c07c): every raised approval is merge:'never'
 * and therefore durable and never coalesced, so nothing else bounds how many
 * DISTINCT plans one caller can have outstanding against the operator's
 * shared approval-credential quota. Keys are namespaced `${callerId}::...`
 * by the caller of arbitrateSpawnGrant, which is what lets this scan by
 * prefix rather than needing its own index.
 */
export function countInFlightSpawnGrants(store: SpawnGrantStore, callerId: string): number {
  const prefix = `${callerId}::`
  let n = 0
  for (const [key, entry] of store) {
    if (key.startsWith(prefix) && !entry.approval) n++
  }
  return n
}

/** What arbitrateSpawnApproval asks for and settles one plan (a whole batch, or a single entry) through. */
export interface SpawnGrantRequester<Plan> {
  request: (plan: Plan) => Promise<{ pending: true } | { pending: false; granted: boolean }>
  consume: (plan: Plan) => void
}

/**
 * PURE composition (review fix, card 02e1c07c): for a given mode and a
 * resolved list of entries, decides how many grants to request and how to
 * aggregate them into decisions -- injected `requester`, no network, no
 * store, no electron, so "team-review authorises without going through
 * requester.request" is a directly assertable, red-able mutation rather
 * than a source-scan of dead code.
 * team-review: ONE request for the whole batch, every decision mirrors that
 * single verdict. full-control: one request PER ENTRY, run concurrently;
 * `consume` is called for every entry, but ONLY once none of them is still
 * pending -- an already-decided sibling is never re-requested while another
 * one is still waiting, and is forgotten (so a later, genuinely NEW
 * submission of the same plan re-asks) only once the whole batch lands.
 */
export async function arbitrateSpawnApproval<Entry>(
  mode: 'team-review' | 'full-control',
  entries: Entry[],
  requester: SpawnGrantRequester<Entry[]>
): Promise<{ pending: true } | { pending: false; decisions: boolean[] }> {
  if (entries.length === 0) return { pending: false, decisions: [] }
  if (mode === 'team-review') {
    const result = await requester.request(entries)
    if (result.pending) return { pending: true }
    requester.consume(entries)
    return { pending: false, decisions: entries.map(() => result.granted) }
  }
  const plans = entries.map((e) => [e])
  const results = await Promise.all(plans.map((plan) => requester.request(plan)))
  if (results.some((r) => r.pending)) return { pending: true }
  for (const plan of plans) requester.consume(plan)
  return {
    pending: false,
    decisions: results.map((r) => !r.pending && r.granted)
  }
}
