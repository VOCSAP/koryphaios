// Shared create-session path (operator IPC + supervisor deck-control, PLAN
// C4/C5): resolves the optional worktree BEFORE the spawn so the session's cwd
// is the fresh worktree, and fires the configured init hook in the background.

import { randomUUID } from 'node:crypto'
import { resolve, sep } from 'node:path'
import type { CreateSessionInput, SessionRuntime } from '@shared/types'
import type { SessionService } from './session-service'
import { createWorktree, runWorktreeInit } from './worktree-service'
import { type LaunchAttemptRegistry, type LaunchModPlan } from './mod-launch-plan'

/** True when `target` is `root` or lives inside it (path-boundary aware). */
function isInside(target: string, root: string): boolean {
  const t = resolve(target)
  const r = resolve(root)
  return t === r || t.startsWith(r + sep)
}

export interface ModLaunchDeps {
  attemptKey?: string
  registry: LaunchAttemptRegistry
  prepare(attempt: { attemptId: string; signal: AbortSignal }, input?: { supervisor: boolean }): Promise<LaunchModPlan>
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
  modLaunch?: ModLaunchDeps
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

type SandboxSpawnDeps = Pick<CreateSessionDeps, 'sandboxGate' | 'warmSandboxTranscripts' | 'modLaunch'>

/** Gate, then warm each cwd, for spawn paths that respawn stored defs (restore, restart). */
export async function gateSandboxForCwds(
  cwds: Iterable<string>,
  deps: SandboxSpawnDeps,
  assertCurrent?: () => void
): Promise<void> {
  await deps.sandboxGate()
  assertCurrent?.()
  for (const cwd of cwds) {
    await deps.warmSandboxTranscripts(cwd)
    assertCurrent?.()
  }
}

/** service.restart behind the sandbox gate; the supervisor runs on the host and is exempt. */
export async function restartSessionGated(
  service: SessionService,
  id: string,
  deps: SandboxSpawnDeps
): Promise<SessionRuntime> {
  const session = service.list().find((s) => s.id === id)
  const modLaunch = deps.modLaunch
  if (!modLaunch) {
    if (session && !session.supervisor) await gateSandboxForCwds([session.cwd], deps)
    return service.restart(id)
  }
  return modLaunch.registry.join(id, async () => {
    const attempt = modLaunch.registry.begin(id)
    const assertCurrent = (): void => {
      if (!modLaunch.registry.isCurrent(attempt.attemptId)) throw new Error('mod launch superseded')
    }
    try {
      if (session && !session.supervisor) await gateSandboxForCwds([session.cwd], deps, assertCurrent)
      const modPlan = await modLaunch.prepare(attempt, { supervisor: session?.supervisor === true })
      assertCurrent()
      return await service.restart(id, modPlan)
    } finally {
      modLaunch.registry.complete(id, attempt.attemptId)
    }
  })
}

/**
 * Who decides each field of a new session. sessions:create is an operator
 * channel (the paired companion is the operator on the move), so dropping the
 * main-side fields keeps a request from naming state only the main process
 * sets. That is hygiene, not a security boundary: free-form `args` still
 * reaches the claude command line. A field added to CreateSessionInput does
 * not compile until it is classified here.
 */
const SESSION_FIELD_ORIGIN = {
  name: 'request',
  cwd: 'request',
  command: 'request',
  bridge: 'request',
  agent: 'request',
  model: 'request',
  effort: 'request',
  role: 'request',
  args: 'request',
  prompt: 'request',
  worktreeBranch: 'request',
  // WorktreesView adopts an existing worktree by sending it.
  worktree: 'request',
  lead: 'request',
  color: 'request',
  announce: 'request',
  peerTools: 'main',
  supervisor: 'main',
  mcpConfig: 'main',
  strictMcpConfig: 'main',
  disallowedTools: 'main',
  appendSystemPromptFile: 'main'
} as const satisfies Record<keyof CreateSessionInput, 'request' | 'main'>

export type MainOnlySessionField = {
  [K in keyof typeof SESSION_FIELD_ORIGIN]: (typeof SESSION_FIELD_ORIGIN)[K] extends 'main' ? K : never
}[keyof typeof SESSION_FIELD_ORIGIN]

export const SESSION_FIELDS = Object.keys(SESSION_FIELD_ORIGIN) as Array<keyof CreateSessionInput>

const MAIN_ONLY_FIELDS = SESSION_FIELDS.filter((field) => SESSION_FIELD_ORIGIN[field] === 'main')

export function stripMainOnlySessionFields(
  input: CreateSessionInput | undefined
): Omit<CreateSessionInput, MainOnlySessionField> {
  const requested: CreateSessionInput = { ...input }
  for (const field of MAIN_ONLY_FIELDS) delete requested[field]
  return requested
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
  const modLaunch = deps.modLaunch
  const targetKey = modLaunch ? (modLaunch.attemptKey ?? `new:${randomUUID()}`) : ''
  const attempt = modLaunch?.registry.begin(targetKey)
  const assertCurrent = (): void => {
    if (attempt && !modLaunch!.registry.isCurrent(attempt.attemptId)) throw new Error('mod launch superseded')
  }
  try {
    let root = projectDir
    if (!input.supervisor) {
      root = (await sandboxGate()) || projectDir
      assertCurrent()
    }
    const req = { ...input }
    const branch = req.worktreeBranch?.trim()
    if (branch) {
      const wt = await createWorktree(root, branch)
      assertCurrent()
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
      if (beforeSpawn) {
        await beforeSpawn(req.cwd?.trim() || root)
        assertCurrent()
      }
    }
    if (!input.supervisor) {
      await warmSandboxTranscripts(req.cwd?.trim() || root)
      assertCurrent()
    }
    if (!modLaunch || !attempt) return service.create(req, opts)
    const modPlan = await modLaunch.prepare(attempt, { supervisor: input.supervisor === true })
    assertCurrent()
    return service.create(req, { ...opts, modPlan })
  } finally {
    if (attempt) modLaunch!.registry.complete(targetKey, attempt.attemptId)
  }
}
