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
      reason: 'missing' | 'empty' | 'locked' | 'shell-declined' | 'cwd-declined' | 'lock-race' | 'unattended'
    }

/**
 * Excludes lock-race and unattended by hand, not derived from
 * workspaceRestoreOrThrow's own switch -- the two must be kept in sync
 * manually.
 * A third reason that starts throwing needs adding here too: forgetting fails
 * safe (the exhaustive switch below would then fail to compile) but is not
 * automatic.
 */
export type WorkspaceRestoreQuietReason = Exclude<
  Exclude<WorkspaceRestoreResult, { ok: true }>['reason'],
  'lock-race' | 'unattended'
>

/** The main-process sink's resolved (non-throwing) outcome. */
export type WorkspaceRestoreOutcome = { applied: true } | { applied: false; reason: WorkspaceRestoreQuietReason }

/**
 * 'missing', 'empty' and 'locked' are normal, nothing-moved outcomes and
 * resolve quietly. 'shell-declined' and 'cwd-declined' are the operator's own
 * deliberate choice at the approval dialog, so they resolve quietly too.
 * 'lock-race' throws: restoreFrom() already swapped the live sessions before
 * the lock reclaim failed, so announced and real state would otherwise diverge.
 * 'unattended' (card 64f8f629) throws too: a caller with nobody at the
 * desktop app to answer the shell-field/untrusted-cwd approval dialog never
 * got a chance to decide anything, unlike 'shell-declined'/'cwd-declined'
 * (an operator's own deliberate click) -- a quiet return here would read as
 * an ordinary no-op restore instead of the blocked approval it actually is.
 * The switch's never-typed default makes a future eighth reason a compile
 * error, not a silent fall-through.
 */
export function workspaceRestoreOrThrow(result: WorkspaceRestoreResult): WorkspaceRestoreOutcome {
  if (result.ok) return { applied: true }
  switch (result.reason) {
    case 'missing':
    case 'empty':
    case 'locked':
    case 'shell-declined':
    case 'cwd-declined':
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
): 'toast.nothingToRestore' | 'toast.alreadyOpen' | 'toast.workspaceMissing' | null {
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
    default: {
      const _exhaustive: never = reason
      void _exhaustive
      return null
    }
  }
}
