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
// dependency dirs are denied by shape; the list is not a completeness
// guarantee, and a sandbox with network access is handed whatever a glob
// selects that this list doesn't happen to name.
//
// Node builtins only (no electron, no @shared alias) so it is bun-testable.

import { lstatSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * A dot-extension counted as a match wherever it occurs as its own path
 * segment component: at the true end of the string (`server.pem`), or
 * followed by decoration that doesn't extend the extension into a different
 * word AND stays in the SAME path segment (`server.pem.bak`, `key.pem~`, a
 * Windows trailing dot/space, `app.key-mapping.json`). A plain `$` anchor is
 * defeated by any of those; requiring the next character (if any) to be
 * non-alphanumeric keeps `.pem` from matching `.pemx` while still matching
 * every decorated form. The decoration class also excludes `/`: without
 * that, the extension token matched inside a DIRECTORY component too (e.g.
 * `foo.key/bar.txt`), silently denying the whole subtree under a dir merely
 * NAMED like a key file. Once the decoration starts, `/` is allowed to
 * appear again (`[^/]*`) so multi-dot same-segment decoration keeps working;
 * it is only the character immediately after the extension that must not be
 * a segment separator.
 *
 * Residual: same-segment decoration is still denied even though it isn't a
 * secret (`app.key-mapping.json`, `docs/api.key-rotation.md`,
 * `deploy.pem_notes.md`, `README.keystore-guide.md`). Deliberate fail-closed
 * trade-off -- a file whose name merely LOOKS like a key/cert derivative
 * stays out rather than risk a real one slipping through a cleverer suffix.
 */
function extDeny(ext: string): RegExp {
  return new RegExp(`\\.${ext}(?:[^a-zA-Z0-9/][^/]*)?$`, 'i')
}

/**
 * Never copied, whatever the operator configured. `.git` would corrupt the
 * clone; node_modules/.venv/dist/out/build/.next/.cache/.worktrees are
 * re-installable or throwaway bulk (also the SKIP_DIRS traversal prune below
 * -- that prune is a perf optimisation ONLY, this list is the real gate, so
 * it must cover every SKIP_DIRS entry); the rest is secret material an agent
 * with network egress must not be handed. All case-insensitive: Windows and
 * macOS filesystems are case-insensitive, and a bare `re.test` would miss
 * `.ENV` / `ID_RSA` / `server.PEM` on either.
 */
const DENY_PATTERNS = [
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)\.venv(\/|$)/i,
  /(^|\/)__pycache__(\/|$)/i,
  /(^|\/)dist(\/|$)/i,
  /(^|\/)out(\/|$)/i,
  /(^|\/)build(\/|$)/i,
  /(^|\/)\.next(\/|$)/i,
  /(^|\/)\.cache(\/|$)/i,
  /(^|\/)\.worktrees(\/|$)/i,
  // env files: dotfile-prefixed form (.env, .envrc, .env-local, .env.vault,
  // .env.keys, ...) and name-suffixed form (prod.env, dev.env, staging.env).
  // Residual, deliberate: the prefixed form also denies `.envoy.yaml` and
  // `.environment` (any dotfile starting with the literal "env"), and the
  // suffixed form also denies `docs/setup.env` and `sample.env` (any
  // filename ending in ".env"). Same fail-closed trade as extDeny above --
  // .envoy.yaml is a real Envoy config file, not a secret.
  /(^|\/)\.env[^/]*$/i,
  /\.env$/i,
  /(^|\/)\.dev\.vars$/i,
  /(^|\/)\.secrets(\/|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.terraformrc$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)($|\.)/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.docker\/config\.json$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)\.pgpass$/i,
  /(^|\/)\.htpasswd$/i,
  /(^|\/)kubeconfig$/i,
  /(^|\/)secrets\.json$/i,
  /(^|\/)credentials$/i,
  /(^|\/)keystore\.properties$/i,
  extDeny('pem'),
  extDeny('p12'),
  extDeny('pfx'),
  extDeny('key'),
  extDeny('jks'),
  extDeny('keystore'),
  extDeny('p8')
]

/**
 * Dirs never walked when collecting candidates -- a PERFORMANCE optimisation
 * only. Every entry here must also be denied by DENY_PATTERNS above (pinned
 * by a structural test that iterates this Set): if it weren't, a future
 * perf-motivated trim of SKIP_DIRS would silently reopen a copy path for
 * whatever secret material lives under it, e.g. `.worktrees` holding other
 * agents' branches with their own gitignored files.
 */
export const SKIP_DIRS = new Set([
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

/**
 * True when a repo-relative path may never be copied into the sandbox.
 * Normalizes backslash separators itself -- the guarantee must travel with
 * the export, not depend on callers pre-normalizing (today's only caller,
 * `selectCopyPaths`, already does via `walkProjectFiles`/its own replace, but
 * that upstream discipline is invisible from here and a second caller or a
 * refactor could silently drop it).
 */
export function isDeniedCopyPath(relPosix: string): boolean {
  const normalized = relPosix.replace(/\\/g, '/')
  return DENY_PATTERNS.some((re) => re.test(normalized))
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
