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

export const TEMPLATE_TYPE = 'claude-peers-template'
export const TEMPLATE_VERSION = 1

/** One session recipe inside a template (order is the array position). */
export interface TemplateSession {
  name: string
  command?: string
  args?: string
  effort?: string
  color?: string
  /** Initial prompt submitted on the fresh spawn (PLAN C2/C18). */
  prompt?: string
  /** Team-lead entry (PLAN C10): at most one per template. */
  lead?: boolean
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
  args?: string
  effort?: string
  color?: string
  prompt?: string
  lead?: boolean
}

/** Structural subset of CreateSessionInput a template produces (no cwd). */
export interface TemplateInput {
  name?: string
  command?: string
  args?: string
  effort?: string
  color?: string
  prompt?: string
  lead?: boolean
}

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
      if (d.args && d.args.trim()) s.args = d.args.trim()
      if (d.effort && d.effort.trim()) s.effort = d.effort.trim()
      if (d.color && d.color.trim()) s.color = d.color.trim()
      if (d.prompt && d.prompt.trim()) s.prompt = d.prompt.trim()
      if (d.lead) s.lead = true
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
    if (s.args && s.args.trim()) input.args = s.args.trim()
    if (s.effort && s.effort.trim()) input.effort = s.effort.trim()
    if (s.color && s.color.trim()) input.color = s.color.trim()
    if (s.prompt && s.prompt.trim()) input.prompt = s.prompt.trim()
    if (s.lead) input.lead = true
    return input
  })
}

function isTemplateSession(v: unknown): v is TemplateSession {
  if (!v || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  if (typeof s.name !== 'string') return false
  for (const k of ['command', 'args', 'effort', 'color', 'prompt'] as const) {
    if (s[k] !== undefined && typeof s[k] !== 'string') return false
  }
  if (s.lead !== undefined && typeof s.lead !== 'boolean') return false
  return true
}

/**
 * Validate untrusted JSON as a SessionTemplate. Returns null on any structural
 * problem (wrong type tag, missing/!array sessions, malformed entries) so a bad
 * file is simply skipped rather than crashing a scan.
 */
export function parseTemplate(raw: unknown): SessionTemplate | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.type !== TEMPLATE_TYPE) return null
  if (typeof r.version !== 'number') return null
  if (!Array.isArray(r.sessions) || !r.sessions.every(isTemplateSession)) return null
  const tpl: SessionTemplate = {
    type: TEMPLATE_TYPE,
    version: r.version,
    sessions: (r.sessions as TemplateSession[]).map((s) => ({ ...s }))
  }
  if (typeof r.name === 'string' && r.name.trim()) tpl.name = r.name.trim()
  return tpl
}
