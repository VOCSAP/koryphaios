// Operator approvals of repo guard-rule files, two records:
// - `keys`: `{ [project_key]: sha256[] }`, the hashes ever approved for a
//   project, so a NEW worktree of an approved project applies its file at
//   once (two worktrees may carry two versions);
// - `roots`: `{ [canonical project root]: sha256 }`, the one hash a root
//   currently applies. Once a root has one, any other content there, an
//   older approved version included, is pending again: an agent must not
//   weaken its rules by reverting to an earlier approved file.
//
// Pure module: node builtins plus writeFileAtomic, no electron.

import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { validateProjectKey } from '../../../shared/project-key'
import { writeFileAtomic } from './atomic-write'

/** Most recent hashes kept per project key; older ones are forgotten. */
export const TTSR_APPROVALS_PER_KEY = 20
/** Most recently approved project roots kept; an evicted root falls back to its key's set. */
export const TTSR_APPROVALS_MAX_ROOTS = 500

export interface TtsrApprovals {
  keys: Record<string, string[]>
  roots: Record<string, string>
}

export const emptyTtsrApprovals = (): TtsrApprovals => ({ keys: {}, roots: {} })

const HASH_RE = /^[0-9a-f]{64}$/

function validRoot(root: string): boolean {
  return root.length > 0 && root.length <= 4096 && isAbsolute(root) && !root.includes('\0')
}

/**
 * Reads the store (version 2, or the version-1 bare `{ key: hashes }` map,
 * read as `keys` with no root yet). A missing file is an empty store. An
 * unreadable or malformed file, or malformed entries, are reported through
 * `onError` and dropped: an approval that cannot be read is simply not
 * granted, which only ever asks the operator again.
 */
export function readTtsrApprovals(file: string, onError: (message: string, err?: unknown) => void): TtsrApprovals {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyTtsrApprovals()
    onError(`approvals store unreadable: ${file}`, e)
    return emptyTtsrApprovals()
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    onError(`approvals store is not valid JSON, treated as empty: ${file}`, e)
    return emptyTtsrApprovals()
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    onError(`approvals store is not a JSON object, treated as empty: ${file}`)
    return emptyTtsrApprovals()
  }
  const obj = data as Record<string, unknown>
  const v2 = obj.version === 2
  const rawKeys = v2 ? obj.keys : obj
  const rawRoots = v2 ? obj.roots : {}
  const out = emptyTtsrApprovals()
  let dropped = 0
  if (typeof rawKeys === 'object' && rawKeys !== null && !Array.isArray(rawKeys)) {
    for (const [key, hashes] of Object.entries(rawKeys as Record<string, unknown>)) {
      if (!validateProjectKey(key).ok || !Array.isArray(hashes)) {
        dropped++
        continue
      }
      const kept: string[] = []
      for (const h of hashes) {
        if (typeof h === 'string' && HASH_RE.test(h) && !kept.includes(h)) kept.push(h)
        else dropped++
      }
      if (kept.length > 0) out.keys[key] = kept.slice(-TTSR_APPROVALS_PER_KEY)
    }
  } else dropped++
  if (typeof rawRoots === 'object' && rawRoots !== null && !Array.isArray(rawRoots)) {
    const entries = Object.entries(rawRoots as Record<string, unknown>)
    for (const [root, hash] of entries.slice(-TTSR_APPROVALS_MAX_ROOTS)) {
      if (validRoot(root) && typeof hash === 'string' && HASH_RE.test(hash)) out.roots[root] = hash
      else dropped++
    }
  } else dropped++
  if (dropped > 0) onError(`approvals store: dropped ${dropped} malformed entr${dropped === 1 ? 'y' : 'ies'} in ${file}`)
  return out
}

/** `hash` is in the set approved for `projectKey`. */
export function isTtsrApproved(approvals: TtsrApprovals, projectKey: string, hash: string): boolean {
  return approvals.keys[projectKey]?.includes(hash) ?? false
}

/**
 * How a repo file of hash `hash` at canonical `root` stands:
 * 'current' — it is the hash this root applies;
 * 'adoptable' — the root applies nothing yet and the hash is approved for
 *   the key (a new worktree of an approved project): applied, and recorded
 *   as the root's current hash by the caller;
 * 'pending' — anything else, an older approved hash at this root included.
 */
export function ttsrRepoTrust(
  approvals: TtsrApprovals,
  root: string,
  projectKey: string,
  hash: string
): 'current' | 'adoptable' | 'pending' {
  const current = approvals.roots[root]
  if (current !== undefined) return current === hash ? 'current' : 'pending'
  return isTtsrApproved(approvals, projectKey, hash) ? 'adoptable' : 'pending'
}

/**
 * A copy of `approvals` with `hash` recorded as the most recent approval of
 * `projectKey` (keeping the TTSR_APPROVALS_PER_KEY most recent) and, when
 * `root` is given, as the hash that root applies.
 */
export function withTtsrApproval(approvals: TtsrApprovals, projectKey: string, hash: string, root?: string): TtsrApprovals {
  if (!validateProjectKey(projectKey).ok) throw new Error(`ttsr approvals: invalid project key ${JSON.stringify(projectKey)}`)
  if (!HASH_RE.test(hash)) throw new Error(`ttsr approvals: invalid hash ${JSON.stringify(hash)}`)
  const prev = (approvals.keys[projectKey] ?? []).filter((h) => h !== hash)
  const next: TtsrApprovals = {
    keys: { ...approvals.keys, [projectKey]: [...prev, hash].slice(-TTSR_APPROVALS_PER_KEY) },
    roots: approvals.roots
  }
  return root === undefined ? next : withTtsrCurrent(next, root, hash)
}

/** A copy of `approvals` where `root` applies `hash`; the oldest roots beyond TTSR_APPROVALS_MAX_ROOTS are dropped. */
export function withTtsrCurrent(approvals: TtsrApprovals, root: string, hash: string): TtsrApprovals {
  if (!validRoot(root)) throw new Error(`ttsr approvals: invalid project root ${JSON.stringify(root)}`)
  if (!HASH_RE.test(hash)) throw new Error(`ttsr approvals: invalid hash ${JSON.stringify(hash)}`)
  const entries = Object.entries(approvals.roots).filter(([r]) => r !== root)
  entries.push([root, hash])
  return { keys: approvals.keys, roots: Object.fromEntries(entries.slice(-TTSR_APPROVALS_MAX_ROOTS)) }
}

/** Atomic write, version 2; throws for the caller to trace. */
export function writeTtsrApprovals(file: string, approvals: TtsrApprovals): void {
  const body = { version: 2, keys: approvals.keys, roots: approvals.roots }
  writeFileAtomic(file, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 })
}
