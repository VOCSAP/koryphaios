// Diff / review layer (PLAN C13): what did a session (or worktree) change?
// Two scopes are collected together:
//   - uncommitted: working tree vs HEAD (plus untracked files),
//   - branch: commits on the worktree branch vs the main branch (merge-base,
//     `base...HEAD`), only when a base is given.
//
// Node builtins only (no electron, no @shared alias) so it is unit-testable
// under `bun test` on a throwaway repo, like worktree-service.ts.
//
// SECURITY (C8 rule): the review prompt below is a CODE CONSTANT — never an
// operator/repo template.

import { execFile } from 'node:child_process'

/** Cap on the raw unified diff shipped to the renderer / review prompt. */
export const DIFF_TEXT_MAX = 150_000

export interface DiffFile {
  path: string
  /** Added lines; null for binary files and untracked files (not counted). */
  additions: number | null
  /** Deleted lines; null for binary and untracked. */
  deletions: number | null
  /** True for a file git does not track yet (shows in status, not in diff). */
  untracked: boolean
}

export interface SessionDiff {
  /** Working tree vs HEAD + untracked files. */
  uncommitted: DiffFile[]
  /** Commits of this branch vs `base` (merge-base); null when no base. */
  branch: DiffFile[] | null
  /** The comparison base branch (the main worktree's branch), or null. */
  base: string | null
  /** Raw unified diff (branch section first, then uncommitted), capped. */
  text: string
  /** True when `text` was cut at DIFF_TEXT_MAX. */
  truncated: boolean
}

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((res, rej) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) rej(new Error(stderr.trim() || err.message))
        else res(stdout)
      }
    )
  })
}

/** Parse `git diff --numstat` output ("added\tdeleted\tpath"; "-" = binary). */
export function parseNumstat(out: string): DiffFile[] {
  const files: DiffFile[] = []
  for (const line of out.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
    if (!m) continue
    files.push({
      path: m[3]!,
      additions: m[1] === '-' ? null : parseInt(m[1]!, 10),
      deletions: m[2] === '-' ? null : parseInt(m[2]!, 10),
      untracked: false
    })
  }
  return files
}

/** Untracked paths from `git status --porcelain` ("?? path"). */
export function parseUntracked(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .filter((l) => l.startsWith('?? '))
    .map((l) => l.slice(3).trim())
    .filter((p) => p !== '')
}

/**
 * Collect the full diff picture of `dir`. `base` (the main branch) enables the
 * branch section — pass null for a session running in the main working tree.
 * Unborn HEAD (fresh repo, no commit) degrades to untracked-only.
 */
export async function collectDiff(dir: string, base?: string | null): Promise<SessionDiff> {
  const [numstat, porcelain, uncommittedText] = await Promise.all([
    git(['diff', 'HEAD', '--numstat'], dir).catch(() => ''),
    git(['status', '--porcelain'], dir).catch(() => ''),
    git(['diff', 'HEAD'], dir).catch(() => '')
  ])
  const uncommitted = parseNumstat(numstat)
  for (const path of parseUntracked(porcelain)) {
    uncommitted.push({ path, additions: null, deletions: null, untracked: true })
  }

  let branch: DiffFile[] | null = null
  let branchText = ''
  if (base) {
    // Three-dot: merge-base(base, HEAD)..HEAD — exactly what the branch added,
    // regardless of how far the base has moved on since the fork point.
    branch = parseNumstat(await git(['diff', '--numstat', `${base}...HEAD`], dir).catch(() => ''))
    branchText = await git(['diff', `${base}...HEAD`], dir).catch(() => '')
  }

  const sections: string[] = []
  if (branchText.trim()) sections.push(`# --- branch vs ${base} ---\n${branchText}`)
  if (uncommittedText.trim()) sections.push(`# --- uncommitted ---\n${uncommittedText}`)
  const full = sections.join('\n')
  const truncated = full.length > DIFF_TEXT_MAX
  return {
    uncommitted,
    branch,
    base: base ?? null,
    text: truncated ? full.slice(0, DIFF_TEXT_MAX) : full,
    truncated
  }
}

/**
 * One-shot review agent prompt (PLAN C13). The agent reads the diff itself
 * (its cwd IS the reviewed dir) and posts its review to the team-lead peer
 * when one exists, otherwise prints it in its own tile. CODE CONSTANT.
 */
export function composeDiffReviewPrompt(opts: {
  dir: string
  base: string | null
  leadPeerId: string | null
}): string {
  const scope = opts.base
    ? `the commits of this branch versus "${opts.base}" (\`git diff ${opts.base}...HEAD\`) plus any uncommitted changes (\`git diff HEAD\` and untracked files)`
    : 'the uncommitted changes (`git diff HEAD` and untracked files from `git status`)'
  const deliver = opts.leadPeerId
    ? `Send the review to the team-lead with send_message to peer '${opts.leadPeerId}' (split into 2-3 messages if long), then a one-line verdict here.`
    : `No team-lead is designated: print the full review here in your terminal.`
  return [
    `You are a one-shot CODE REVIEWER for the working directory "${opts.dir}". Review ${scope}, then exit. Follow exactly these steps:`,
    `1. Read the diff with the git commands above (read surrounding files when the diff alone is ambiguous).`,
    `2. Write a review: verdict first (ship / fix first / rework), then findings ordered by severity (bugs, risks, tests missing, style last), each anchored to file:line. Be concrete and brief; no praise padding.`,
    `3. ${deliver}`,
    `4. Type /exit to close this session (your terminal closes automatically).`,
    `Do not modify, stage, commit or push anything. Review only.`
  ].join('\n')
}
