// Portable team templates. A template captures the *recipe* of a set of peer
// sessions -- their names, launch args (which carry --agent/--model), effort,
// colour and order -- with everything machine/project-specific deliberately
// stripped: no cwd (working directory), no claude session id, and no group
// secret (the secret never lives in a SessionDef, it is stored separately, so
// it cannot leak into a template).
//
// Pure module: NO electron / node imports and NO `@shared/*` alias import, so
// it resolves cleanly under `bun test` (which has no alias tsconfig). The shapes
// it consumes/produces are declared structurally here and stay compatible with
// SessionDef / CreateSessionInput in shared/types.ts.

import { isClodexContextTokens, isValidClodexContextInput } from './clodex-context'
import { liftTemplateLaunchOptions } from './template-launch-options'
import { isToolNameList, liftDisallowedTools } from './tool-names'

export const TEMPLATE_TYPE = 'claude-peers-template'
export const TEMPLATE_VERSION = 1

/** One session recipe inside a template (order is the array position). */
export interface TemplateSession {
  name: string
  command?: string
  bridge?: 'clodex'
  clodexContextTokens?: number
  args?: string
  effort?: string
  color?: string
  /** Initial prompt submitted on the fresh spawn (PLAN C2/C18). */
  prompt?: string
  /** Team-lead entry (PLAN C10): at most one per template. */
  lead?: boolean
  /** Subagent profile (`--agent`), composer-authored (PLAN C18). */
  agent?: string
  /** Model (`--model`), composer-authored (PLAN C18). */
  model?: string
  /**
   * Fresh-worktree branch (PLAN C18): the session spawns in a NEW worktree on
   * this branch. Applying twice fails on the existing branch — by design.
   */
  worktreeBranch?: string
  /** Operator-authored join announce (PLAN C18). */
  announce?: string
  /**
   * Operator-chosen role (card 0b9e0b07, lot A). Captured and applied in BOTH
   * the global and local template scope, no strip, no approval branch: a role
   * carries no authorization today, it is a routing/display label (see
   * `SessionDef.role` in shared/types.ts for the full arbitration). Re-validated
   * at the one production sink (`session-service.ts`'s `sanitizeRole(input.role
   * ?? '') || ''`), never here.
   */
  role?: string
  /** Tool denial of the captured tile (SessionDef.disallowedTools), validated at parse and at spawn. */
  disallowedTools?: string[]
}

export interface SessionTemplate {
  type: typeof TEMPLATE_TYPE
  version: number
  /** Optional human label for the template (file basename used when absent). */
  name?: string
  sessions: TemplateSession[]
}

/** Structural subset of SessionDef that a template reads. */
interface DefLike {
  name: string
  command?: string
  bridge?: 'clodex'
  clodexContextTokens?: number
  args?: string
  effort?: string
  color?: string
  prompt?: string
  lead?: boolean
  role?: string
  disallowedTools?: string[]
}

/** Structural subset of CreateSessionInput a template produces (no cwd). */
export interface TemplateInput {
  name?: string
  command?: string
  bridge?: 'clodex'
  clodexContextTokens?: number
  args?: string
  effort?: string
  color?: string
  prompt?: string
  lead?: boolean
  agent?: string
  model?: string
  worktreeBranch?: string
  announce?: string
  role?: string
  disallowedTools?: string[]
}

/**
 * Discriminated result of resolving a template path to spawnable inputs
 * (card 96c98453). 'refused' is the operator's own choice in the shell-field
 * approval dialog and is NOT an error -- 'containment' (path outside the
 * allowed template dirs) and 'malformed' (unreadable / invalid file) are real
 * anomalies. 'unattended' (card 64f8f629) is a caller with nobody at the
 * desktop app to answer the approval dialog: distinct from 'refused' (an
 * operator's deliberate click) because the caller here never got a chance to
 * decide anything. Consumers must switch on `reason` with a never-
 * exhaustiveness default so a future fifth reason fails to compile instead of
 * silently falling into an existing bucket.
 */
export type TemplateResolveResult =
  | { ok: true; inputs: TemplateInput[] }
  | { ok: false; reason: 'containment' | 'malformed' | 'refused' | 'unattended' }

/**
 * Build a template from the current session defs. Keeps name/command/args/
 * effort/colour and the order; drops cwd / id / sessionId / createdAt.
 */
export function toTemplate(defs: readonly DefLike[], name?: string): SessionTemplate {
  const tpl: SessionTemplate = {
    type: TEMPLATE_TYPE,
    version: TEMPLATE_VERSION,
    sessions: defs.map((d) => {
      const s: TemplateSession = { name: d.name }
      if (d.command && d.command.trim()) s.command = d.command.trim()
      if (d.bridge === 'clodex') {
        s.bridge = 'clodex'
        if (isClodexContextTokens(d.clodexContextTokens)) s.clodexContextTokens = d.clodexContextTokens
      }
      const lifted = liftTemplateLaunchOptions({ args: d.args })
      if (lifted.args.trim()) s.args = lifted.args.trim()
      if (lifted.agent) s.agent = lifted.agent
      if (lifted.model) s.model = lifted.model
      if (d.effort && d.effort.trim()) s.effort = d.effort.trim()
      if (d.color && d.color.trim()) s.color = d.color.trim()
      if (d.prompt && d.prompt.trim()) s.prompt = d.prompt.trim()
      if (d.lead) s.lead = true
      if (d.role && d.role.trim()) s.role = d.role.trim()
      if (d.disallowedTools?.length) s.disallowedTools = [...d.disallowedTools]
      return s
    })
  }
  if (name && name.trim()) tpl.name = name.trim()
  return tpl
}

/**
 * Map a template to CreateSessionInput-shaped objects (order preserved). cwd is
 * intentionally omitted so the importing window spawns each peer in its own
 * current project directory and group.
 */
export function templateToInputs(tpl: SessionTemplate): TemplateInput[] {
  return tpl.sessions.map((s) => {
    const input: TemplateInput = {}
    if (s.name && s.name.trim()) input.name = s.name.trim()
    if (s.command && s.command.trim()) input.command = s.command.trim()
    if (s.bridge === 'clodex') {
      input.bridge = 'clodex'
      if (isClodexContextTokens(s.clodexContextTokens)) input.clodexContextTokens = s.clodexContextTokens
    }
    const lifted = liftDisallowedTools(s.args?.trim() ?? '', s.disallowedTools)
    if (lifted.args) input.args = lifted.args
    if (s.effort && s.effort.trim()) input.effort = s.effort.trim()
    if (s.color && s.color.trim()) input.color = s.color.trim()
    if (s.prompt && s.prompt.trim()) input.prompt = s.prompt.trim()
    if (s.lead) input.lead = true
    if (s.agent && s.agent.trim()) input.agent = s.agent.trim()
    if (s.model && s.model.trim()) input.model = s.model.trim()
    if (s.worktreeBranch && s.worktreeBranch.trim()) input.worktreeBranch = s.worktreeBranch.trim()
    if (s.announce && s.announce.trim()) input.announce = s.announce.trim()
    if (s.role && s.role.trim()) input.role = s.role.trim()
    if (lifted.disallowedTools) input.disallowedTools = lifted.disallowedTools
    return input
  })
}

/**
 * A `bridge` marker swaps the launch binary for a wrapper of its own and
 * spends the operator's own provider quota, so it is shell-bearing exactly
 * like `command` — the value it names is irrelevant, only that one is asked
 * for at all. Read as `unknown`, not through the declared type: callers hand
 * this predicate objects parsed from an untrusted file, so anything that is
 * neither absent nor an empty string must GATE rather than slip past a
 * `.trim()` that would throw on it.
 */
function hasLaunchBridge(bridge: unknown): boolean {
  if (bridge === undefined) return false
  return typeof bridge === 'string' ? bridge.trim() !== '' : true
}

export function sessionsHaveShellFields(
  sessions: readonly { command?: string; args?: string; bridge?: string }[]
): boolean {
  return sessions.some(
    (s) =>
      (s.command && s.command.trim() !== '') ||
      (s.args && s.args.trim() !== '') ||
      hasLaunchBridge(s.bridge)
  )
}

export const TEMPLATE_SESSION_FIELD_CLASS = {
  command: 'approval',
  args: 'approval',
  bridge: 'approval',
  clodexContextTokens: 'approval',
  prompt: 'approval',
  lead: 'approval',
  agent: 'approval',
  worktreeBranch: 'approval',
  announce: 'approval',
  disallowedTools: 'approval',
  name: 'free',
  color: 'free',
  role: 'free',
  model: 'free',
  effort: 'free'
} as const satisfies Record<keyof TemplateSession, 'free' | 'approval'>

const APPROVAL_FIELDS = (Object.keys(TEMPLATE_SESSION_FIELD_CLASS) as (keyof TemplateSession)[]).filter(
  (field) => TEMPLATE_SESSION_FIELD_CLASS[field] === 'approval'
)

/** Unexpected types must gate because template sessions originate in untrusted files. */
function isPresent(value: unknown): boolean {
  if (value === undefined || value === false) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length > 0
  return true
}

export function templateHasShellFields(tpl: SessionTemplate): boolean {
  return tpl.sessions.some((s) => APPROVAL_FIELDS.some((field) => isPresent(s[field])))
}

export function templateApproval(tpl: SessionTemplate): {
  hashPayload: Array<Record<string, unknown>>
  previewLines: string[]
} {
  return {
    hashPayload: tpl.sessions.map((s) => {
      // command/args stay unconditional and bridge stays first to preserve existing approval hashes.
      const entry: Record<string, unknown> = { command: s.command ?? '', args: s.args ?? '' }
      for (const field of APPROVAL_FIELDS) {
        if (field !== 'command' && field !== 'args' && isPresent(s[field])) entry[field] = s[field]
      }
      return entry
    }),
    previewLines: tpl.sessions.flatMap((s) => {
      const lines: string[] = []
      if ((s.command && s.command.trim()) || (s.args && s.args.trim()) || s.bridge === 'clodex') {
        lines.push([s.bridge === 'clodex' ? '[clodex]' : undefined, s.command, s.args].filter(Boolean).join(' '))
      }
      for (const field of APPROVAL_FIELDS) {
        if (field === 'command' || field === 'args' || field === 'bridge' || !isPresent(s[field])) continue
        const value = s[field]
        lines.push(`${s.name}: ${value === true ? field : `${field} ${Array.isArray(value) ? value.join(',') : String(value)}`}`)
      }
      return lines
    })
  }
}

function isTemplateSession(v: unknown): v is TemplateSession {
  if (!v || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  if (typeof s.name !== 'string') return false
  for (const k of [
    'command',
    'args',
    'effort',
    'color',
    'prompt',
    'agent',
    'model',
    'worktreeBranch',
    'announce',
    'role'
  ] as const) {
    if (s[k] !== undefined && typeof s[k] !== 'string') return false
  }
  if (s.lead !== undefined && typeof s.lead !== 'boolean') return false
  if (s.bridge !== undefined && s.bridge !== 'clodex') return false
  if (!isValidClodexContextInput(s.clodexContextTokens)) return false
  // A list holding a name outside the allow-list rejects the template whole: dropping the
  // offender would silently allow that tool.
  if (s.disallowedTools !== undefined && !isToolNameList(s.disallowedTools)) return false
  return true
}

/** Result of {@link parseTemplate}: the normalized template plus what it silently fixed. */
export interface ParsedTemplate {
  /** The parsed template. Lead uniqueness (PLAN C10/C18: at most ONE per
   * template) is normalized here — extra leads are demoted, first one wins.
   * This RESOLUTION RULE is unchanged (card 240d6efd decision 3); only its
   * silence is fixed, via `demotedLeadNames` below. */
  template: SessionTemplate
  /**
   * Names of sessions whose lead: true was demoted by the first-wins rule
   * above; empty when nothing was repaired.
   * Returned as a widened shape rather than an optional param or callback, so
   * every caller must destructure .template instead of reading the return value
   * as a flat SessionTemplate -- a caller cannot compile while still blind to a
   * demotion.
   */
  demotedLeadNames: string[]
}

/**
 * Validate untrusted JSON as a SessionTemplate. Returns null on any structural
 * problem (wrong type tag, missing/!array sessions, malformed entries) so a bad
 * file is simply skipped rather than crashing a scan.
 */
export function parseTemplate(raw: unknown): ParsedTemplate | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.type !== TEMPLATE_TYPE) return null
  if (typeof r.version !== 'number') return null
  if (!Array.isArray(r.sessions) || !r.sessions.every(isTemplateSession)) return null
  let leadSeen = false
  const demotedLeadNames: string[] = []
  const tpl: SessionTemplate = {
    type: TEMPLATE_TYPE,
    version: r.version,
    sessions: (r.sessions as TemplateSession[]).map((s) => {
      const copy = { ...s }
      if (copy.lead) {
        if (leadSeen) {
          demotedLeadNames.push(copy.name)
          delete copy.lead
        }
        leadSeen = true
      }
      return copy
    })
  }
  if (typeof r.name === 'string' && r.name.trim()) tpl.name = r.name.trim()
  return { template: tpl, demotedLeadNames }
}
