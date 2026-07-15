// Git worktree layer for the Deck (PLAN C4). One session = one working dir +
// one branch, so several agents can work the same repo in parallel without
// stepping on each other. Worktrees live under <projectDir>/.worktrees/<name>
// (recommend adding `.worktrees/` to the project's .gitignore).
//
// Node builtins only (no electron, no @shared alias) so it is unit-testable
// under `bun test` on a throwaway repo, like roadmap-service.ts. All git
// errors surface as thrown Error messages for the IPC layer to relay.
//
// Deliberate rules:
// - `remove` NEVER deletes the branch, and never uses --force: un-merged or
//   dirty work must survive a tile closing (the operator can force by hand).
// - The optional post-create hook (deps install) runs in the BACKGROUND:
//   spawning the session is never gated on an `npm install`.

import { exec, execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

export const WORKTREES_DIR = '.worktrees'

export interface WorktreeInfo {
  /** Absolute path of the worktree directory. */
  path: string
  /** Checked-out branch (refs/heads/ stripped), or null (detached/bare). */
  branch: string | null
  /** True for the repo's main working tree (never removable from the Deck). */
  main: boolean
}

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((res, rej) => {
    execFile('git', args, { cwd, encoding: 'utf-8' }, (err, stdout, stderr) => {
      if (err) rej(new Error(stderr.trim() || err.message))
      else res(stdout)
    })
  })
}

/** Sanitize a worktree/branch fragment into a safe directory name. */
export function worktreeDirName(branch: string): string {
  return (
    branch
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'worktree'
  )
}

/**
 * Create `<projectDir>/.worktrees/<name>` checked out on the NEW branch
 * `branch` (git refuses an existing branch or path -- surfaced as an error).
 * Returns the created worktree info.
 */
export async function createWorktree(projectDir: string, branch: string): Promise<WorktreeInfo> {
  const name = worktreeDirName(branch)
  const path = join(projectDir, WORKTREES_DIR, name)
  if (existsSync(path)) throw new Error(`worktree path already exists: ${path}`)
  await git(['worktree', 'add', path, '-b', branch.trim()], projectDir)
  return { path: resolve(path), branch: branch.trim(), main: false }
}

/** Parse `git worktree list --porcelain` for the repo owning `projectDir`. */
export async function listWorktrees(projectDir: string): Promise<WorktreeInfo[]> {
  const out = await git(['worktree', 'list', '--porcelain'], projectDir)
  const infos: WorktreeInfo[] = []
  let current: Partial<WorktreeInfo> | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current?.path) infos.push(finishInfo(current, infos.length === 0))
      current = { path: resolve(line.slice('worktree '.length).trim()) }
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
    }
  }
  if (current?.path) infos.push(finishInfo(current, infos.length === 0))
  return infos
}

function finishInfo(partial: Partial<WorktreeInfo>, first: boolean): WorktreeInfo {
  return { path: partial.path!, branch: partial.branch ?? null, main: first }
}

/**
 * Remove a worktree directory (never its branch; never --force). Refuses the
 * main working tree. Dirty/locked worktrees make git fail -- the error is
 * surfaced so the UI can tell the operator to clean up or force by hand.
 */
export async function removeWorktree(projectDir: string, path: string): Promise<void> {
  const all = await listWorktrees(projectDir)
  const target = all.find((w) => w.path === resolve(path))
  if (!target) throw new Error(`not a worktree of this repo: ${path}`)
  if (target.main) throw new Error('refusing to remove the main working tree')
  await git(['worktree', 'remove', target.path], projectDir)
}

/** True when `cwd` sits under a `.worktrees/` dir (a Deck-created worktree). */
export function isDeckWorktreePath(cwd: string): boolean {
  return resolve(cwd).split(sep).includes(WORKTREES_DIR)
}

export interface WorktreeStatus {
  /** Count of uncommitted changes (`git status --porcelain` lines). */
  dirty: number
  /** Last commit as "subject (relative date)", or null (unborn/unreadable). */
  lastCommit: string | null
}

/** Enriched per-worktree git status for the Worktrees view (PLAN C6). */
export async function worktreeStatus(path: string): Promise<WorktreeStatus> {
  const [porcelain, last] = await Promise.all([
    git(['status', '--porcelain'], path).catch(() => ''),
    git(['log', '-1', '--format=%s (%cr)'], path).catch(() => '')
  ])
  return {
    dirty: porcelain.split('\n').filter((l) => l.trim() !== '').length,
    lastCommit: last.trim() || null
  }
}

/**
 * Fire-and-forget post-create hook (e.g. `bun install`), run inside the new
 * worktree through the platform shell. Errors are logged, never thrown: a
 * failed deps install must not kill the session spawn.
 */
export function runWorktreeInit(worktreePath: string, command: string): void {
  const cmd = command.trim()
  if (!cmd) return
  exec(cmd, { cwd: worktreePath, timeout: 10 * 60_000 }, (err) => {
    if (err) console.error(`[worktree-init] '${cmd}' failed in ${worktreePath}:`, err.message)
  })
}
