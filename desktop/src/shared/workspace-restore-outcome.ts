/**
 * Discriminated result of WorkspaceService.restore(). One reason literal per
 * real cause (each of restore()'s own `return` sites) -- never pre-merged,
 * so the CONSUMER decides behaviour per reason via an exhaustive switch,
 * same principle as TemplateResolveResult.
 */
export type WorkspaceCredentialCause = 'trust' | 'identity' | 'capability' | 'local-file' | 'mint-refused' | 'invalid-target'

export type WorkspaceCredentialFailure =
  | { state: 'credential-timed-out' }
  | { state: 'credential-unavailable'; cause: WorkspaceCredentialCause | 'busy' | 'closed' }

export function workspaceCredentialFailureJournalMessage(
  result: WorkspaceCredentialFailure,
  rescopeWaitMs: number
): string {
  switch (result.state) {
    case 'credential-timed-out':
      return `workspace credential timed out: delivery exceeded ${rescopeWaitMs / 1000}s`
    case 'credential-unavailable':
      switch (result.cause) {
        case 'trust': return 'workspace credential unavailable: operator trust not established or no longer current'
        case 'identity': return 'workspace credential unavailable: operator identity is unreadable or unavailable'
        case 'capability': return 'workspace credential unavailable: broker lacks Inbox credential capability'
        case 'local-file': return 'workspace credential unavailable: local Inbox credential file could not be installed'
        case 'mint-refused': return 'workspace credential unavailable: Inbox credential preparation or finalization did not complete'
        case 'busy': return 'workspace credential unavailable: another scope credential operation is already active'
        case 'closed': return 'workspace credential unavailable: scope was closed'
        case 'invalid-target': return 'workspace credential unavailable: missing group or project'
        default: {
          const _exhaustive: never = result.cause
          return _exhaustive
        }
      }
    default: {
      const _exhaustive: never = result
      return _exhaustive
    }
  }
}

export function credentialFailureReporter(
  report: (scope: string, message: string) => void,
  rescopeWaitMs: number
): (result: WorkspaceCredentialFailure) => void {
  return (result) => report('workspace-restore', workspaceCredentialFailureJournalMessage(result, rescopeWaitMs))
}

export type WorkspaceRestoreResult =
  | { ok: true }
  | {
      ok: false
      reason: 'missing' | 'empty' | 'locked' | 'shell-declined' | 'cwd-declined' | 'lock-race' | 'unattended' | 'busy' | 'superseded' | 'credential-timed-out'
    }
  | { ok: false; reason: 'credential-unavailable'; cause: WorkspaceCredentialCause }

export type WorkspaceRestoreQuietReason = Exclude<
  Exclude<WorkspaceRestoreResult, { ok: true }>['reason'],
  'lock-race' | 'unattended' | 'credential-timed-out' | 'credential-unavailable'
>

function credentialUnavailableMessage(cause: WorkspaceCredentialCause): string {
  const prefix = "Restauration annulée. Aucune session de cette restauration n'a été ouverte ; le scope est inchangé. "
  switch (cause) {
    case 'trust': return `${prefix}Le broker n'accepte pas l'identité opérateur configurée. Faites vérifier la relation de confiance avec le broker avant de relancer la restauration ; attendre davantage ne résout pas ce refus.`
    case 'identity': return `${prefix}L'identité opérateur du Deck est illisible ou indisponible. Vérifiez sa configuration et les droits d'accès indiqués dans le Journal avant de réessayer.`
    case 'capability': return `${prefix}Le broker ne fournit pas le credential Inbox requis. Utilisez un broker compatible avec la provenance Inbox avant de relancer la restauration.`
    case 'local-file': return `${prefix}Le credential Inbox ne peut pas être installé localement. Vérifiez les droits d'écriture et l'espace disponible indiqués dans le Journal avant de réessayer.`
    case 'mint-refused': return `${prefix}Le broker a refusé la création du credential Inbox. Consultez le motif dans le Journal et corrigez-le avant de relancer la restauration.`
    case 'invalid-target': return `${prefix}Le Deck n'a pas pu déterminer le groupe ou le projet de cette restauration. Consultez le Journal avant de réessayer.`
  }
}

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
      throw new Error('workspace restore could not acquire its lock before changing any session -- check the workspace picker and retry')
    case 'credential-timed-out':
      throw new Error("Restauration annulée. Aucune session de cette restauration n'a été ouverte ; le scope est inchangé. Le credential Inbox n'a pas été délivré dans le délai prévu. Vérifiez dans le Journal l'état du broker et d'une éventuelle révocation en attente avant de réessayer.")
    case 'credential-unavailable':
      throw new Error(credentialUnavailableMessage(result.cause))
    case 'unattended':
      throw new Error(
        'workspace runs custom shell commands or opens a folder outside the project and needs an operator at the desktop app to approve it -- open the desktop window and retry'
      )
    default: {
      const _exhaustive: never = result
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
