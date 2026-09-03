// Clones the project host-side into a throwaway dir with git clone --local
// (near-instant, shares the object store) and mounts that, so agents never
// touch the real tree while git/diff/explorer views keep working on a real
// repo.
// An operator allow-list of globs copies gitignored files still needed to work;
// a hard deny-list of secrets and dependency dirs always wins over it.

import { lstatSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { reportError } from './log'

/**
 * A dot-extension matches at the true end of a path segment or when followed by
 * same-segment decoration (server.pem.bak, key.pem~), but never across a / — so
 * a directory merely named like a key file (foo.key/bar.txt) is not denied
 * wholesale.
 * Requiring the next character to be non-alphanumeric keeps .pem from matching
 * .pemx while still matching every decorated form.
 */
function extDeny(ext: string): RegExp {
  return new RegExp(`\\.${ext}(?:[^a-zA-Z0-9/][^/]*)?$`, 'i')
}

/**
 * Never copied, whatever the operator configured. `.git` would corrupt the
 * clone; node_modules/.venv/dist/out/build/.next/.cache/.worktrees/
 * target/vendor/Pods/.gradle are re-installable or throwaway bulk (also the
 * SKIP_DIRS traversal prune below -- that prune is a perf optimisation ONLY,
 * this list is the real gate, so it must cover every SKIP_DIRS entry); the
 * rest is secret material an agent with network egress must not be handed.
 * All case-insensitive: Windows and macOS filesystems are case-insensitive,
 * and a bare `re.test` would miss `.ENV` / `ID_RSA` / `server.PEM` on either.
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
  // Card 5ff9a432: Rust/Maven build output, PHP/Go vendored deps, CocoaPods
  // and Gradle's project-local cache -- same PERFORMANCE-bulk reason as the
  // node_modules/dist/build group above (large, re-installable/regenerable
  // trees), not a distinct secret shape. Added here because SKIP_DIRS below
  // must not gain an entry without deny coverage, defense-in-depth for
  // whatever reaches isDeniedCopyPath outside the walk (e.g. a future direct
  // glob check on an unwalked path).
  /(^|\/)target(\/|$)/i,
  /(^|\/)vendor(\/|$)/i,
  /(^|\/)Pods(\/|$)/i,
  /(^|\/)\.gradle(\/|$)/i,
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
  '.worktrees',
  // Card 5ff9a432: PERFORMANCE prune like the group above (large,
  // re-installable/regenerable trees) -- Rust/Maven build output, PHP/Go
  // vendored deps, CocoaPods, Gradle's project-local cache. None hold a
  // secret shape distinct from what DENY_PATTERNS already covers generally;
  // still deny-listed above per this comment's own rule.
  'target',
  'vendor',
  'Pods',
  '.gradle'
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
 * Normalizes a glob (trim, backslashes to slashes), then when it has no
 * separator also matches at any depth — PLAN-*.md catches docs/PLAN-x.md, the
 * intuitive reading of a bare filename pattern.
 * shared/types.ts's isUnboundedGlob must classify a glob the same way this
 * matches it; the two drifted once (card 94f8cc0c) and let unbounded globs pass
 * as bounded.
 */
function expandCopyGlob(glob: string): RegExp[] {
  const g = glob.trim().replace(/\\/g, '/')
  if (!g) return []
  return (g.includes('/') ? [g] : [g, `**/${g}`]).map(globToRegExp)
}

/**
 * The repo-relative paths to copy: allow-listed by the operator's globs, then
 * filtered by the deny-list (which always wins).
 */
export function selectCopyPaths(relPaths: string[], globs: string[]): string[] {
  const patterns = globs.flatMap(expandCopyGlob)
  if (patterns.length === 0) return []
  return relPaths
    .map((p) => p.replace(/\\/g, '/'))
    .filter((p) => !isDeniedCopyPath(p) && patterns.some((re) => re.test(p)))
    .sort()
}

/**
 * Same matching as `selectCopyPaths`, WITHOUT the deny filter. Used only to
 * tell "this glob matched zero real files" (a typo) apart from "this glob
 * matched real files that the deny-list then removed" (a refusal) --
 * `selectCopyPaths`'s output alone collapses both to nothing, which is
 * exactly the ambiguity `planIgnoredCopy` below exists to remove.
 */
function selectRawMatches(relPaths: string[], globs: string[]): string[] {
  const patterns = globs.flatMap(expandCopyGlob)
  if (patterns.length === 0) return []
  return relPaths.map((p) => p.replace(/\\/g, '/')).filter((p) => patterns.some((re) => re.test(p)))
}

/**
 * True only when the pattern that denied a bare segment is subtree-shaped (its
 * own anchors already treat 'followed by / or end' as equivalent) — an
 * extension or exact-name deny does not deny a directory merely named like its
 * target.
 */
function isSubtreeDenyMatch(segment: string): boolean {
  return isDeniedCopyPath(segment) && isDeniedCopyPath(`${segment}/x`)
}

/**
 * True when some literal segment of `glob` already falls inside the
 * deny-list, so every real match is refused wherever the wildcards sit:
 * `node_modules/**`, `**\/node_modules/**` and `*\/node_modules/**` classify
 * the same way (a literal-prefix check misses the last two). A non-last
 * segment is a directory component, tested with isSubtreeDenyMatch only
 * (extDeny excludes `/`, so `report.key/**` is not denied); a literal last
 * segment gets the full pattern set (`docs/id_rsa` hits the `id_rsa`
 * end-anchor). Needed because walkProjectFiles prunes SKIP_DIRS: a glob
 * targeting only such a tree yields zero matches and would read as a typo.
 */
function globIsDenied(glob: string): boolean {
  const g = glob.trim().replace(/\\/g, '/')
  const segments = g.split('/').filter((s) => s.length > 0)
  return segments.some((segment, i) => {
    if (/[*?]/.test(segment)) return false
    return i === segments.length - 1 ? isDeniedCopyPath(segment) : isSubtreeDenyMatch(segment)
  })
}

/** Cap overrides for tests only -- production call sites take the defaults. */
export interface WalkLimits {
  maxEntries?: number
  maxVisits?: number
}

/**
 * Best-effort: an unreadable subtree is skipped rather than failing the spawn.
 * truncated is set at the exact break caused by a cap, never inferred from the
 * stack being empty afterward — the stack can legitimately empty out even when
 * sibling names were cut off mid-batch by the visits cap.
 */
export function walkProjectFiles(root: string, limits: WalkLimits = {}): string[] {
  const maxEntries = limits.maxEntries ?? MAX_WALK_ENTRIES
  const maxVisits = limits.maxVisits ?? MAX_WALK_VISITS
  const out: string[] = []
  const stack: string[] = [root]
  let visits = 0
  let truncated = false
  while (stack.length > 0) {
    if (out.length >= maxEntries || visits >= maxVisits) {
      truncated = true
      break
    }
    const dir = stack.pop()!
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue // unreadable dir: nothing to copy from it
    }
    for (const name of names) {
      if (SKIP_DIRS.has(name)) continue
      // Checked BEFORE consuming this name (not after pushing it) so that
      // exhausting the last name in the last pending directory exactly as a
      // cap is reached is never misreported as truncation -- there is
      // nothing left to visit either way, but only this ordering tells the
      // two cases apart.
      if (out.length >= maxEntries || visits >= maxVisits) {
        truncated = true
        break
      }
      visits++
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
      }
    }
  }
  if (truncated) {
    reportError('sandbox', `copy plan truncated at ${out.length} file(s)`)
  }
  return out
}

/** Everything the copy mode needs to know about one project's clone. */
export interface CopyPlan {
  /** Repo-relative paths to duplicate on top of the clone. */
  files: string[]
  /**
   * Patterns that matched no real file at all. Usually a typo, but the
   * same bucket also catches a walk truncation (MAX_WALK_ENTRIES /
   * MAX_WALK_VISITS, card 5ff9a432), an unfollowed symlink, or an
   * unreadable directory -- none of those are fixable by retyping the
   * glob either, but they are not surfaced separately here.
   */
  unmatched: string[]
  /**
   * What an allow-listed glob would have copied but the deny-list blocked
   * (secrets/bulk dirs) -- distinct from `unmatched`: this is not a typo,
   * it is a refusal, and correcting the glob's spelling can never fix it.
   * Usually repo-relative file paths; for a glob whose entire target is a
   * walk-skipped bulk dir (`node_modules/**`) no individual file was ever
   * visited to name, so the glob's own text is listed instead.
   */
  denied: string[]
}

/**
 * Resolve the copy plan for a project + its configured globs. Each glob is
 * classified into exactly one of three buckets: it contributes to `files`
 * (allowed), `denied` (matched real files, or a walk-skipped bulk dir, that
 * the deny-list refuses), or `unmatched` (no real file backs it -- typically
 * a typo, but also possibly a walk truncation, an unfollowed symlink, or an
 * unreadable directory; see `CopyPlan.unmatched`). A glob that matches some
 * allowed files AND some denied ones contributes to both `files` and
 * `denied`, never to `unmatched`.
 */
export function planIgnoredCopy(projectDir: string, globs: string[]): CopyPlan {
  const all = walkProjectFiles(projectDir)
  const files = selectCopyPaths(all, globs)
  const denied = new Set<string>()
  const unmatched: string[] = []
  for (const g of globs.map((g) => g.trim()).filter(Boolean)) {
    const raw = selectRawMatches(all, [g])
    if (raw.length > 0) {
      for (const p of raw) if (isDeniedCopyPath(p)) denied.add(p)
      continue
    }
    if (globIsDenied(g)) {
      denied.add(g)
    } else {
      unmatched.push(g)
    }
  }
  return { files, unmatched, denied: [...denied].sort() }
}
