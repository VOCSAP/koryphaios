// Minimal outbound broker client for the Deck (v0.3.4). The Deck is a one-way
// participant: it POSTs /announce to broadcast operator messages to a group's
// peers, and never reads inbound traffic. It is NOT a registered peer.
//
// This module deliberately avoids electron/node-pty imports (node builtins +
// fetch only) so it can be unit-tested under `bun test`, and avoids the @shared
// alias (bun cannot resolve it in the repo-root test harness).
//
// The broker URL/token are read from the SAME claude-peers config the spawned
// sessions use (env > %APPDATA%/XDG config.json > loopback default), mirroring
// shared/config.ts -- but with Node fs, since shared/config.ts uses Bun.file
// which is unavailable in the Electron main process.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
// Dispatch-request shapes come from the REPO-ROOT shared/types.ts, the broker's
// own file -- not from a Deck-side mirror. Type-only and relative (never the
// @shared alias, which resolves to desktop/src/shared), so it is erased at
// transpile and the repo-root bun harness never has to resolve it. The ENVELOPE
// types travel with them: they are what makes each POST body below a checked
// shape instead of an object literal nobody validates.
import type {
  DispatchRequest,
  DispatchRequestListRequest,
  DispatchRequestListResponse,
  DispatchRequestOutcome,
  DispatchRequestResolveRequest
} from '../../../shared/types'

export interface BrokerEndpoint {
  url: string
  token: string | null
}

interface PeersFileConfig {
  port?: number
  broker_url?: string
  broker_token?: string
}

/** Path of the claude-peers core config.json, matching shared/config.ts. */
export function peersConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') {
    const appdata = env.APPDATA
    return appdata
      ? join(appdata, 'claude-peers', 'config.json')
      : join(homedir(), 'AppData', 'Roaming', 'claude-peers', 'config.json')
  }
  const xdg = env.XDG_CONFIG_HOME
  return xdg
    ? join(xdg, 'claude-peers', 'config.json')
    : join(homedir(), '.config', 'claude-peers', 'config.json')
}

function readPeersConfig(path: string): PeersFileConfig {
  try {
    if (!existsSync(path)) return {}
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as PeersFileConfig) : {}
  } catch {
    return {}
  }
}

/**
 * Resolve the broker endpoint (url + optional bearer token) the Deck should POST
 * /announce to. Precedence mirrors shared/config.ts: env > config file > default.
 */
export function resolveBrokerEndpoint(
  env: NodeJS.ProcessEnv = process.env,
  configPath: string = peersConfigPath(env)
): BrokerEndpoint {
  const file = readPeersConfig(configPath)
  const port = parseInt(env.CLAUDE_PEERS_PORT ?? String(file.port ?? 7899), 10)
  const url = env.CLAUDE_PEERS_BROKER_URL ?? file.broker_url ?? `http://127.0.0.1:${port}`
  const token = env.CLAUDE_PEERS_BROKER_TOKEN ?? file.broker_token ?? null
  return { url, token }
}

/** Full sha256 hex of a group secret (== shared/config.ts computeGroupSecretHash). */
export function computeGroupSecretHash(secret: string): string {
  return createHash('sha256').update(secret, 'utf-8').digest('hex')
}

// ----- Broker reachability (PLAN O5) -----

export interface BrokerStatusEvent {
  up: boolean
  /** Epoch ms of the last up/down transition. */
  since: number
  /** Message of the failure that opened the outage (null while up). */
  lastError: string | null
}

/**
 * Consecutive-failure health tracker fed by the Deck's existing broker polls.
 * Hysteresis keeps the banner stable: `failureThreshold` consecutive failures
 * flip to down (one flaky poll is not an outage), a single success flips back
 * up. onChange fires only on transitions.
 */
export class BrokerHealthTracker {
  private failures = 0
  private up = true
  private since: number
  private lastError: string | null = null

  constructor(
    private onChange: (status: BrokerStatusEvent) => void,
    private failureThreshold = 2,
    private now: () => number = Date.now
  ) {
    this.since = this.now()
  }

  get status(): BrokerStatusEvent {
    return { up: this.up, since: this.since, lastError: this.lastError }
  }

  recordSuccess(): void {
    this.failures = 0
    if (!this.up) {
      this.up = true
      this.since = this.now()
      this.lastError = null
      this.onChange(this.status)
    }
  }

  recordFailure(error: unknown): void {
    this.failures++
    if (this.up && this.failures >= this.failureThreshold) {
      this.up = false
      this.since = this.now()
      this.lastError = error instanceof Error ? error.message : String(error)
      this.onChange(this.status)
    }
  }
}

export interface SendAnnounceParams {
  /** sha256(secret).slice(0,32) -- the broker group_id (== Scope.groupId). */
  groupId: string
  /** The forced-group secret (never the hash); hashed here for the payload. */
  secret: string
  text: string
  /** peer_id to exclude (e.g. the just-joined peer, so it skips its own join). */
  excludePeerId?: string | null
  /** Targeted announce (PLAN C10): deliver to this ONE active peer only. */
  toPeerId?: string | null
}

export interface AnnounceDeps {
  endpoint: BrokerEndpoint
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch
}

/**
 * Build the /announce request payload from a scope + text. Exposed for tests so
 * the wiring (hash, exclude) can be asserted without a live broker.
 */
export function buildAnnouncePayload(params: SendAnnounceParams): {
  group_id: string
  group_secret_hash: string
  text: string
  exclude_peer_id: string | null
  to_peer_id: string | null
} {
  return {
    group_id: params.groupId,
    group_secret_hash: computeGroupSecretHash(params.secret),
    text: params.text,
    exclude_peer_id: params.excludePeerId ?? null,
    // Targeted announce (PLAN C10): one active peer instead of the broadcast.
    to_peer_id: params.toPeerId ?? null
  }
}

/** One drained operator-inbox message (PLAN C12). */
export interface OperatorInboxMessage {
  id: number
  from_peer_id: string
  text: string
  sent_at: string
}

/**
 * POST /operator-inbox (PLAN C12): drain the messages agents sent to the
 * reserved 'operator' peer of this window's group. Throws on failure so the
 * polling caller can swallow it.
 *
 * Courrier lot 1B (card 54b1c71a, design doc section 6.2): `params.sessionId`
 * is OPTIONAL here only so this function's own unit tests stay simple without
 * one -- the real caller (index.ts's pollOperatorInbox) always supplies it.
 * Present -> the broker's NON-DESTRUCTIVE cursor read (this window's own
 * in-memory session_id gates what IT has already seen); absent -> the
 * broker's legacy delivered=0 drain.
 */
export async function fetchOperatorInbox(
  params: { groupId: string; secret: string; sessionId?: string },
  deps: AnnounceDeps
): Promise<OperatorInboxMessage[]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (deps.endpoint.token) headers['Authorization'] = `Bearer ${deps.endpoint.token}`
  const f = deps.fetchFn ?? fetch
  const res = await f(`${deps.endpoint.url}/operator-inbox`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      group_id: params.groupId,
      group_secret_hash: computeGroupSecretHash(params.secret),
      ...(params.sessionId ? { session_id: params.sessionId } : {})
    })
  })
  if (!res.ok) throw new Error(`operator-inbox failed: ${res.status}`)
  return ((await res.json()) as { messages: OperatorInboxMessage[] }).messages
}

/**
 * POST /operator-inbox/purge (Courrier lot 1C/1D/1E, card 1e81ee7b). Same
 * guard order broker-side as the drain -- see broker.ts's
 * handleOperatorInboxPurge. Throws on failure so callers decide their own
 * best-effort policy (index.ts wraps both call sites with reportError).
 */
export async function purgeOperatorInbox(
  params: { groupId: string; secret: string; sessionId: string } & (
    | { scope: 'session' }
    | { scope: 'ids'; ids: number[] }
  ),
  deps: AnnounceDeps
): Promise<number> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (deps.endpoint.token) headers['Authorization'] = `Bearer ${deps.endpoint.token}`
  const f = deps.fetchFn ?? fetch
  const res = await f(`${deps.endpoint.url}/operator-inbox/purge`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      group_id: params.groupId,
      group_secret_hash: computeGroupSecretHash(params.secret),
      session_id: params.sessionId,
      scope: params.scope,
      ...(params.scope === 'ids' ? { ids: params.ids } : {})
    })
  })
  if (!res.ok) throw new Error(`operator-inbox/purge failed: ${res.status}`)
  return ((await res.json()) as { deleted: number }).deleted
}

/** One pending graph draft parked on the broker (agent-escalated question). */
export interface BrokerGraphDraft {
  id: string
  project_key: string
  from_peer: string
  title: string
  prompt: string
  status: 'pending' | 'opened'
  created_at: string
  opened_at: string | null
}

/**
 * POST /graph-draft/list: the PENDING drafts of this project. Non-destructive
 * (unlike the inbox drain): polling never consumes anything — a draft only
 * leaves this list when markGraphDraftOpened is called on operator action.
 */
export async function fetchGraphDrafts(
  projectKey: string,
  deps: AnnounceDeps
): Promise<BrokerGraphDraft[]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (deps.endpoint.token) headers['Authorization'] = `Bearer ${deps.endpoint.token}`
  const f = deps.fetchFn ?? fetch
  const res = await f(`${deps.endpoint.url}/graph-draft/list`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ project_key: projectKey })
  })
  if (!res.ok) throw new Error(`graph-draft/list failed: ${res.status}`)
  return ((await res.json()) as { drafts: BrokerGraphDraft[] }).drafts
}

/** POST /graph-draft/open: flip a draft to opened (idempotent broker-side). */
export async function markGraphDraftOpened(
  id: string,
  deps: AnnounceDeps
): Promise<BrokerGraphDraft> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (deps.endpoint.token) headers['Authorization'] = `Bearer ${deps.endpoint.token}`
  const f = deps.fetchFn ?? fetch
  const res = await f(`${deps.endpoint.url}/graph-draft/open`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ id })
  })
  if (!res.ok) throw new Error(`graph-draft/open failed: ${res.status}`)
  return ((await res.json()) as { draft: BrokerGraphDraft }).draft
}

/**
 * POST /dispatch-request/list: the PENDING dispatch requests of this project
 * (card bf76d37f). Non-destructive, like /graph-draft/list: a request only
 * leaves the pending set when resolveDispatchRequest is called on it, which is
 * what makes the PARK semantics work -- a tick that cannot dispatch simply
 * returns, and the request is still there on the next one.
 *
 * `include_done` exists broker-side and is deliberately NOT sent: the Deck
 * only ever wants what it still has to serve.
 */
export async function fetchDispatchRequests(
  projectKey: string,
  deps: AnnounceDeps
): Promise<DispatchRequest[]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (deps.endpoint.token) headers['Authorization'] = `Bearer ${deps.endpoint.token}`
  const f = deps.fetchFn ?? fetch
  const body: DispatchRequestListRequest = { project_key: projectKey }
  const res = await f(`${deps.endpoint.url}/dispatch-request/list`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`dispatch-request/list failed: ${res.status}`)
  return ((await res.json()) as DispatchRequestListResponse).requests
}

/**
 * POST /dispatch-request/resolve: hand one request its outcome (card
 * bf76d37f). Throws on a non-2xx so the caller reports it instead of believing
 * the requester was answered.
 *
 * Returns void on purpose. The broker answers with a
 * `DispatchRequestResolveResponse` carrying the updated row, and the Deck has
 * no use for it -- it already holds the outcome it just sent. Importing that
 * response type only to parse and discard a body would be a dead import, so
 * the 2xx alone is the acknowledgement.
 */
export async function resolveDispatchRequest(
  id: string,
  outcome: DispatchRequestOutcome,
  deps: AnnounceDeps
): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (deps.endpoint.token) headers['Authorization'] = `Bearer ${deps.endpoint.token}`
  const f = deps.fetchFn ?? fetch
  const body: DispatchRequestResolveRequest = { id, outcome }
  const res = await f(`${deps.endpoint.url}/dispatch-request/resolve`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`dispatch-request/resolve failed: ${res.status}`)
}

/**
 * POST /announce. Best-effort: throws on a non-2xx or transport failure so the
 * caller can swallow it (an announce must never crash the Deck main process).
 */
export async function sendAnnounce(
  params: SendAnnounceParams,
  deps: AnnounceDeps
): Promise<{ sent: number }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (deps.endpoint.token) headers['Authorization'] = `Bearer ${deps.endpoint.token}`
  const f = deps.fetchFn ?? fetch
  const res = await f(`${deps.endpoint.url}/announce`, {
    method: 'POST',
    headers,
    body: JSON.stringify(buildAnnouncePayload(params))
  })
  if (!res.ok) throw new Error(`announce failed: ${res.status}`)
  return (await res.json()) as { sent: number }
}
