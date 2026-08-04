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
  RoadmapItem,
  RoadmapListFilters,
  RoadmapListResponse,
  RoadmapReorderResponse,
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

export async function upsertRoadmap(
  endpoint: BrokerEndpoint,
  projectKey: string,
  fields: RoadmapUpsertFields
): Promise<RoadmapItem> {
  const res = await roadmapPost<RoadmapUpsertResponse>(endpoint, '/roadmap/upsert', {
    // project_key is ignored by the broker on patch (id set) and required on create.
    project_key: projectKey,
    by: DECK_AUTHOR,
    ...fields
  })
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
  const res = await roadmapPost<RoadmapReorderResponse>(endpoint, '/roadmap/reorder', {
    project_key: projectKey,
    by: DECK_AUTHOR,
    ids,
    // Additive over the wire too (roadmap card 42edc88b phase 1): omit the
    // field entirely when unset rather than sending `waves: undefined`, so
    // an older broker sees exactly the request shape it already understands.
    ...(waves !== undefined ? { waves } : {})
  })
  return sanitizeList(res?.items, '/roadmap/reorder')
}

export async function archiveRoadmap(endpoint: BrokerEndpoint, id: string): Promise<RoadmapItem> {
  const res = await roadmapPost<RoadmapArchiveResponse>(endpoint, '/roadmap/archive', {
    id,
    by: DECK_AUTHOR
  })
  return sanitizeOne(res?.item, '/roadmap/archive')
}
