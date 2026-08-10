// Roadmap client for the Deck (PLAN C3-M3). Read/write access to the broker's
// per-project roadmap (/roadmap/list|upsert|archive) for the operator UI.
//
// Node builtins + fetch only (no electron, no @shared alias) so it is
// unit-testable under `bun test` against an ephemeral broker, like
// broker-client.ts. The broker endpoint comes from the same claude-peers
// config the spawned sessions use (resolveBrokerEndpoint).
//
// The project key MUST match what server.ts computes for the sessions spawned
// in the same directory, otherwise the Deck and its agents would see two
// different roadmaps: normalized git remote when there is one (mirror of
// shared/summarize.ts normalizeRemoteUrl + computeProjectKey), else the same
// stable `local:<sha256(gitRoot ?? dir)[:16]>` fallback as server.ts.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { reportError } from './log'
import type { BrokerEndpoint } from './broker-client'
import type {
  RoadmapArchiveResponse,
  RoadmapFacetBucket,
  RoadmapFacets,
  RoadmapItem,
  RoadmapListFilters,
  RoadmapListResponse,
  RoadmapQuery,
  RoadmapReorderResponse,
  RoadmapSearchResult,
  RoadmapUpsertFields,
  RoadmapUpsertResponse
} from '../shared/types'

/** Mirror of shared/summarize.ts normalizeRemoteUrl (kept in sync manually). */
export function normalizeRemoteUrl(url: string): string | null {
  let s = url.trim()
  if (!s) return null
  s = s.replace(/\.git$/i, '')

  const scpMatch = s.match(/^([^@\s:/]+)@([^:\s/]+):(?!\/)(.+)$/)
  if (scpMatch && !s.includes('://')) {
    const host = (scpMatch[2] ?? '').toLowerCase()
    const path = (scpMatch[3] ?? '').replace(/^\/+/, '')
    return `${host}/${path}`
  }

  const protoMatch = s.match(/^[a-z+]+:\/\/(.+)$/i)
  if (protoMatch) {
    let rest = protoMatch[1] ?? ''
    const atIdx = rest.indexOf('@')
    const slashIdx = rest.indexOf('/')
    if (atIdx !== -1 && (slashIdx === -1 || atIdx < slashIdx)) {
      rest = rest.slice(atIdx + 1)
    }
    const firstSlash = rest.indexOf('/')
    if (firstSlash === -1) return rest.toLowerCase()
    let host = rest.slice(0, firstSlash)
    const path = rest.slice(firstSlash + 1)
    const colonIdx = host.indexOf(':')
    if (colonIdx !== -1) host = host.slice(0, colonIdx)
    return `${host.toLowerCase()}/${path}`
  }

  return s.toLowerCase()
}

function gitOutput(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

/**
 * The roadmap scope for a project directory. Same resolution as server.ts:
 * normalized `origin` remote, else `local:` + sha256(gitRoot ?? dir)[:16].
 */
export function computeDeckProjectKey(projectDir: string): string {
  const remote = gitOutput(['remote', 'get-url', 'origin'], projectDir)
  if (remote) {
    const normalized = normalizeRemoteUrl(remote)
    if (normalized) return normalized
  }
  const anchor = gitOutput(['rev-parse', '--show-toplevel'], projectDir) ?? projectDir
  return `local:${createHash('sha256').update(anchor, 'utf-8').digest('hex').slice(0, 16)}`
}

// --- Operator signature on operator-authored writes (card 39c40571 layer 2) ---
//
// A write claiming `by: 'deck'` speaks as the HUMAN, and the broker now demands
// an Ed25519 proof for it. The identity lives in the app-state directory and is
// read through a cipher, both of which are electron-side concerns, so this
// module never loads it: index.ts injects a LOADER once and the first WRITE
// calls it. Lazy on purpose -- the identity used to be loaded only inside
// ApprovalRuntime.arm(), which is gated by the mobileApprovals setting, so
// wiring the signature there would have made a phone-notification toggle the
// on/off switch of the shared roadmap.
//
// One loader per main process, and that is the right key: the identity file
// lives in the per-OS-user app-state directory (see operator-identity.ts), so
// one running Deck is one OS user is one operator. Two OS accounts are two
// processes with two directories, never two identities racing on this variable.
/**
 * The fields a signature ADDS to the body: the proof itself plus the public
 * key. The key travels because operator_id is its digest, so a broker meeting
 * this operator for the first time can self-certify the binding instead of
 * refusing an unknown id -- and the signature must therefore cover the body
 * WITH the key in it, which is why the signer receives the payload and returns
 * both fields rather than just a proof.
 */
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
    throw new Error(detail || `roadmap request failed: ${res.status}`)
  }
  return (await res.json()) as T
}

/** Operator writes are attributed to the reserved 'deck' author. */
const DECK_AUTHOR = 'deck'

// --- Boundary validation (roadmap card c7ba8ce8) -----------------------------
//
// roadmapPost ends with `as T` on a network body, which validates nothing, while
// a broker response field is hostile input #2 by convention. Measured cost of
// trusting it: a `target_peer_ids` holding a STRING does NOT throw in
// resolveDirectiveTargets (directive.ts iterates the CHARACTERS of a string), so
// executeDirective reaches its `matched.length === 0` branch and rejects on
// `.join`. The same shape on `depends_on` is worse because it is SILENT: a
// string HAS `.includes`, so RoadmapList/RoadmapView answer substring matches
// and report dependencies that do not exist, with no error anywhere.
//
// The guard therefore lives at the choke point every response passes through,
// not at one caller: validating only listRoadmap would leave upsert, reorder and
// archive open, which is a validator wired to one of its call paths.
//
// COERCE, do not drop: an empty `target_peer_ids` routes into the pre-existing
// "no live target" branch, which already journals. Dropping the item instead
// would make the operator's board lie by omission.

const KINDS = ['feature', 'bug', 'debt', 'idea', 'chore', 'directive'] as const
const PRIORITIES = ['must', 'should', 'could', 'wont'] as const
const LEVELS = ['low', 'medium', 'high'] as const
const STATUSES = ['idea', 'planned', 'in_progress', 'done', 'archived'] as const
const DIRECTIVES = ['clear', 'compact', 'magic_compact'] as const

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
 * Shape one roadmap item coming off the wire, or null when it is unusable.
 *
 * PICK-LIST, NEVER A SPREAD. Do not "simplify" this into `{ ...raw, tags: ... }`:
 * `RoadmapItem` has 24 fields and the list below covers all 24, so a 25th added
 * broker-side would travel through unvalidated with nothing failing, which is
 * the canonical fail-open shape this guard exists to avoid. Naming every field
 * means a new one simply does not arrive until someone adds it here, and the
 * compiler asks for it.
 *
 * `id` and `project_key` are STRUCTURAL rather than coercible: an item without
 * them cannot be addressed, updated or matched, so it is dropped and traced.
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
    directive: typeof r.directive === 'string' ? oneOfOrNull(r.directive) : null,
    target_peer_ids: strList(r.target_peer_ids)
  }
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
 * One facet dimension's buckets. Malformed INDIVIDUAL buckets are dropped
 * and traced (mirrors sanitizeList's dropped-count discipline) -- but this
 * never manufactures a bucket list out of a dimension that isn't an array at
 * all; sanitizeFacets checks that shape itself and rejects the whole payload
 * when it's wrong, per review round 2 point 2.
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
 * Shape a `RoadmapFacets` payload, or null when unusable -- PICK-LIST, NEVER
 * A SPREAD, same discipline as sanitizeRoadmapItem. Returning null (never a
 * partially-filled object) is deliberate: `RoadmapSearchResult.facets` is
 * typed `RoadmapFacets | null` precisely so an older broker that never sends
 * counters is distinguishable from a real zero-count bucket -- a half-built
 * object here would silently manufacture false zeros in the filter panel.
 *
 * Review round 2 (2026-08-10), MAJOR (point 2): this used to return `[]` for
 * any dimension whose bucket array was malformed, silently, with no trace --
 * so a broker response where only `kind` was broken shipped a VALID-looking
 * facets object with `kind: []`, indistinguishable from "this project truly
 * has zero of every kind", a silent false-empty the filter panel could not
 * tell apart from a real zero. Fixed: every one of the six expected
 * dimensions is checked for `Array.isArray` up front; if even one fails, the
 * WHOLE payload is rejected (traced) and the caller falls back to no
 * facets at all -- the same "distinguishable from an older broker" contract
 * the doc above already promises, now actually honoured per-dimension too.
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
