// Shared create-session path (operator IPC + supervisor deck-control, PLAN
// C4/C5): resolves the optional worktree BEFORE the spawn so the session's cwd
// is the fresh worktree, and fires the configured init hook in the background.

import type { CreateSessionInput, SessionRuntime } from '@shared/types'
import type { SessionService } from './session-service'
import { resolveLaunchConfig } from './launch-config'
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
  beforeSpawn?: (cwd: string) => Promise<void>
): Promise<SessionRuntime> {
  const req = { ...input }
  const branch = req.worktreeBranch?.trim()
  if (branch) {
    const wt = await createWorktree(projectDir, branch)
    const init = resolveLaunchConfig(projectDir).worktreeInit
    if (init) runWorktreeInit(wt.path, init)
    req.cwd = wt.path
    req.worktree = { path: wt.path, branch: wt.branch ?? branch }
  } else if (beforeSpawn) {
    await beforeSpawn(req.cwd?.trim() || projectDir)
  }
  return service.create(req)
}
