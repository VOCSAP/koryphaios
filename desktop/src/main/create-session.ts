// Shared create-session path (operator IPC + supervisor deck-control, PLAN
// C4/C5): resolves the optional worktree BEFORE the spawn so the session's cwd
// is the fresh worktree, and fires the configured init hook in the background.

import { resolve, sep } from 'node:path'
import type { CreateSessionInput, SessionRuntime } from '@shared/types'
import type { SessionService } from './session-service'
import { createWorktree, runWorktreeInit } from './worktree-service'

/** True when `target` is `root` or lives inside it (path-boundary aware). */
function isInside(target: string, root: string): boolean {
  const t = resolve(target)
  const r = resolve(root)
  return t === r || t.startsWith(r + sep)
}

export async function createSessionWithWorktree(
  service: SessionService,
  projectDir: string,
  input: CreateSessionInput,
  /**
   * Pre-spawn hook (PLAN C16): called with the session's final cwd for
   * sessions landing in an EXISTING tree (a fresh worktree is clean by
   * construction, so it is skipped). index.ts injects the git checkpoint.
   */
  beforeSpawn?: (cwd: string) => Promise<void>,
  /**
   * The approved worktree-init hook.
   * Resolved once at startup through the operator-approval gate, then passed in
   * rather than re-read from the project config here, so a repo-shipped
   * worktreeInit cannot reach the shell without that approval.
   */
  worktreeInit?: string,
  /**
   * Sandbox readiness gate (PLAN-SANDBOX SBX3/M3): when the sandbox is enabled
   * it ensures the container is up AND authenticated BEFORE any tile spawns,
   * throwing 'sandbox-auth-required' otherwise (the renderer maps that to the
   * login modal). It returns the EFFECTIVE PROJECT ROOT — the project dir in
   * mount mode, the ephemeral clone in copy mode — so worktrees and the tile
   * cwd land inside the tree that is actually mounted at /work. One gate here
   * covers the operator create, the supervisor's deck-control spawn and
   * template batches (all funnel through this path).
   */
  sandboxGate?: () => Promise<string | null>,
  /**
   * Warm the sandbox's container-side transcript cache for the cwd this session
   * will actually run in (PLAN-SANDBOX M2 resume). It must happen AFTER the
   * worktree is created — a worktree session's cwd is not the project root, and
   * warming only the root left every worktree resume starting fresh.
   */
  sandboxWarmTranscripts?: (cwd: string) => Promise<void>,
  /**
   * Card 3c322f10 (piece 2, operator route): threaded straight through to
   * SessionService.create()'s own `opts` -- see that parameter's doc for why
   * it is a plain function argument here too, never a property merged into
   * `input`/`req` below. Only ipc.ts's `sessions:create` handler ever
   * supplies it; every other caller of this function (deck-control's
   * spawnSession, diff:review, roadmap:import-plan, template:apply,
   * spawnTemplateEntry) omits it, which is what keeps them fail-closed by
   * construction.
   */
  opts?: { teamLeadDeckBridge?: boolean }
): Promise<SessionRuntime> {
  let root = projectDir
  if (sandboxGate && !input.supervisor) {
    root = (await sandboxGate()) || projectDir
  }
  const req = { ...input }
  const branch = req.worktreeBranch?.trim()
  if (branch) {
    const wt = await createWorktree(root, branch)
    if (worktreeInit) runWorktreeInit(wt.path, worktreeInit)
    req.cwd = wt.path
    req.worktree = { path: wt.path, branch: wt.branch ?? branch }
  } else {
    const requested = req.cwd?.trim()
    // Copy mode ONLY (root !== projectDir): a cwd chosen against the REAL tree
    // (e.g. "open a session here" on a worktree row) is outside the mounted
    // clone, so the container could not see it — fall back to the effective
    // root rather than spawning a session whose cwd is missing on the other
    // side. In mount mode an out-of-tree cwd stays legitimate and untouched.
    // An empty cwd would default to cfg.projectDir inside SessionService —
    // the REAL tree — so copy mode must pin it explicitly here.
    if (root !== projectDir && (!requested || !isInside(requested, root))) {
      req.cwd = root
    }
    if (beforeSpawn) await beforeSpawn(req.cwd?.trim() || root)
  }
  if (sandboxWarmTranscripts) await sandboxWarmTranscripts(req.cwd?.trim() || root)
  return service.create(req, opts)
}
