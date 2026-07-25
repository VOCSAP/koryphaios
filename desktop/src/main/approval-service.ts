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
//  3. collect settled approvals and APPLY them — which, for anything that did
//     not come through a hook, means typing into a PTY.
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
    projectKey: string
    host: string
    fromPeer?: string
  }
): Promise<Approval> {
  const res = await signedPost<{ approval: Approval }>(deps, '/approval/add', {
    kind: args.kind,
    title: args.title,
    question: args.question,
    options: args.options ?? [],
    session_ref: args.sessionRef,
    origin: {
      host: args.host,
      os_user_hash: deps.identity.osUserHash,
      project_key: args.projectKey,
      from_peer: args.fromPeer ?? '',
      group_id: ''
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

/** Approvals answered elsewhere and not yet applied to their session. */
export async function fetchUndeliveredVerdicts(deps: ApprovalDeps): Promise<Approval[]> {
  const res = await signedPost<{ approvals: Approval[] }>(deps, '/approval/list', {
    undelivered_only: true
  })
  return res.approvals ?? []
}

export async function markVerdictsDelivered(deps: ApprovalDeps, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  const res = await signedPost<{ marked: number }>(deps, '/approval/delivered', { ids })
  return res.marked
}

/**
 * Translate a settled approval into the exact bytes to type into a PTY.
 *
 * ONLY used for the fallback path (sessions whose answer cannot be returned
 * structurally: non-Claude CLIs, and open questions detected on screen). The
 * hook path never comes through here — it returns a verdict to Claude Code
 * directly, which is why it is the preferred producer.
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
 * Decide whether a verdict may still be applied to a session.
 *
 * Two guards, both necessary: the tile must still exist, and it must still be
 * waiting. An answer that arrives after the operator already dealt with the
 * prompt locally must be dropped, not typed into whatever is on screen now.
 */
export function canApplyVerdict(
  approval: Approval,
  session: { exists: boolean; waiting: boolean } | null
): boolean {
  if (!session?.exists || !session.waiting) return false
  return approval.status === 'answered' && approval.answer_kind !== null
}
