import type { CallerAttendance, WorkspaceService } from './workspace-service'
import type { WorkspaceRestoreOutcome, WorkspaceRestoreResult } from '../shared/workspace-restore-outcome'

export interface WorkspaceRestoreHandlerDeps {
  workspaces: Pick<WorkspaceService, 'sessionCwds' | 'hasTeamLeadAgentSession' | 'restore' | 'listForCwd'>
  isLocalIpcEvent: (event: unknown) => boolean
  gateSandboxForCwds: (
    cwds: string[],
    gates: { sandboxGate: () => Promise<string | null>; warmSandboxTranscripts: (cwd: string) => Promise<void> }
  ) => Promise<void>
  sandboxGate: () => Promise<string | null>
  warmSandboxTranscripts: (cwd: string) => Promise<void>
  ensureControlServer: () => Promise<unknown>
  reportError: (scope: string, message: string, error: unknown) => void
  resolveOutcome: (result: WorkspaceRestoreResult) => WorkspaceRestoreOutcome
  broadcastCurrent: (current: ReturnType<WorkspaceService['listForCwd']>[number] | null) => void
  purgeInboxSession: () => void
}

export function applyWorkspaceRestoreEffects(
  result: WorkspaceRestoreResult,
  resolve: (result: WorkspaceRestoreResult) => WorkspaceRestoreOutcome,
  announce: () => void,
  purge: () => void
): WorkspaceRestoreOutcome {
  const outcome = resolve(result)
  if (outcome.applied) {
    announce()
    purge()
  }
  return outcome
}

export function registerWorkspaceRestoreHandler(
  regHandle: (channel: string, handler: (event: unknown, id: string) => Promise<WorkspaceRestoreOutcome>) => void,
  deps: WorkspaceRestoreHandlerDeps
): void {
  regHandle('workspace:restore', (event, id) => handleWorkspaceRestore(event, id, deps))
}

export async function handleWorkspaceRestore(
  event: unknown,
  id: string,
  deps: WorkspaceRestoreHandlerDeps
): Promise<WorkspaceRestoreOutcome> {
  await deps.gateSandboxForCwds(deps.workspaces.sessionCwds(id), {
    sandboxGate: deps.sandboxGate,
    warmSandboxTranscripts: deps.warmSandboxTranscripts
  })
  if (deps.workspaces.hasTeamLeadAgentSession(id)) {
    try {
      await deps.ensureControlServer()
    } catch (error) {
      deps.reportError('session', 'failed to start the deck-control endpoint for a workspace-restored team-lead tile', error)
    }
  }
  const attendance: CallerAttendance = deps.isLocalIpcEvent(event) ? 'attended' : 'unattended'
  const result = await deps.workspaces.restore(id, attendance)
  return applyWorkspaceRestoreEffects(
    result,
    deps.resolveOutcome,
    () => deps.broadcastCurrent(deps.workspaces.listForCwd().find((workspace) => workspace.current) ?? null),
    deps.purgeInboxSession
  )
}
