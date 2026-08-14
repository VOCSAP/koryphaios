// Sandbox mode (card 6e3863ef): mount-mode sub-policy that closes the
// git-hooks/config-file evasion class. In `mount` mode the operator's real
// tree is bind-mounted read-write at /work — code we assume COMPROMISE
// (CLAUDE.md "hostile inputs") can then write /work/.git/hooks/pre-commit,
// /work/.mcp.json or /work/.claude/settings.json, which the HOST later
// executes or trusts when the operator next opens/commits the project. This
// module computes which paths get a nested `:ro` bind on top of the rw mount
// to close that; `buildCreateArgs` (sandbox-command.ts) stays pure/synchronous
// and only renders the plan this module produces into `-v` args.
//
// CRITERION (A5): any project path whose CONTENT is EXECUTED or INTERPRETED
// AS A COMMAND by the HOST when the host opens or manipulates this project.
// The list below (PROTECTED_PATHS) is a DATED INSTANCE of that criterion,
// not the rule itself — a future path that becomes host-executed belongs
// there under the same test, appended with its kind.
//
// Node builtins only (no electron) so this stays bun-testable. This is the
// ONLY file in the sandbox-command family that touches disk (statSync /
// existsSync) — buildCreateArgs itself must stay pure.

import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { SANDBOX_WORK_DIR } from './sandbox-command'
import type { SandboxWorkMode } from './sandbox-store'

export type ProtectedKind = 'dir' | 'file'

export interface ProtectedBind {
  /** POSIX-relative path from the project root, e.g. '.git/hooks'. */
  rel: string
  kind: ProtectedKind
  hostPath: string
  containerPath: string
}

export interface SkippedBind {
  rel: string
  kind: ProtectedKind
  reason: 'file-absent' | 'git-not-a-directory'
}

/**
 * `not-applicable` (A10) is a DISTINCT state from "applied with zero binds":
 * in copy mode workSource is an ephemeral clone, so a write there reaches no
 * host-executed path — the sub-policy has no meaning, not an empty result.
 */
export type ProtectionPlan =
  | { status: 'not-applicable'; reason: 'copy-mode'; applied: readonly []; skipped: readonly [] }
  | { status: 'applied'; applied: readonly ProtectedBind[]; skipped: readonly SkippedBind[] }

/**
 * ONE list, `kind` a MANDATORY field on every entry — not two arrays sorted
 * by kind. Two arrays let an entry's dir/file classification be wrong by
 * construction (moving `.claude/settings.json` between them makes NO test
 * fail: nothing forces the array it lives in to agree with its actual
 * on-disk shape). TypeScript alone does not close this — `{ rel: string;
 * kind: ProtectedKind }` accepts any (rel, kind) pair, so a `kind:'dir'`
 * entry for a path that is actually a file is still perfectly type-valid.
 * What this restructuring buys is narrower and real: `kind` is now LOCAL
 * and VISIBLE at the exact point an entry is added (no second array to
 * remember to pick correctly), and the coverage test below builds its
 * fixture FROM this list, creating a directory for `kind:'dir'` and a file
 * for `kind:'file'` — so a wrong `kind` on any entry now fails that test
 * (proved by reclassifying '.claude/settings.json' as 'dir' and reverting).
 *
 * - `dir` gets an UNCONDITIONAL bind. Docker recursively creates any missing
 *   host-side path components on a directory bind (owned by the operator,
 *   mode 755 — measured 2026-08-13/14), so conditioning this on existsSync
 *   would fail OPEN the day one of these directories is created for the
 *   first time by the operator's own tooling after the sandbox already
 *   exists.
 * - `file` is bound only when it already exists as a FILE. Docker's bind on
 *   a missing file target fabricates a DIRECTORY of that name host-side
 *   (measured) — an unconditional file bind would be corruption, not
 *   protection.
 */
export const PROTECTED_PATHS: readonly { rel: string; kind: ProtectedKind }[] = [
  { rel: '.git/hooks', kind: 'dir' },
  { rel: '.claude/agents', kind: 'dir' },
  { rel: '.claude/commands', kind: 'dir' },
  { rel: '.vscode', kind: 'dir' },
  { rel: '.idea', kind: 'dir' },
  { rel: '.mcp.json', kind: 'file' },
  { rel: '.claude/settings.json', kind: 'file' },
  { rel: '.git/config', kind: 'file' },
  // git INTERPRETS a submodule's recorded URL as a fetch/clone transport on
  // `git submodule update`/`clone --recursive` — the second half of the A5
  // criterion ("interpreted as a command by the host"), even though the
  // file itself is never executed the way a hook is. Was in A5's original
  // file list but had not made it into this implementation (gap found by
  // review, not by this list's own coverage test — see A5 comment above).
  { rel: '.gitmodules', kind: 'file' }
]

/**
 * True for '.git' itself and anything nested under it. Written on this
 * STRUCTURAL test — not `rel === '.git/hooks' || rel === '.git/config'` —
 * because an enumerated form is the SAME fault A6 forbids one level down: it
 * guards on WHICH paths, not on the FORM of .git, so a future entry added
 * under .git/ (e.g. '.git/info/exclude') would silently escape the guard
 * and `docker create` would fail on a worktree/submodule instead of
 * degrading — the exact outage the guard exists to prevent.
 */
export function isGitInternalRel(rel: string): boolean {
  return rel === '.git' || rel.startsWith('.git/')
}

function toBind(workSource: string, rel: string, kind: ProtectedKind): ProtectedBind {
  return {
    rel,
    kind,
    hostPath: join(workSource, ...rel.split('/')),
    containerPath: `${SANDBOX_WORK_DIR}/${rel}`
  }
}

/**
 * Compute the mount-mode protection plan for `workSource`. `mode` decides
 * applicability FAIL-CLOSED (A7): only an explicit 'copy' opts out, so a
 * future third mode value applies the sub-policy rather than silently
 * skipping it.
 */
export function planProtectedBinds(args: {
  workSource: string
  mode: SandboxWorkMode
}): ProtectionPlan {
  // FAIL-CLOSED, checked first, before mode even matters: an empty or
  // relative workSource is a CALLER BUG, not a valid "nothing to protect"
  // input. `join('', '.mcp.json')` silently resolves to '.mcp.json', and
  // existsSync/statSync then resolve THAT relative to the PROCESS cwd — a
  // plan built from the wrong tree entirely, but shaped exactly like a
  // legitimate one (measured: applied count changes but the plan still
  // looks plausible). Refuse loudly instead of returning a plan that lies
  // about which tree it describes.
  if (!args.workSource || !isAbsolute(args.workSource)) {
    throw new Error(
      `planProtectedBinds: workSource must be a non-empty absolute path, got ${JSON.stringify(args.workSource)}`
    )
  }
  if (args.mode === 'copy') {
    return { status: 'not-applicable', reason: 'copy-mode', applied: [], skipped: [] }
  }
  const { workSource } = args

  // Garde sur la FORME (A6): statSync(...).isDirectory(), jamais sur
  // l'intention "worktree" — un submodule produit la meme forme (.git
  // FICHIER) et une garde ecrite sur l'intention couvrirait strictement
  // moins que le domaine reel.
  const gitPath = join(workSource, '.git')
  const gitIsDir = existsSync(gitPath) && statSync(gitPath).isDirectory()

  const applied: ProtectedBind[] = []
  const skipped: SkippedBind[] = []

  for (const { rel, kind } of PROTECTED_PATHS) {
    if (isGitInternalRel(rel) && !gitIsDir) {
      skipped.push({ rel, kind, reason: 'git-not-a-directory' })
      continue
    }
    if (kind === 'dir') {
      applied.push(toBind(workSource, rel, kind))
      continue
    }
    const hostPath = join(workSource, ...rel.split('/'))
    if (existsSync(hostPath) && statSync(hostPath).isFile()) {
      applied.push(toBind(workSource, rel, kind))
    } else {
      skipped.push({ rel, kind, reason: 'file-absent' })
    }
  }

  return { status: 'applied', applied, skipped }
}

/**
 * Renders `plan` into the short English notice an agent sees when it hits
 * EPERM on a protected path, so it recognizes a POLICY and does not try to
 * work around it. Pure, no disk access, no i18n — this text goes to a CLI
 * agent, not the operator (unlike everything under i18n.ts).
 *
 * SECURITY (A2, non-negotiable): this function enumerates ONLY
 * `plan.applied`. It must NEVER mention `plan.skipped` — neither the paths
 * nor even their count. Our doctrine assumes the agent is COMPROMISED: the
 * list of what is NOT protected is worthless for its legitimate work and
 * highly useful to an attacker mapping the remaining write surface. If you
 * are tempted to add skipped "for completeness", don't — that is exactly
 * the leak this comment exists to block.
 */
export function renderProtectionNotice(plan: ProtectionPlan): string {
  if (plan.status !== 'applied' || plan.applied.length === 0) return ''
  const paths = plan.applied.map((b) => `  - ${b.containerPath}`).join('\n')
  const lines = [
    'The following paths are mounted read-only and cannot be modified:',
    paths,
    'Reason: the host executes or interprets these when it opens or manipulates this project (git hooks, MCP/editor config). This is a policy, not a malfunction — do not attempt to work around it.'
  ]
  // Derived from the plan (A9), not hardcoded independently of it: only
  // said when .git/config is ACTUALLY in plan.applied (absent on a
  // worktree/submodule .git, where it is skipped instead). Named because a
  // daily operation hits it -- `git push -u origin <branch>` (first push of
  // a new branch) writes .git/config, so an agent taking EPERM there needs
  // the concrete consequence spelled out, not just a path list, or it will
  // read the generic reason above and still go looking for a workaround.
  if (plan.applied.some((b) => b.rel === '.git/config')) {
    lines.push(
      "In particular, 'git push -u origin <branch>' and 'git remote add' will fail read-only. Ask the operator to configure the remote instead."
    )
  }
  return lines.join('\n')
}
