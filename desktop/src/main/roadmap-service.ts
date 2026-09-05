// The project key must match what server.ts computes for sessions spawned in
// the same directory, or the Deck and its agents see different roadmaps.
// Git shelling stays local to this file rather than importing
// shared/summarize.ts: that module references the Bun global, which desktop's
// node tsconfig (no bun-types) cannot resolve, breaking npm run typecheck.

import { execFileSync } from 'node:child_process'
import { reportError } from './log'
import { normalizeRemoteUrl, resolveProjectKey } from '../../../shared/project-key'
import type { BrokerEndpoint } from './broker-client'
import type {
  RoadmapArchiveResponse,
  RoadmapFacetBucket,
  RoadmapFacets,
  RoadmapItem,
  RoadmapListFilters,
  RoadmapListResponse,
  RoadmapLockScope,
  RoadmapQuery,
  RoadmapReorderResponse,
  RoadmapSearchResult,
  RoadmapSyncConflict,
  RoadmapSyncContent,
  RoadmapSyncResolution,
  RoadmapSyncRow,
  RoadmapSyncStatus,
  RoadmapUpsertFields,
  RoadmapUpsertResponse
} from '../shared/types'

export { normalizeRemoteUrl }

function gitOutput(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

/**
 * Shares resolveProjectKey with server.ts's roadmapProjectKey so the two can't
 * silently diverge on how a project key is derived.
 */
export function computeDeckProjectKey(projectDir: string): string {
  const remote = gitOutput(['remote', 'get-url', 'origin'], projectDir)
  const normalized = remote ? normalizeRemoteUrl(remote) : null
  const gitRoot = gitOutput(['rev-parse', '--show-toplevel'], projectDir)
  return resolveProjectKey(normalized, gitRoot, projectDir)
}

// Writes claiming by: 'deck' need an Ed25519 signature; index.ts injects the
// signer lazily since the identity loader is electron-side and this module
// stays loader-free.
// The signature must cover the payload together with the public key it adds,
// since operator_id is the key's digest — a broker meeting the operator for the
// first time can self-certify the binding instead of refusing an unknown id.
export type RoadmapAuthFields = Record<string, unknown>
export type RoadmapSigner = (payload: Record<string, unknown>) => RoadmapAuthFields | null

let signerLoader: (() => RoadmapSigner | null) | null = null
let cachedSigner: RoadmapSigner | null = null

/** Called once at app start with a loader; the loader itself runs on first use. */
export function configureRoadmapSigner(loader: () => RoadmapSigner | null): void {
  signerLoader = loader
  cachedSigner = null
}

/** Test seam: forget both the loader and what it returned. */
export function resetRoadmapSigner(): void {
  signerLoader = null
  cachedSigner = null
}

function operatorProof(payload: Record<string, unknown>): RoadmapAuthFields | null {
  if (!cachedSigner) {
    if (!signerLoader) {
      reportError(
        'roadmap',
        'no operator signer configured: writes attributed to the operator will be refused by the broker'
      )
      return null
    }
    cachedSigner = signerLoader()
    if (!cachedSigner) {
      reportError(
        'roadmap',
        'operator identity unavailable: this Deck cannot sign roadmap writes (re-enrol this machine)'
      )
      return null
    }
  }
  return cachedSigner(payload)
}

/**
 * Sign an operator-authored body. The proof covers the payload itself, so it
 * must be built from the FINAL body: adding a field afterwards would invalidate
 * the signature broker-side (verifyAuthProof hashes the whole payload).
 */
function signedAsOperator(body: Record<string, unknown>): Record<string, unknown> {
  const fields = operatorProof(body)
  return fields ? { ...body, ...fields } : body
}

/**
 * A roadmap route answered with a non-2xx. Carries the HTTP status because one
 * caller has to tell a MISSING ROUTE from a failing one: a broker too old to
 * serve /roadmap/sync/status answers 404 forever, and polling it every tick
 * until the process ends is the difference between an outage and a version
 * gap. A transport failure is not this error -- fetch rejects with its own,
 * which is exactly the distinction the caller needs.
 */
export class RoadmapRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string
  ) {
    super(message)
    this.name = 'RoadmapRequestError'
  }
}

async function roadmapPost<T>(endpoint: BrokerEndpoint, path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (endpoint.token) headers['Authorization'] = `Bearer ${endpoint.token}`
  const res = await fetch(`${endpoint.url}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    let detail = ''
    try {
      detail = ((await res.json()) as { error?: string }).error ?? ''
    } catch {
      /* non-json error body */
    }
    throw new RoadmapRequestError(detail || `roadmap request failed: ${res.status}`, res.status, path)
  }
  return (await res.json()) as T
}

/** Operator writes are attributed to the reserved 'deck' author. */
const DECK_AUTHOR = 'deck'

// Validates every broker response field at this module's single choke point,
// not per caller, since an unchecked target_peer_ids or depends_on string
// degrades silently into wrong substring matches or false empty results.
// Coerces rather than drops: an empty target_peer_ids still lands in the
// existing no-live-target branch, which already journals, instead of vanishing
// from the operator's board.

const KINDS = ['feature', 'bug', 'debt', 'idea', 'chore', 'directive'] as const
const PRIORITIES = ['must', 'should', 'could', 'wont'] as const
const LEVELS = ['low', 'medium', 'high'] as const
const STATUSES = ['idea', 'planned', 'in_progress', 'done', 'archived'] as const
const DIRECTIVES = ['clear', 'compact', 'magic_compact'] as const
const SYNC_STATES = ['clean', 'conflict'] as const
const LOCK_SCOPES = ['local', 'global', 'contested', 'remote', 'release_pending'] as const
const SYNC_MODES = ['local', 'upstream', 'replica'] as const

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function nullableStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

/** An array of strings, or [] -- wrong ELEMENTS are as dangerous as a wrong shape. */
function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.every((x) => typeof x === 'string') ? (v as string[]) : []
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

/**
 * A queue position, or null. Rejects NaN explicitly: every comparison against
 * NaN is false, so a range check would pass it straight through.
 *
 * Measured: a JSON body can never carry a bare NaN (`JSON.parse('{"q":NaN}')`
 * throws), so over the wire the reachable shapes are `"3"`, `"NaN"` and `null`.
 * The NaN branch guards the DIRECT-call path only -- this function is exported
 * and a future caller may build the object in code. Note also that coercing
 * through `Number()` would be wrong here: `Number(null)` is 0, which would turn
 * "not queued" into queue position 0.
 */
function queuePos(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null
}

/**
 * Pick-list, never a spread: every RoadmapItem field is named explicitly, so a
 * field added broker-side without being listed here does not travel through
 * unvalidated.
 * The compiler only catches a required field omitted here; an optional one left
 * out compiles clean with no error.
 * id and project_key are structural, not coercible — an item missing either
 * cannot be addressed or matched, so it is dropped and traced.
 */
export function sanitizeRoadmapItem(raw: unknown): RoadmapItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return null
  if (typeof r.project_key !== 'string' || !r.project_key) return null
  return {
    id: r.id,
    project_key: r.project_key,
    kind: oneOf(r.kind, KINDS, 'feature'),
    title: str(r.title),
    description: str(r.description),
    rationale: str(r.rationale),
    context: str(r.context),
    priority: oneOf(r.priority, PRIORITIES, 'could'),
    value: oneOf(r.value, LEVELS, 'medium'),
    effort: oneOf(r.effort, LEVELS, 'medium'),
    status: oneOf(r.status, STATUSES, 'idea'),
    tags: strList(r.tags),
    depends_on: strList(r.depends_on),
    created_by: str(r.created_by),
    updated_by: str(r.updated_by),
    created_at: str(r.created_at),
    updated_at: str(r.updated_at),
    deleted_at: nullableStr(r.deleted_at),
    queue: queuePos(r.queue),
    locked: r.locked === true,
    locked_by: nullableStr(r.locked_by),
    locked_at: nullableStr(r.locked_at),
    // The lock owner's group_id, so a lock ownership check can't match a
    // same-named peer_id from a different group.
    locked_group: nullableStr(r.locked_group),
    directive: typeof r.directive === 'string' ? oneOfOrNull(r.directive) : null,
    target_peer_ids: strList(r.target_peer_ids),
    // Card edefff05: optional (undefined, never null) -- unlike the
    // nullableStr fields above, the broker omits this key entirely rather
    // than sending null when no operator has ever signed a write.
    operator_id: typeof r.operator_id === 'string' ? r.operator_id : undefined,
    // Card c33a5968: NOT NULL DEFAULT 0 broker-side, so this is always a
    // boolean on the wire -- coerced defensively like `locked` above.
    inactive: r.inactive === true,
    // Replication fields. 'clean' and null are the states a NON-replica
    // broker reports, so an older broker that omits these keys entirely, and
    // a hostile one that sends garbage, both land on "nothing to arbitrate,
    // no remote lock" -- the board renders exactly as it did before.
    sync_state: oneOf(r.sync_state, SYNC_STATES, 'clean'),
    lock_scope: lockScopeOrNull(r.lock_scope),
    lock_contested_by: strList(r.lock_contested_by)
  }
}

function lockScopeOrNull(v: unknown): RoadmapLockScope | null {
  return typeof v === 'string' && (LOCK_SCOPES as readonly string[]).includes(v)
    ? (v as RoadmapLockScope)
    : null
}

function oneOfOrNull(v: string): RoadmapItem['directive'] {
  return (DIRECTIVES as readonly string[]).includes(v) ? (v as RoadmapItem['directive']) : null
}

/** Sanitize a list response, tracing HOW MANY items were unusable and dropped. */
function sanitizeList(raw: unknown, route: string): RoadmapItem[] {
  const items = Array.isArray(raw) ? raw : []
  if (!Array.isArray(raw)) {
    reportError('roadmap', `${route}: response items was not an array; treated as empty`)
  }
  const out: RoadmapItem[] = []
  let dropped = 0
  for (const it of items) {
    const clean = sanitizeRoadmapItem(it)
    if (clean) out.push(clean)
    else dropped++
  }
  if (dropped > 0) {
    reportError('roadmap', `${route}: dropped ${dropped} item(s) with no usable id/project_key`)
  }
  return out
}

/**
 * Sanitize a SINGLE-item response. Unlike a list, there is no meaningful
 * degraded result here: the caller asked about one card and would otherwise get
 * a fabricated one, so an unusable item is an error of that call.
 */
function sanitizeOne(raw: unknown, route: string): RoadmapItem {
  const clean = sanitizeRoadmapItem(raw)
  if (!clean) {
    reportError('roadmap', `${route}: response item has no usable id/project_key`)
    throw new Error(`${route}: malformed roadmap item in response`)
  }
  return clean
}

export async function listRoadmap(
  endpoint: BrokerEndpoint,
  projectKey: string,
  filters: RoadmapListFilters = {}
): Promise<RoadmapItem[]> {
  const res = await roadmapPost<RoadmapListResponse>(endpoint, '/roadmap/list', {
    project_key: projectKey,
    ...filters
  })
  return sanitizeList(res?.items, '/roadmap/list')
}

const FACET_DIMENSIONS = ['kind', 'priority', 'effort', 'value', 'status', 'tags'] as const

/**
 * A malformed individual bucket is dropped and traced, but a dimension that
 * isn't an array at all rejects the whole payload instead of silently producing
 * an empty bucket list.
 */
function sanitizeFacetBucketList(raw: unknown[], dim: string, route: string): RoadmapFacetBucket[] {
  const out: RoadmapFacetBucket[] = []
  let dropped = 0
  for (const b of raw) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) {
      dropped++
      continue
    }
    const r = b as Record<string, unknown>
    if (typeof r.value !== 'string') {
      dropped++
      continue
    }
    if (typeof r.count !== 'number' || !Number.isFinite(r.count)) {
      dropped++
      continue
    }
    out.push({ value: r.value, count: r.count })
  }
  if (dropped > 0) {
    reportError('roadmap', `${route}: facets.${dim} dropped ${dropped} malformed bucket(s)`)
  }
  return out
}

/**
 * Returns null rather than a partially-filled object: RoadmapFacets is nullable
 * exactly to distinguish an older broker that omits counters from a real
 * zero-count bucket.
 * Every one of the six dimensions must be a real array or the whole payload is
 * rejected and traced — a single broken dimension must not report a false
 * all-zero facet set.
 */
export function sanitizeFacets(raw: unknown, route = '/roadmap/list (search)'): RoadmapFacets | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.reference_total !== 'number' || !Number.isFinite(r.reference_total)) return null
  for (const dim of FACET_DIMENSIONS) {
    if (!Array.isArray(r[dim])) {
      reportError('roadmap', `${route}: facets.${dim} was not an array; rejecting whole facets payload`)
      return null
    }
  }
  return {
    kind: sanitizeFacetBucketList(r.kind as unknown[], 'kind', route),
    priority: sanitizeFacetBucketList(r.priority as unknown[], 'priority', route),
    effort: sanitizeFacetBucketList(r.effort as unknown[], 'effort', route),
    value: sanitizeFacetBucketList(r.value as unknown[], 'value', route),
    status: sanitizeFacetBucketList(r.status as unknown[], 'status', route),
    tags: sanitizeFacetBucketList(r.tags as unknown[], 'tags', route),
    reference_total: r.reference_total
  }
}

/**
 * Card 3b0fda5f. Same broker endpoint as listRoadmap (`/roadmap/list`,
 * extended in place by card 15952e09) but with the fuller RoadmapQuery shape
 * (plural dimensions, `q`/`q_deep`, `with_facets`) and a facets-aware
 * response. listRoadmap/its `/roadmap:list` IPC channel are untouched --
 * this is a new, separate call, not a replacement.
 */
export async function searchRoadmap(
  endpoint: BrokerEndpoint,
  projectKey: string,
  query: RoadmapQuery = {}
): Promise<RoadmapSearchResult> {
  const res = await roadmapPost<RoadmapListResponse>(endpoint, '/roadmap/list', {
    project_key: projectKey,
    ...query
  })
  return {
    items: sanitizeList(res?.items, '/roadmap/list (search)'),
    facets: query.with_facets ? sanitizeFacets(res?.facets) : null
  }
}

export async function upsertRoadmap(
  endpoint: BrokerEndpoint,
  projectKey: string,
  fields: RoadmapUpsertFields
): Promise<RoadmapItem> {
  const res = await roadmapPost<RoadmapUpsertResponse>(
    endpoint,
    '/roadmap/upsert',
    signedAsOperator({
      // project_key is ignored by the broker on patch (id set) and required on create.
      project_key: projectKey,
      by: DECK_AUTHOR,
      ...fields
    })
  )
  return sanitizeOne(res?.item, '/roadmap/upsert')
}

/**
 * Atomic queue rewrite (Workflow lane): `ids` becomes the whole dispatch
 * queue in order; every other queued item of the project is unqueued.
 */
export async function reorderRoadmap(
  endpoint: BrokerEndpoint,
  projectKey: string,
  ids: string[],
  waves?: string[][]
): Promise<RoadmapItem[]> {
  const res = await roadmapPost<RoadmapReorderResponse>(
    endpoint,
    '/roadmap/reorder',
    signedAsOperator({
      project_key: projectKey,
      by: DECK_AUTHOR,
      ids,
      // Additive over the wire too (roadmap card 42edc88b phase 1): omit the
      // field entirely when unset rather than sending `waves: undefined`, so
      // an older broker sees exactly the request shape it already understands.
      ...(waves !== undefined ? { waves } : {})
    })
  )
  return sanitizeList(res?.items, '/roadmap/reorder')
}

export async function archiveRoadmap(endpoint: BrokerEndpoint, id: string): Promise<RoadmapItem> {
  const res = await roadmapPost<RoadmapArchiveResponse>(
    endpoint,
    '/roadmap/archive',
    signedAsOperator({
      id,
      by: DECK_AUTHOR
    })
  )
  return sanitizeOne(res?.item, '/roadmap/archive')
}

export interface RoadmapLockPeerResult {
  parked: string[]
  /** Only populated by lock-release's route ({released:[...]}); [] on lock-park. */
  released: string[]
  failed: string[]
}

async function roadmapLockPeers(
  endpoint: BrokerEndpoint,
  path: string,
  projectKey: string,
  peerIds: string[]
): Promise<RoadmapLockPeerResult> {
  const res = await roadmapPost<{ parked?: unknown; released?: unknown; failed?: unknown }>(
    endpoint,
    path,
    signedAsOperator({
      project_key: projectKey,
      peer_ids: peerIds,
      by: DECK_AUTHOR
    })
  )
  return { parked: strList(res?.parked), released: strList(res?.released), failed: strList(res?.failed) }
}

/**
 * Card aaf4537d lot 3, Pause: parks the roadmap lock(s) held by `peerIds` so
 * dispatch skips them while their tiles are paused. Targets PEER_IDS, never
 * card ids -- a peer may hold zero, one or several locked cards.
 *
 * POST /roadmap/lock-park is implemented broker-side (round-3 mutation
 * review, card aaf4537d) -- this call reaches a real route, not a stub. It
 * can still throw (roadmapPost rejects on a non-ok response: missing
 * operator proof, an over-cap batch, a network error), so callers must catch
 * and report, never let this block the stop primitive itself.
 */
export async function lockPark(
  endpoint: BrokerEndpoint,
  projectKey: string,
  peerIds: string[]
): Promise<RoadmapLockPeerResult> {
  return roadmapLockPeers(endpoint, '/roadmap/lock-park', projectKey, peerIds)
}

/**
 * Card aaf4537d lot 3, Hard Stop's counterpart of lockPark: releases the
 * park instead of setting it. Same "call the real broker route, catch and
 * report on failure" contract as lockPark above.
 */
export async function lockRelease(
  endpoint: BrokerEndpoint,
  projectKey: string,
  peerIds: string[]
): Promise<RoadmapLockPeerResult> {
  return roadmapLockPeers(endpoint, '/roadmap/lock-release', projectKey, peerIds)
}

// ----- Roadmap replication (offline replica) -----
// The Deck NEVER talks to the upstream broker: it polls the LOCAL broker,
// which owns the replication loop. Every response below is sanitized through
// the same pick-list discipline as /roadmap/list -- a replica answers with
// rows it received from a machine this Deck has no relationship with, so the
// shapes are trusted even less here than elsewhere.

/** A counter, or undefined -- rejects NaN and non-integers explicitly. */
function counter(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined
}

/** A counter that must exist, defaulting to 0 (a revision is never absent). */
function revision(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) ? v : 0
}

function boolOrUndefined(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

function strOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/**
 * Lock counters travel as one object or not at all: a partially-readable set
 * would report "0 contested locks" on a broker that simply spoke a different
 * shape, which is a confident zero over something nobody counted.
 */
function lockCounts(v: unknown): RoadmapSyncStatus['locks'] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const r = v as Record<string, unknown>
  const local = counter(r.local)
  const global = counter(r.global)
  const contested = counter(r.contested)
  const remote = counter(r.remote)
  if (local === undefined || global === undefined || contested === undefined || remote === undefined) {
    return undefined
  }
  return { local, global, contested, remote }
}

/**
 * Pick-list over the status payload. `mode` falls back to 'local', the inert
 * value: an unreadable status must never make the Deck believe it is a
 * replica, since that alone starts the conflicts poll and can raise the
 * offline banner. Every other field is optional by contract (a non-replica
 * broker answers `{ mode }` alone), so an absent one stays absent rather than
 * becoming a fabricated zero.
 */
export function sanitizeSyncStatus(raw: unknown, route = '/roadmap/sync/status'): RoadmapSyncStatus {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    reportError('roadmap', `${route}: response was not an object; treated as a non-replica broker`)
    return { mode: 'local' }
  }
  const r = raw as Record<string, unknown>
  return {
    mode: oneOf(r.mode, SYNC_MODES, 'local'),
    upstream_url: strOrUndefined(r.upstream_url),
    online: boolOrUndefined(r.online),
    since: strOrUndefined(r.since),
    last_error: nullableStr(r.last_error),
    last_sync_at: nullableStr(r.last_sync_at),
    cursor: counter(r.cursor),
    conflicts: counter(r.conflicts),
    pending_push: counter(r.pending_push),
    refused: counter(r.refused),
    refused_locks: counter(r.refused_locks),
    locks: lockCounts(r.locks)
  }
}

/**
 * The upstream row: an ordinary item plus the two revision counters. Reuses
 * sanitizeRoadmapItem so the content pick-list has exactly one definition --
 * a second copy here is what would silently let a new column through.
 */
function sanitizeSyncRow(raw: unknown): RoadmapSyncRow | null {
  const item = sanitizeRoadmapItem(raw)
  if (!item) return null
  const r = raw as Record<string, unknown>
  return { ...item, rev: revision(r.rev), content_rev: revision(r.content_rev) }
}

/** Explicit pick-list, never a loop over the field array: the compiler checks it. */
function contentOf(item: RoadmapItem): RoadmapSyncContent {
  return {
    kind: item.kind,
    title: item.title,
    description: item.description,
    rationale: item.rationale,
    context: item.context,
    priority: item.priority,
    value: item.value,
    effort: item.effort,
    status: item.status,
    tags: item.tags,
    depends_on: item.depends_on,
    deleted_at: item.deleted_at,
    directive: item.directive,
    target_peer_ids: item.target_peer_ids,
    inactive: item.inactive
  }
}

/**
 * The common base carries the fifteen content columns and nothing else, so it
 * is sanitized by borrowing the item pick-list under the conflict's own
 * id/project_key and keeping the content half. null (never synced) is a
 * legitimate value the dialog renders differently, not a failure.
 */
function sanitizeSyncBase(raw: unknown, id: string, projectKey: string): RoadmapSyncContent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const item = sanitizeRoadmapItem({
    ...(raw as Record<string, unknown>),
    id,
    project_key: projectKey
  })
  return item ? contentOf(item) : null
}

/**
 * Sanitize the conflicts list, tracing how many entries were unusable. A
 * conflict missing either side cannot be arbitrated at all -- the dialog would
 * offer three buttons over half a card -- so it is dropped rather than
 * half-rendered.
 */
export function sanitizeSyncConflicts(raw: unknown, route = '/roadmap/sync/conflicts'): RoadmapSyncConflict[] {
  const items = Array.isArray(raw) ? raw : []
  if (!Array.isArray(raw)) {
    reportError('roadmap', `${route}: response items was not an array; treated as empty`)
  }
  const out: RoadmapSyncConflict[] = []
  let dropped = 0
  for (const entry of items) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      dropped++
      continue
    }
    const e = entry as Record<string, unknown>
    const local = sanitizeRoadmapItem(e.local)
    const remote = sanitizeSyncRow(e.remote)
    if (!local || !remote) {
      dropped++
      continue
    }
    out.push({ local, remote, base: sanitizeSyncBase(e.base, local.id, local.project_key) })
  }
  if (dropped > 0) {
    reportError('roadmap', `${route}: dropped ${dropped} conflict(s) missing a usable local or remote side`)
  }
  return out
}

/** Replication health of the broker this Deck talks to. */
export async function fetchRoadmapSyncStatus(endpoint: BrokerEndpoint): Promise<RoadmapSyncStatus> {
  const res = await roadmapPost<unknown>(endpoint, '/roadmap/sync/status', {})
  return sanitizeSyncStatus(res)
}

/** Cards of ONE project awaiting the operator's arbitration. */
export async function fetchRoadmapConflicts(
  endpoint: BrokerEndpoint,
  projectKey: string
): Promise<RoadmapSyncConflict[]> {
  const res = await roadmapPost<{ items?: unknown }>(endpoint, '/roadmap/sync/conflicts', {
    project_key: projectKey
  })
  return sanitizeSyncConflicts(res?.items)
}

/**
 * Arbitrate one conflict. An operator write like every other roadmap write of
 * this module: signed, attributed to the reserved 'deck' author.
 */
export async function resolveRoadmapConflict(
  endpoint: BrokerEndpoint,
  id: string,
  choice: RoadmapSyncResolution
): Promise<RoadmapItem> {
  const res = await roadmapPost<{ item?: unknown }>(
    endpoint,
    '/roadmap/sync/resolve',
    signedAsOperator({ id, choice, by: DECK_AUTHOR })
  )
  return sanitizeOne(res?.item, '/roadmap/sync/resolve')
}
