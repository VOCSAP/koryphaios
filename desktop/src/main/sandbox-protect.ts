// In mount mode the operator's real tree is bind-mounted read-write; code
// assumed compromised could otherwise write .git/hooks/pre-commit, .mcp.json or
// .claude/settings.json for the host to later execute or trust.
// Computes which paths get a nested read-only bind on top of the rw mount to
// close that. Any project path whose content the host executes or interprets as
// a command when it opens or manipulates the project belongs on that list.

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
 * One list with kind as a mandatory per-entry field, not two arrays sorted by
 * kind: two arrays let an entry's dir/file classification be wrong by
 * construction, since nothing forces the array it lives in to match its actual
 * on-disk shape.
 * dir gets an unconditional bind — Docker creates missing host-side path
 * components for a directory bind. file is bound only when it already exists as
 * a file — Docker's bind on a missing file target fabricates a directory of
 * that name host-side.
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
 * Pure, no i18n — this text goes to a CLI agent, not the operator.
 * Must never mention plan.skipped, not even its count: the doctrine assumes the
 * agent is compromised, and the list of what is not protected is only useful to
 * an attacker mapping the remaining write surface.
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
