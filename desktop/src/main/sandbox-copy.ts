// Sandbox mode (PLAN-SANDBOX M3): the "ephemeral copy" work mode. Instead of
// bind-mounting the real project, the Deck clones it HOST-side into a throwaway
// dir and mounts THAT — so agents cannot touch the real tree, while the Deck's
// git/diff/explorer views keep working (the clone is a normal repo on disk).
//
// `git clone --local` shares the object store, so even a large repo clones in
// well under a second and costs almost no disk.
//
// The clone alone is not enough: files that are deliberately gitignored but
// needed to work (planning notes, local fixtures) would vanish. Hence an
// operator ALLOW-LIST of globs copied on top — with a hard DENY-LIST that wins
// over anything configured: secrets (.env*), credential material and huge
// dependency dirs must never be duplicated into a sandbox that has network
// access.
//
// Node builtins only (no electron, no @shared alias) so it is bun-testable.

import { lstatSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * Never copied, whatever the operator configured. `.git` would corrupt the
 * clone; node_modules/.venv are re-installable bulk; the rest is secret
 * material an agent with egress must not be handed.
 */
const DENY_PATTERNS = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.venv(\/|$)/,
  /(^|\/)__pycache__(\/|$)/,
  /(^|\/)\.env($|\.)/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)id_(rsa|ed25519|ecdsa)($|\.)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.ssh(\/|$)/,
  /\.pem$/,
  /\.p12$/,
  /\.pfx$/,
  /\.key$/
]

/** Dirs never walked when collecting candidates (perf + the deny-list above). */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.venv',
  '__pycache__',
  'dist',
  'out',
  'build',
  '.next',
  '.cache',
  '.worktrees'
])

/** Hard cap on collected files so a huge tree cannot balloon the copy plan. */
const MAX_WALK_ENTRIES = 20_000
/**
 * Hard cap on VISITED entries. Distinct from the file cap on purpose: a
 * directory tree with no files at all still costs iterations, and this walk
 * runs synchronously on the main process during a spawn.
 */
const MAX_WALK_VISITS = 200_000

/** True when a repo-relative POSIX path may never be copied into the sandbox. */
export function isDeniedCopyPath(relPosix: string): boolean {
  return DENY_PATTERNS.some((re) => re.test(relPosix))
}

/**
 * Minimal glob → RegExp: `**` crosses separators, `*` and `?` do not. Enough
 * for the patterns this feature takes (`PLAN-*.md`, `docs/**`, `notes/?.txt`)
 * without pulling a dependency into the main process.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = '^'
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` should also match zero segments (docs/**/x matches docs/x).
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      continue
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(out + '$')
}

/**
 * The repo-relative paths to copy: allow-listed by the operator's globs, then
 * filtered by the deny-list (which always wins). A pattern with no separator
 * also matches at any depth (`PLAN-*.md` catches `docs/PLAN-x.md`) — the
 * intuitive reading of a bare filename pattern.
 */
export function selectCopyPaths(relPaths: string[], globs: string[]): string[] {
  const patterns = globs
    .map((g) => g.trim().replace(/\\/g, '/'))
    .filter(Boolean)
    .flatMap((g) => (g.includes('/') ? [g] : [g, `**/${g}`]))
    .map(globToRegExp)
  if (patterns.length === 0) return []
  return relPaths
    .map((p) => p.replace(/\\/g, '/'))
    .filter((p) => !isDeniedCopyPath(p) && patterns.some((re) => re.test(p)))
    .sort()
}

/**
 * Collect repo-relative file paths of `root`, skipping heavy/forbidden dirs.
 * Best-effort: an unreadable subtree is skipped rather than failing the spawn.
 */
export function walkProjectFiles(root: string): string[] {
  const out: string[] = []
  const stack: string[] = [root]
  let visits = 0
  while (stack.length > 0 && out.length < MAX_WALK_ENTRIES && visits < MAX_WALK_VISITS) {
    const dir = stack.pop()!
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue // unreadable dir: nothing to copy from it
    }
    for (const name of names) {
      if (SKIP_DIRS.has(name)) continue
      if (++visits >= MAX_WALK_VISITS) break
      const full = join(dir, name)
      let stat: ReturnType<typeof lstatSync>
      try {
        stat = lstatSync(full)
      } catch {
        continue // raced unlink
      }
      // SYMLINKS ARE NEVER FOLLOWED (lstat, and links are skipped outright):
      // a link out of the tree would copy foreign files into the sandbox clone,
      // and a self-referential one made this synchronous walk spin forever —
      // the file cap could not stop it because a link loop yields no files.
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        stack.push(full)
      } else if (stat.isFile()) {
        out.push(relative(root, full).split(sep).join('/'))
        if (out.length >= MAX_WALK_ENTRIES) break
      }
    }
  }
  return out
}

/** Everything the copy mode needs to know about one project's clone. */
export interface CopyPlan {
  /** Repo-relative paths to duplicate on top of the clone. */
  files: string[]
  /** Patterns that matched nothing (surfaced so a typo is visible). */
  unmatched: string[]
}

/** Resolve the copy plan for a project + its configured globs. */
export function planIgnoredCopy(projectDir: string, globs: string[]): CopyPlan {
  const all = walkProjectFiles(projectDir)
  const files = selectCopyPaths(all, globs)
  const unmatched = globs
    .map((g) => g.trim())
    .filter(Boolean)
    .filter((g) => selectCopyPaths(all, [g]).length === 0)
  return { files, unmatched }
}
