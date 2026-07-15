// Git checkpoints (PLAN C16): before spawning an agent into a DIRTY working
// tree, snapshot the tracked changes with `git stash create` (a dangling
// stash commit — no history, no index, no working-tree change) and anchor it
// under refs/claude-peers/checkpoint-<epoch-s> so gc cannot reap it. Restoring
// is a plain `git stash apply <sha>` the operator runs by hand (the Deck never
// mutates the tree). Old checkpoints are purged past a TTL.
//
// Node builtins only (no electron) so it is unit-testable under `bun test`
// on a throwaway repo, like worktree-service.ts.

import { execFile } from 'node:child_process'

export const CHECKPOINT_REF_PREFIX = 'refs/claude-peers/checkpoint-'
export const CHECKPOINT_TTL_DAYS = 7

export interface Checkpoint {
  /** Full ref name (refs/claude-peers/checkpoint-<epoch-seconds>). */
  ref: string
  /** Stash commit sha. */
  sha: string
  /** Epoch ms parsed from the ref name. */
  at: number
}

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((res, rej) => {
    execFile('git', args, { cwd, encoding: 'utf-8' }, (err, stdout, stderr) => {
      if (err) rej(new Error(stderr.trim() || err.message))
      else res(stdout)
    })
  })
}

/** The command the operator runs to bring a checkpoint's changes back. */
export function restoreCommand(cp: Pick<Checkpoint, 'sha'>): string {
  return `git stash apply ${cp.sha}`
}

/**
 * Snapshot `dir`'s tracked changes if the tree is dirty. Returns the created
 * checkpoint, or null when there is nothing to snapshot (clean tree, or only
 * untracked files — `git stash create` does not capture those). Never touches
 * the working tree, the index or the stash list.
 */
export async function createCheckpoint(
  dir: string,
  now: () => number = Date.now
): Promise<Checkpoint | null> {
  const porcelain = await git(['status', '--porcelain'], dir)
  if (porcelain.trim() === '') return null
  const sha = (await git(['stash', 'create'], dir)).trim()
  if (!sha) return null // untracked-only tree: nothing stash can capture
  const seconds = Math.floor(now() / 1000)
  const ref = `${CHECKPOINT_REF_PREFIX}${seconds}`
  await git(['update-ref', ref, sha], dir)
  return { ref, sha, at: seconds * 1000 }
}

/** All checkpoints of `dir`, oldest first. Unparseable refs are skipped. */
export async function listCheckpoints(dir: string): Promise<Checkpoint[]> {
  const out = await git(
    ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/claude-peers/'],
    dir
  ).catch(() => '')
  const cps: Checkpoint[] = []
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\S+) ([0-9a-f]{7,64})$/)
    if (!m || !m[1]!.startsWith(CHECKPOINT_REF_PREFIX)) continue
    const seconds = parseInt(m[1]!.slice(CHECKPOINT_REF_PREFIX.length), 10)
    if (!Number.isFinite(seconds)) continue
    cps.push({ ref: m[1]!, sha: m[2]!, at: seconds * 1000 })
  }
  return cps.sort((a, b) => a.at - b.at)
}

/**
 * Delete checkpoints older than `maxAgeDays`. Returns how many were removed.
 * The stash commits become unreachable and normal git gc reclaims them later.
 */
export async function purgeCheckpoints(
  dir: string,
  maxAgeDays: number = CHECKPOINT_TTL_DAYS,
  now: () => number = Date.now
): Promise<number> {
  const cutoff = now() - maxAgeDays * 24 * 60 * 60 * 1000
  const expired = (await listCheckpoints(dir)).filter((cp) => cp.at < cutoff)
  for (const cp of expired) {
    await git(['update-ref', '-d', cp.ref], dir).catch(() => undefined)
  }
  return expired.length
}
