// Convert between the runtime SessionDef (session-service) and the persisted
// WorkspaceSession (workspace-store). Pure: no imports beyond the local types,
// so it is unit-testable under bun. SessionDef carries `args` as a single
// string (how the UI builds it); WorkspaceSession stores it as a string[].

import { randomUUID } from 'node:crypto'
// Relative import (not the @shared alias) so this module resolves cleanly when
// the bun test imports it directly, per the pure-module testing convention.
import type { SessionDef } from '../shared/types'
import { sanitizeRole, TEAM_LEAD_ROLE } from '../shared/role'
import { isClodexContextTokens } from '../shared/clodex-context'
import { isToolNameList, liftDisallowedTools } from '../shared/tool-names'
import type { WorkspaceSession } from './workspace-store'

/** Split a free-form args string into tokens on whitespace. */
export function splitArgs(args: string): string[] {
  return args.trim().length === 0 ? [] : args.trim().split(/\s+/)
}

/** Join arg tokens back into the single-string form SessionDef uses. */
export function joinArgs(args: string[]): string {
  return args.join(' ')
}

/**
 * The clodex-bridge marker, re-validated as the exact string in BOTH
 * directions: a def comes from a live service and a persisted session comes
 * from a repo-cloned file, and neither is allowed to introduce a bridge name
 * this build does not know. undefined when absent or anything else.
 */
function bridgeOf(source: { bridge?: unknown }): 'clodex' | undefined {
  return source.bridge === 'clodex' ? 'clodex' : undefined
}

function contextOf(source: { bridge?: unknown; clodexContextTokens?: unknown }): { clodexContextTokens?: number } {
  return source.bridge === 'clodex' && isClodexContextTokens(source.clodexContextTokens)
    ? { clodexContextTokens: source.clodexContextTokens }
    : {}
}

/** Snapshot live session defs as persisted workspace sessions (order preserved). */
export function toWorkspaceSessions(defs: SessionDef[]): WorkspaceSession[] {
  return defs.map((d, i) => ({
    claudeSessionId: d.sessionId,
    name: d.name,
    cwd: d.cwd,
    args: splitArgs(d.args),
    bridge: bridgeOf(d),
    ...contextOf(d),
    ...(d.disallowedTools?.length ? { disallowedTools: [...d.disallowedTools] } : {}),
    ...(d.role ? { role: d.role } : {}),
    ...(d.lead ? { lead: true } : {}),
    color: d.color,
    position: i
  }))
}

/** The persisted role through the spawn normalisation, '' when it is not a string or nothing usable remains. */
function roleOf(source: { role?: unknown }): string {
  return typeof source.role === 'string' ? sanitizeRole(source.role) : ''
}

/**
 * Keep the first team-lead role and the first lead crown (position order, as
 * `defs` comes from fromWorkspaceSessions) and strip them from the others.
 * Returns the names of the sessions that lost one, each once, so the restore
 * can announce them.
 */
export function demoteExtraTeamLeads(defs: SessionDef[]): string[] {
  const demoted: string[] = []
  let roleSeen = false
  let leadSeen = false
  for (const d of defs) {
    let lost = false
    if (d.role === TEAM_LEAD_ROLE) {
      if (roleSeen) {
        delete d.role
        lost = true
      }
      roleSeen = true
    }
    if (d.lead) {
      if (leadSeen) {
        delete d.lead
        lost = true
      }
      leadSeen = true
    }
    if (lost) demoted.push(d.name)
  }
  return demoted
}

/**
 * Rebuild session defs from a persisted workspace (fresh local ids; ordered).
 * `command` is deliberately rebuilt empty -- the machine-specific launch
 * command is the restoring window's own, never the saving one's -- so `bridge`
 * is what carries "this tile launches through the wrapper" across the
 * round-trip.
 */
export function fromWorkspaceSessions(sessions: WorkspaceSession[]): SessionDef[] {
  return [...sessions]
    .sort((a, b) => a.position - b.position)
    .map((s) => {
      const { args, disallowedTools } = liftDisallowedTools(
        joinArgs(s.args),
        isToolNameList(s.disallowedTools) ? s.disallowedTools : undefined
      )
      return {
        id: randomUUID(),
        name: s.name,
        cwd: s.cwd,
        command: '',
        bridge: bridgeOf(s),
        ...contextOf(s),
        ...(disallowedTools ? { disallowedTools } : {}),
        ...(roleOf(s) ? { role: roleOf(s) } : {}),
        ...(s.lead === true ? { lead: true } : {}),
        args,
        sessionId: s.claudeSessionId,
        color: s.color,
        createdAt: Date.now()
      }
    })
}
