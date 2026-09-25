// Data types and enumerations of the guard rules (TTSR). Kept apart from the
// engine (ttsr-rules.ts, which needs node builtins) so that shared/types.ts,
// compiled into the renderer, can reference them without pulling a node
// import into a browser program. No import of any kind here.

export const TTSR_SOURCES = ['kory', 'user', 'repo'] as const
export type TtsrSource = (typeof TTSR_SOURCES)[number]

export const TTSR_EVENTS = ['PreToolUse', 'PostToolUse'] as const
export type TtsrEvent = (typeof TTSR_EVENTS)[number]

export const TTSR_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash'] as const
export type TtsrTool = (typeof TTSR_TOOLS)[number]

export const TTSR_FIELDS = ['added', 'command', 'file_path', 'output'] as const
export type TtsrField = (typeof TTSR_FIELDS)[number]

export const TTSR_MODES = ['deny', 'warn'] as const
export type TtsrMode = (typeof TTSR_MODES)[number]

/** One rule as written in a global or repo rules file (id not yet prefixed). */
export interface TtsrRule {
  id: string
  event: TtsrEvent
  tools: TtsrTool[]
  field: TtsrField
  /** Project-relative globs (`**`, `*`, `?`); a leading `!` excludes. */
  paths?: string[]
  pattern: string
  flags?: string
  mode: TtsrMode
  message: string
}

export interface TtsrRuleFile {
  version: 1
  rules: TtsrRule[]
}

/** A rule once loaded: `id` stays the file's id, `qualifiedId` is `<source>/<id>`. */
export interface TtsrEffectiveRule extends TtsrRule {
  source: TtsrSource
  qualifiedId: string
}

/** The per-tile file the Deck writes and the hook reads. */
export interface TtsrEffectiveFile {
  version: 1
  rules: TtsrEffectiveRule[]
}
