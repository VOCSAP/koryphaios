/**
 * Discriminated result of WorkspaceService.restore(). One reason literal per
 * real cause (each of restore()'s own `return` sites) -- never pre-merged,
 * so the CONSUMER decides behaviour per reason via an exhaustive switch,
 * same principle as TemplateResolveResult.
 */
export type WorkspaceRestoreResult =
  | { ok: true }
  | {
      ok: false
      reason: 'missing' | 'empty' | 'locked' | 'shell-declined' | 'cwd-declined' | 'lock-race' | 'unattended' | 'busy' | 'superseded'
    }

export type WorkspaceRestoreQuietReason = Exclude<
  Exclude<WorkspaceRestoreResult, { ok: true }>['reason'],
  'lock-race' | 'unattended'
>

/** The main-process sink's resolved (non-throwing) outcome. */
export type WorkspaceRestoreOutcome = { applied: true } | { applied: false; reason: WorkspaceRestoreQuietReason }

export function workspaceRestoreOrThrow(result: WorkspaceRestoreResult): WorkspaceRestoreOutcome {
  if (result.ok) return { applied: true }
  switch (result.reason) {
    case 'missing':
    case 'empty':
    case 'locked':
    case 'shell-declined':
    case 'cwd-declined':
    case 'busy':
    case 'superseded':
      return { applied: false, reason: result.reason }
    case 'lock-race':
      throw new Error(
        'workspace restore failed partway through: your sessions were already swapped, but the lock could not be reclaimed -- check the current state in the workspace picker'
      )
    case 'unattended':
      throw new Error(
        'workspace runs custom shell commands or opens a folder outside the project and needs an operator at the desktop app to approve it -- open the desktop window and retry'
      )
    default: {
      const _exhaustive: never = result.reason
      throw new Error(`unknown workspace restore failure: ${String(_exhaustive)}`)
    }
  }
}

/**
 * 'missing' gets its own dedicated toast rather than reusing alreadyOpen:
 * "already open" implies a live conflict, which is false for a vanished file.
 * 'shell-declined'/'cwd-declined' show nothing -- the operator already made
 * this choice at the dialog, and showing the wrong toast is worse than showing
 * none.
 */
export function workspaceRestoreToastKeyFor(
  reason: WorkspaceRestoreQuietReason
): 'toast.nothingToRestore' | 'toast.alreadyOpen' | 'toast.workspaceMissing' | 'toast.workspaceRestoreBusy' | 'toast.workspaceRestoreSuperseded' | null {
  switch (reason) {
    case 'empty':
      return 'toast.nothingToRestore'
    case 'locked':
      return 'toast.alreadyOpen'
    case 'missing':
      return 'toast.workspaceMissing'
    case 'shell-declined':
    case 'cwd-declined':
      return null
    case 'busy':
      return 'toast.workspaceRestoreBusy'
    case 'superseded':
      return 'toast.workspaceRestoreSuperseded'
    default: {
      const _exhaustive: never = reason
      void _exhaustive
      return null
    }
  }
}
