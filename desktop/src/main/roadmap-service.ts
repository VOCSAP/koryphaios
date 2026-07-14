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
import type { BrokerEndpoint } from './broker-client'
import type {
  RoadmapArchiveResponse,
  RoadmapItem,
  RoadmapListFilters,
  RoadmapListResponse,
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

export async function listRoadmap(
  endpoint: BrokerEndpoint,
  projectKey: string,
  filters: RoadmapListFilters = {}
): Promise<RoadmapItem[]> {
  const res = await roadmapPost<RoadmapListResponse>(endpoint, '/roadmap/list', {
    project_key: projectKey,
    ...filters
  })
  return res.items
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
  return res.item
}

export async function archiveRoadmap(endpoint: BrokerEndpoint, id: string): Promise<RoadmapItem> {
  const res = await roadmapPost<RoadmapArchiveResponse>(endpoint, '/roadmap/archive', {
    id,
    by: DECK_AUTHOR
  })
  return res.item
}
