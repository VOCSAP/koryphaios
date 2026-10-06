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

export interface CreateSessionDeps {
  /**
   * Sandbox readiness gate: when the sandbox is enabled it ensures the
   * container is up AND authenticated before the tile spawns, throwing
   * 'sandbox-auth-required' otherwise (the renderer maps that to the login
   * modal). Returns the EFFECTIVE PROJECT ROOT (the project dir in mount mode,
   * the ephemeral clone in copy mode) so worktrees and the tile cwd land inside
   * the tree actually mounted at /work; null when the sandbox is off.
   * Required so that a spawn site cannot forget it; the supervisor is exempted
   * by `input.supervisor`, never by omission.
   */
  sandboxGate: () => Promise<string | null>
  /**
   * Warm the container-side transcript cache for the cwd this session will
   * actually run in. Runs AFTER the worktree is created: a worktree session's
   * cwd is not the project root, and warming only the root would start every
   * worktree resume fresh.
   */
  warmSandboxTranscripts: (cwd: string) => Promise<void>
  /**
   * Called with the session's final cwd for sessions landing in an EXISTING
   * tree (a fresh worktree is clean by construction, so it is skipped).
   */
  beforeSpawn?: (cwd: string) => Promise<void>
  /**
   * The approved worktree-init hook, resolved once through the
   * operator-approval gate and passed in rather than re-read from the project
   * config here, so a repo-shipped worktreeInit cannot reach the shell without
   * that approval.
   */
  worktreeInit?: string
  /**
   * Copy mode, requested cwd outside the clone: 'remap' (default) moves the
   * session to the clone root; 'refuse' throws, for a caller whose purpose is
   * that exact dir and would otherwise silently work on another tree.
   */
  cwdOutsideRoot?: 'remap' | 'refuse'
}

type SandboxSpawnDeps = Pick<CreateSessionDeps, 'sandboxGate' | 'warmSandboxTranscripts'>

/** Gate, then warm each cwd, for spawn paths that respawn stored defs (restore, restart). */
export async function gateSandboxForCwds(cwds: Iterable<string>, deps: SandboxSpawnDeps): Promise<void> {
  await deps.sandboxGate()
  for (const cwd of cwds) await deps.warmSandboxTranscripts(cwd)
}

/** service.restart behind the sandbox gate; the supervisor runs on the host and is exempt. */
export async function restartSessionGated(
  service: SessionService,
  id: string,
  deps: SandboxSpawnDeps
): Promise<SessionRuntime> {
  const session = service.list().find((s) => s.id === id)
  if (session && !session.supervisor) await gateSandboxForCwds([session.cwd], deps)
  return service.restart(id)
}

export async function createSessionWithWorktree(
  service: SessionService,
  projectDir: string,
  input: CreateSessionInput,
  deps: CreateSessionDeps,
  /** Runtime-only bridge options; `hasDeckLeadTools` is set only by deck-control after a successful `leadMint`. */
  opts?: { teamLeadDeckBridge?: boolean; hasDeckLeadTools?: boolean }
): Promise<SessionRuntime> {
  const { sandboxGate, warmSandboxTranscripts, beforeSpawn, worktreeInit } = deps
  let root = projectDir
  if (!input.supervisor) {
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
      if (requested && deps.cwdOutsideRoot === 'refuse') {
        throw new Error(`${requested} is outside the sandbox copy (${root}): refusing to relocate the session`)
      }
      req.cwd = root
    }
    if (beforeSpawn) await beforeSpawn(req.cwd?.trim() || root)
  }
  if (!input.supervisor) await warmSandboxTranscripts(req.cwd?.trim() || root)
  return service.create(req, opts)
}
