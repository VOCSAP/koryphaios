// Operator approvals of repo guard-rule files: `{ [project_key]: sha256[] }`.
// A SET of hashes per project rather than one value: two worktrees of the same
// project may carry two versions of rules.json, and approving one must not
// revoke the other. The approval unit is the whole file's hash, so any edit
// puts the file back to pending.
//
// Pure module: node builtins plus writeFileAtomic, no electron.

import { readFileSync } from 'node:fs'
import { validateProjectKey } from '../../../shared/project-key'
import { writeFileAtomic } from './atomic-write'

/** Most recent hashes kept per project key; older ones are forgotten. */
export const TTSR_APPROVALS_PER_KEY = 20

export type TtsrApprovals = Record<string, string[]>

const HASH_RE = /^[0-9a-f]{64}$/

/**
 * Reads the store. A missing file is an empty store. An unreadable or
 * malformed file, or malformed entries, are reported through `onError` and
 * dropped: an approval that cannot be read is simply not granted, which only
 * ever asks the operator again.
 */
export function readTtsrApprovals(file: string, onError: (message: string, err?: unknown) => void): TtsrApprovals {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    onError(`approvals store unreadable: ${file}`, e)
    return {}
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    onError(`approvals store is not valid JSON, treated as empty: ${file}`, e)
    return {}
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    onError(`approvals store is not a JSON object, treated as empty: ${file}`)
    return {}
  }
  const out: TtsrApprovals = {}
  let dropped = 0
  for (const [key, hashes] of Object.entries(data as Record<string, unknown>)) {
    if (!validateProjectKey(key).ok || !Array.isArray(hashes)) {
      dropped++
      continue
    }
    const kept: string[] = []
    for (const h of hashes) {
      if (typeof h === 'string' && HASH_RE.test(h) && !kept.includes(h)) kept.push(h)
      else dropped++
    }
    if (kept.length > 0) out[key] = kept.slice(-TTSR_APPROVALS_PER_KEY)
  }
  if (dropped > 0) onError(`approvals store: dropped ${dropped} malformed entr${dropped === 1 ? 'y' : 'ies'} in ${file}`)
  return out
}

export function isTtsrApproved(approvals: TtsrApprovals, projectKey: string, hash: string): boolean {
  return approvals[projectKey]?.includes(hash) ?? false
}

/**
 * A copy of `approvals` with `hash` recorded as the most recent approval of
 * `projectKey`, keeping only the TTSR_APPROVALS_PER_KEY most recent.
 */
export function withTtsrApproval(approvals: TtsrApprovals, projectKey: string, hash: string): TtsrApprovals {
  if (!validateProjectKey(projectKey).ok) throw new Error(`ttsr approvals: invalid project key ${JSON.stringify(projectKey)}`)
  if (!HASH_RE.test(hash)) throw new Error(`ttsr approvals: invalid hash ${JSON.stringify(hash)}`)
  const prev = (approvals[projectKey] ?? []).filter((h) => h !== hash)
  return { ...approvals, [projectKey]: [...prev, hash].slice(-TTSR_APPROVALS_PER_KEY) }
}

/** Atomic write; throws for the caller to trace. */
export function writeTtsrApprovals(file: string, approvals: TtsrApprovals): void {
  writeFileAtomic(file, JSON.stringify(approvals, null, 2) + '\n', { mode: 0o600 })
}
