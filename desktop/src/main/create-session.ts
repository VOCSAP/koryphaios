// Shared create-session path (operator IPC + supervisor deck-control, PLAN
// C4/C5): resolves the optional worktree BEFORE the spawn so the session's cwd
// is the fresh worktree, and fires the configured init hook in the background.

import type { CreateSessionInput, SessionRuntime } from '@shared/types'
import type { SessionService } from './session-service'
import { createWorktree, runWorktreeInit } from './worktree-service'

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
   * The APPROVED worktree-init hook (B5). This is resolved once at startup
   * through the C19 gate (a project-sourced hook only lands after the operator
   * approves it), so it is passed in rather than re-read from the project config
   * here — a repo-shipped worktreeInit can no longer reach the shell ungated.
   */
  worktreeInit?: string,
  /**
   * Sandbox readiness gate (PLAN-SANDBOX SBX3): when the sandbox is enabled it
   * ensures the container is up AND authenticated BEFORE any tile spawns, and
   * throws 'sandbox-auth-required' otherwise — the renderer maps that to the
   * login modal. One gate here covers the operator create, the supervisor's
   * deck-control spawn and template batches (all funnel through this path).
   */
  sandboxGate?: () => Promise<void>
): Promise<SessionRuntime> {
  if (sandboxGate && !input.supervisor) await sandboxGate()
  const req = { ...input }
  const branch = req.worktreeBranch?.trim()
  if (branch) {
    const wt = await createWorktree(projectDir, branch)
    if (worktreeInit) runWorktreeInit(wt.path, worktreeInit)
    req.cwd = wt.path
    req.worktree = { path: wt.path, branch: wt.branch ?? branch }
  } else if (beforeSpawn) {
    await beforeSpawn(req.cwd?.trim() || projectDir)
  }
  return service.create(req)
}
