import { expect, test } from 'bun:test'
import {
  applyWorkspaceRestoreEffects,
  handleWorkspaceRestore,
  registerWorkspaceRestoreHandler,
  type WorkspaceRestoreHandlerDeps
} from '../desktop/src/main/workspace-restore-effects'
import type { WorkspaceRestoreResult } from '../desktop/src/shared/workspace-restore-outcome'

function handlerDeps(overrides: Partial<WorkspaceRestoreHandlerDeps> = {}): WorkspaceRestoreHandlerDeps {
  return {
    workspaces: {
      sessionCwds: () => ['/project'],
      hasTeamLeadAgentSession: () => false,
      restore: async () => ({ ok: true }),
      listForCwd: () => [{ id: 'workspace', name: 'Workspace', current: true, pinned: false, createdAt: 0, updatedAt: 0 }]
    },
    isLocalIpcEvent: () => true,
    gateSandboxForCwds: async () => {},
    sandboxGate: async () => null,
    warmSandboxTranscripts: async () => {},
    ensureControlServer: async () => {},
    reportError: () => {},
    resolveOutcome: () => ({ applied: true }),
    broadcastCurrent: () => {},
    purgeInboxSession: () => {},
    ...overrides
  }
}

test('a successful restoration announces and purges after resolving its outcome', () => {
  const events: string[] = []
  const result: WorkspaceRestoreResult = { ok: true }

  const outcome = applyWorkspaceRestoreEffects(
    result,
    () => {
      events.push('resolve')
      return { applied: true }
    },
    () => events.push('announce'),
    () => events.push('purge')
  )

  expect(outcome).toEqual({ applied: true })
  expect(events).toEqual(['resolve', 'announce', 'purge'])
})

test('a restoration the resolver reports as not applied returns that outcome untouched and announces nothing', () => {
  const events: string[] = []
  const resolved: WorkspaceRestoreResult[] = []
  const result: WorkspaceRestoreResult = { ok: false, reason: 'locked' }
  const outcome = applyWorkspaceRestoreEffects(
    result,
    (received) => {
      resolved.push(received)
      return { applied: false, reason: 'locked' }
    },
    () => events.push('announce'),
    () => events.push('purge')
  )

  expect(resolved).toEqual([result])
  expect(outcome).toEqual({ applied: false, reason: 'locked' })
  expect(events, 'a quiet refusal changes nothing, so it neither announces nor purges').toEqual([])
})

test('a rejected restoration does not announce or purge', () => {
  const events: string[] = []
  const result: WorkspaceRestoreResult = { ok: false, reason: 'locked' }

  expect(() => applyWorkspaceRestoreEffects(
    result,
    () => { throw new Error('restore failed') },
    () => events.push('announce'),
    () => events.push('purge')
  )).toThrow('restore failed')
  expect(events).toEqual([])
})

test('workspace restore uses local attendance and applies its announcement and purge effects', async () => {
  const events: string[] = []
  let attendance = ''
  const outcome = await handleWorkspaceRestore('local', 'workspace', handlerDeps({
    isLocalIpcEvent: (event) => event === 'local',
    workspaces: {
      sessionCwds: () => ['/project'],
      hasTeamLeadAgentSession: () => false,
      restore: async (_id, received) => {
        attendance = received
        return { ok: true }
      },
      listForCwd: () => [{ id: 'workspace', name: 'Workspace', current: true, pinned: false, createdAt: 0, updatedAt: 0 }]
    },
    resolveOutcome: () => ({ applied: true }),
    broadcastCurrent: () => events.push('announce'),
    purgeInboxSession: () => events.push('purge')
  }))

  expect(outcome).toEqual({ applied: true })
  expect(attendance).toBe('attended')
  expect(events).toEqual(['announce', 'purge'])
})

test('the registered IPC callback gates, starts team-lead control, restores, announces, then purges', async () => {
  let callback: ((event: unknown, id: string) => Promise<unknown>) | undefined
  const events: string[] = []
  const event = {}
  const cwds = ['/project']
  const result = { ok: true } as const
  const sandboxGate = async () => null
  const warmSandboxTranscripts = async (_cwd: string) => {}
  const current = { id: 'workspace', name: 'Workspace', current: true as const, pinned: false, createdAt: 0, updatedAt: 0 }
  let receivedEvent: unknown
  let attendance = ''
  let sessionCwdsId = ''
  let teamLeadId = ''
  let restoreId = ''
  let gateCwds: string[] = []
  let receivedSandboxGate: (() => Promise<string | null>) | undefined
  let receivedWarmSandboxTranscripts: ((cwd: string) => Promise<void>) | undefined
  let resolvedResult: unknown
  let broadcastWorkspace: unknown
  registerWorkspaceRestoreHandler((channel, handler) => {
    expect(channel).toBe('workspace:restore')
    callback = handler
  }, handlerDeps({
    workspaces: {
      sessionCwds: (id) => {
        sessionCwdsId = id
        return cwds
      },
      hasTeamLeadAgentSession: (id) => {
        teamLeadId = id
        return true
      },
      restore: async (id, receivedAttendance) => {
        restoreId = id
        attendance = receivedAttendance
        events.push('restore')
        return result
      },
      listForCwd: () => [current]
    },
    isLocalIpcEvent: (received) => {
      receivedEvent = received
      return received === event
    },
    gateSandboxForCwds: async (receivedCwds, gates) => {
      gateCwds = receivedCwds
      receivedSandboxGate = gates.sandboxGate
      receivedWarmSandboxTranscripts = gates.warmSandboxTranscripts
      events.push('gate')
    },
    sandboxGate,
    warmSandboxTranscripts,
    ensureControlServer: async () => { events.push('control') },
    resolveOutcome: (received) => {
      resolvedResult = received
      return { applied: true }
    },
    broadcastCurrent: (received) => {
      broadcastWorkspace = received
      events.push('announce')
    },
    purgeInboxSession: () => events.push('purge')
  }))

  await expect(callback!(event, 'workspace')).resolves.toEqual({ applied: true })
  expect(receivedEvent).toBe(event)
  expect(attendance).toBe('attended')
  expect(sessionCwdsId).toBe('workspace')
  expect(teamLeadId).toBe('workspace')
  expect(restoreId).toBe('workspace')
  expect(gateCwds).toBe(cwds)
  expect(receivedSandboxGate).toBe(sandboxGate)
  expect(receivedWarmSandboxTranscripts).toBe(warmSandboxTranscripts)
  expect(resolvedResult).toBe(result)
  expect(broadcastWorkspace).toBe(current)
  expect(events).toEqual(['gate', 'control', 'restore', 'announce', 'purge'])
})

test('a failed team-lead control start is reported while restoration continues', async () => {
  const events: string[] = []
  const failure = new Error('control unavailable')
  let reportScope = ''
  let reportMessage = ''
  await expect(handleWorkspaceRestore('local', 'workspace', handlerDeps({
    workspaces: {
      sessionCwds: () => ['/project'],
      hasTeamLeadAgentSession: () => true,
      restore: async () => {
        events.push('restore')
        return { ok: true }
      },
      listForCwd: () => [{ id: 'workspace', name: 'Workspace', current: true, pinned: false, createdAt: 0, updatedAt: 0 }]
    },
    ensureControlServer: async () => { throw failure },
    reportError: (scope, message, error) => {
      reportScope = scope
      reportMessage = message
      expect(error).toBe(failure)
      events.push('report')
    },
    broadcastCurrent: () => events.push('announce'),
    purgeInboxSession: () => events.push('purge')
  }))).resolves.toEqual({ applied: true })

  expect(reportScope).toBe('session')
  expect(reportMessage).toBe('failed to start the deck-control endpoint for a workspace-restored team-lead tile')
  expect(events).toEqual(['report', 'restore', 'announce', 'purge'])
})

test('a workspace without a team-lead session never starts the control server', async () => {
  const events: string[] = []
  await handleWorkspaceRestore('local', 'workspace', handlerDeps({
    workspaces: {
      sessionCwds: () => ['/project'],
      hasTeamLeadAgentSession: () => false,
      restore: async () => {
        events.push('restore')
        return { ok: true }
      },
      listForCwd: () => []
    },
    ensureControlServer: async () => { events.push('control') }
  }))

  expect(events, 'the control endpoint is only for a workspace holding a team-lead tile').toEqual(['restore'])
})

test('an unapplied workspace restore stays quiet for an unattended caller', async () => {
  const events: string[] = []
  let attendance = ''
  const outcome = await handleWorkspaceRestore({}, 'workspace', handlerDeps({
    isLocalIpcEvent: () => false,
    workspaces: {
      sessionCwds: () => ['/project'],
      hasTeamLeadAgentSession: () => false,
      restore: async (_id, received) => {
        attendance = received
        return { ok: false, reason: 'locked' }
      },
      listForCwd: () => []
    },
    resolveOutcome: () => ({ applied: false, reason: 'locked' }),
    broadcastCurrent: () => events.push('announce'),
    purgeInboxSession: () => events.push('purge')
  }))

  expect(outcome).toEqual({ applied: false, reason: 'locked' })
  expect(attendance).toBe('unattended')
  expect(events).toEqual([])
})
