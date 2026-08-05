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
import { reportError } from './log'

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
 * Expand one operator-entered glob into the RegExp set a path is tested
 * against: normalize (trim + backslash-to-slash, so a Windows-typed `**\*`
 * means the same as `**\/*`), then a pattern with no separator also matches
 * at any depth (`PLAN-*.md` catches `docs/PLAN-x.md` — the intuitive reading
 * of a bare filename pattern). Single source of truth for `selectCopyPaths`
 * below: `isUnboundedGlob` (shared/types.ts) duplicates this exact
 * normalize+expand so it classifies a glob the same way this function
 * actually matches it — audit 94f8cc0c found the two had drifted (validation
 * compared a raw string, matching normalized-then-expanded it first), which
 * let `*.*`, `**\/**`, `?*`, `**\/*.*` and `**\*` slip past as "not unbounded"
 * while resolving to a whole-tree match here. Keep both copies in lock-step.
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
 * True when a `path/x` probe still matches whatever denied the bare
 * `segment`, i.e. the pattern that fired is SUBTREE-shaped
 * (`(^|\/)node_modules(\/|$)` and its siblings): its own anchors already
 * treat "followed by / or end" as equivalent, so an isolated segment and
 * that same segment embedded mid-path agree on the verdict. The other
 * DENY_PATTERNS entries -- every `extDeny`, and the `id_rsa`-style
 * end-anchors -- do NOT deny a directory merely named like their target
 * (extDeny's own doc comment: excluding `/` from the decoration class is
 * exactly what keeps `foo.key/bar.txt` copyable), so for those the probe
 * fails and this returns false. Empirical rather than a hand-classified
 * list of "which DENY_PATTERNS entries are subtree-shaped": exactly the
 * kind of second copy that drifts from the source of truth, the failure
 * mode `expandCopyGlob`'s doc comment warns about (card 94f8cc0c).
 */
function isSubtreeDenyMatch(segment: string): boolean {
  return isDeniedCopyPath(segment) && isDeniedCopyPath(`${segment}/x`)
}

/**
 * True when SOME literal (wildcard-free) path segment of `glob` already
 * falls inside the deny-list, so every real match the glob could ever
 * produce is refused no matter where the wildcards around it sit --
 * `node_modules/**`, `**\/node_modules/**` and `*\/node_modules/**` all say
 * the same thing and must all classify the same way. An earlier version only
 * checked the literal PREFIX (text before the first wildcard), which
 * silently missed the last two: a leading `**`/`*` ("at any depth") is a
 * common, natural way to write this glob, and it makes the prefix the empty
 * string.
 *
 * A non-last segment is only tested via `isSubtreeDenyMatch` (see above) --
 * NOT the full pattern set -- because a mid-path segment always denotes a
 * DIRECTORY component, and only subtree-shaped patterns are entitled to deny
 * a directory's contents. Skipping that distinction was a real bug caught in
 * review: testing `report.key` (a segment, not a full path) against the raw
 * pattern set matches via `extDeny('key')`, but `report.key/notes.md` as an
 * actual candidate path does not -- extDeny deliberately excludes `/` from
 * its decoration, so `report.key/**` must NOT be denied. The glob's own LAST
 * segment, when itself literal, additionally gets the full pattern set: it
 * is the one position where "this text" and "the file a real match would
 * land on" coincide, so `docs/id_rsa` (no trailing wildcard) is correctly
 * denied by the `id_rsa` end-anchor even though that pattern is not
 * subtree-shaped.
 *
 * Exists because `walkProjectFiles`'s SKIP_DIRS prune never visits these
 * trees at all -- a real performance requirement, not a bug -- so a glob
 * that ONLY targets one of them produces zero raw matches with no walk ever
 * having looked. Without this check such a glob is indistinguishable from an
 * honest typo (`unmatched`), even though retyping the same text can never
 * fix it: only the deny-list itself, which the operator does not control,
 * could.
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
 * Collect repo-relative file paths of `root`, skipping heavy/forbidden dirs.
 * Best-effort: an unreadable subtree is skipped rather than failing the spawn.
 *
 * Truncation (either cap below stops the walk before the tree is fully
 * enumerated) used to be silent -- card 5ff9a432 -- so an operator whose
 * project exceeds either cap got a copy plan quietly missing files with no
 * signal anywhere. `truncated` is set at the exact break that fires because
 * of a cap (never inferred from the stack being non-empty afterward: the
 * stack can legitimately be empty even though the CURRENT directory's
 * remaining sibling names were cut off mid-batch by the visits cap), and
 * reportError fires at most once per call, after the loop, with the file
 * count actually returned.
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
