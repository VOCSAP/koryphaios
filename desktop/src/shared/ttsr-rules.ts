// On-demand guard rules: a PreToolUse/PostToolUse hook matches a tool call's
// input (or Bash output) against a regex and either denies the call or injects
// the rule's message. This module is the single engine shared by the hook, the
// rules CLI and Deck main: validator, field extraction, evaluation, hash and
// hook output.
//
// Pure module: Node builtins only, no electron and no `@shared/*` alias, so it
// bundles with `bun build --target=node` and imports under `bun test`. It has no
// log sink of its own: invalid input comes back as errors, and an unexpected
// filesystem failure is thrown for the caller to trace.

import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

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

export const TTSR_FILE_VERSION = 1
/** Max rules in one global or repo rules file. */
export const MAX_RULES = 50
/** Max size of a global or repo rules file, in UTF-8 bytes. */
export const MAX_FILE_BYTES = 64 * 1024
/** Max rules in an effective file: two capped files plus headroom for the built-ins. */
export const MAX_EFFECTIVE_RULES = 2 * MAX_RULES + 50
export const MAX_EFFECTIVE_BYTES = 4 * MAX_FILE_BYTES
export const MAX_MESSAGE_CHARS = 400
export const MAX_ID_CHARS = 64
/** Each extracted string is cut to this many UTF-16 code units before any regex runs. */
export const FIELD_CAP = 256 * 1024
/** Cap of the text the hook hands back to Claude Code (deny reason or context). */
export const MAX_HOOK_TEXT_CHARS = 4000

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

export type TtsrParseResult<T> = { ok: true; file: T } | { ok: false; errors: string[] }

export interface TtsrMatch {
  qualifiedId: string
  mode: TtsrMode
  message: string
}

export interface TtsrResult {
  denies: TtsrMatch[]
  warns: TtsrMatch[]
}

export type TtsrHookOutput =
  | {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse'
        permissionDecision: 'deny'
        permissionDecisionReason: string
      }
    }
  | { hookSpecificOutput: { hookEventName: TtsrEvent; additionalContext: string } }

const RULE_KEYS = ['id', 'event', 'tools', 'field', 'paths', 'pattern', 'flags', 'mode', 'message']
const EFFECTIVE_RULE_KEYS = [...RULE_KEYS, 'source', 'qualifiedId']
const FILE_KEYS = ['version', 'rules']
const ALLOWED_FLAGS = 'imsu'
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const TEXT_TOOLS: readonly TtsrTool[] = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']
const FIELD_TOOLS: Record<TtsrField, readonly TtsrTool[]> = {
  added: TEXT_TOOLS,
  file_path: TEXT_TOOLS,
  command: ['Bash'],
  output: ['Bash']
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function oneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (list as readonly string[]).includes(v)
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** sha256 hex of the file's UTF-8 bytes: the unit of repo-rule approval. */
export function rulesHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// Heuristic, not a ReDoS guarantee: flags a group holding an unbounded quantifier
// that is itself repeated without bound, e.g. `(a+)+`, `(\w*)*`, `(x+)*`.
export function hasNestedQuantifier(pattern: string): boolean {
  const stack: boolean[] = []
  let inClass = false
  const unboundedAt = (i: number): boolean => {
    const c = pattern[i]
    if (c === '+' || c === '*') return true
    if (c !== '{') return false
    return /^\{\d+,\}/.test(pattern.slice(i))
  }
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') {
      i++
      continue
    }
    if (inClass) {
      if (c === ']') inClass = false
      continue
    }
    if (c === '[') {
      inClass = true
      continue
    }
    if (c === '(') {
      stack.push(false)
      continue
    }
    if (c === ')') {
      const inner = stack.pop() ?? false
      if (inner && unboundedAt(i + 1)) return true
      if (inner && stack.length > 0) stack[stack.length - 1] = true
      continue
    }
    if (stack.length > 0 && unboundedAt(i)) stack[stack.length - 1] = true
  }
  return false
}

function validateGlob(glob: string): string | null {
  if (glob.length === 0) return 'is empty'
  const body = glob.startsWith('!') ? glob.slice(1) : glob
  if (body.length === 0) return 'is empty after "!"'
  if (body.includes('\\')) return 'must use "/" separators, not "\\"'
  if (body.startsWith('/')) return 'must be relative to the project root, not absolute'
  if (/^[A-Za-z]:/.test(body)) return 'must be relative, not a drive path'
  if (/[[\]{}!]/.test(body)) return 'uses unsupported glob syntax (only *, ** and ? are supported, "!" only as prefix)'
  for (const seg of body.split('/')) {
    if (seg === '') return 'has an empty segment (leading, trailing or double "/")'
    if (seg === '..') return 'must not contain a ".." segment'
    if (seg === '.') return 'must not contain a "." segment'
    if (seg.includes('**') && seg !== '**') return 'uses "**" inside a segment; "**" must be a whole segment'
  }
  return null
}

function validateFlags(flags: string): string | null {
  const seen = new Set<string>()
  for (const f of flags) {
    if (!ALLOWED_FLAGS.includes(f)) return `flag "${f}" is not allowed (allowed: i, m, s, u)`
    if (seen.has(f)) return `flag "${f}" is repeated`
    seen.add(f)
  }
  return null
}

/**
 * Validates one rule, pushing every problem into `errors`. Returns a fresh rule
 * holding only the known fields, or null when anything is wrong.
 */
function validateRule(
  raw: unknown,
  label: string,
  allowedKeys: readonly string[],
  errors: string[]
): TtsrRule | null {
  if (!isObject(raw)) {
    errors.push(`${label}: must be an object`)
    return null
  }
  const at = typeof raw.id === 'string' ? `${label} "${raw.id}"` : label
  const before = errors.length
  const err = (field: string, msg: string): void => {
    errors.push(`${at}: ${field}: ${msg}`)
  }

  for (const k of Object.keys(raw)) {
    if (!allowedKeys.includes(k)) err(k, 'unknown field')
  }

  const { id, event, tools, field, paths, pattern, flags, mode, message } = raw
  if (typeof id !== 'string') err('id', 'must be a string')
  else if (id.length > MAX_ID_CHARS) err('id', `must be at most ${MAX_ID_CHARS} characters`)
  else if (!ID_RE.test(id)) err('id', 'must be kebab-case ([a-z0-9] words joined by "-")')

  const eventOk = oneOf(TTSR_EVENTS, event)
  if (!eventOk) err('event', `must be one of ${TTSR_EVENTS.join(', ')}`)

  let toolsOk = false
  if (!Array.isArray(tools) || tools.length === 0) err('tools', 'must be a non-empty array')
  else {
    toolsOk = true
    const seen = new Set<unknown>()
    for (const t of tools) {
      if (!oneOf(TTSR_TOOLS, t)) {
        err('tools', `"${String(t)}" is not one of ${TTSR_TOOLS.join(', ')}`)
        toolsOk = false
      } else if (seen.has(t)) {
        err('tools', `"${t}" is repeated`)
        toolsOk = false
      }
      seen.add(t)
    }
  }

  const fieldOk = oneOf(TTSR_FIELDS, field)
  if (!fieldOk) err('field', `must be one of ${TTSR_FIELDS.join(', ')}`)

  const modeOk = oneOf(TTSR_MODES, mode)
  if (!modeOk) err('mode', `must be one of ${TTSR_MODES.join(', ')}`)

  if (eventOk && event === 'PostToolUse') {
    if (toolsOk && (tools as unknown[]).some((t) => t !== 'Bash'))
      err('tools', 'PostToolUse rules support only Bash')
    if (modeOk && mode === 'deny')
      err('mode', 'deny is not allowed on PostToolUse (the call already ran); use warn')
  }
  if (fieldOk && toolsOk) {
    const allowed = FIELD_TOOLS[field]
    for (const t of tools as TtsrTool[]) {
      if (!allowed.includes(t)) err('field', `"${field}" does not apply to tool ${t} (only ${allowed.join(', ')})`)
    }
  }
  if (fieldOk && field === 'output' && eventOk && event !== 'PostToolUse')
    err('field', '"output" is only available on PostToolUse')

  if (paths !== undefined) {
    if (!Array.isArray(paths) || paths.length === 0) err('paths', 'must be a non-empty array when present')
    else
      paths.forEach((p, i) => {
        if (typeof p !== 'string') err(`paths[${i}]`, 'must be a string')
        else {
          const problem = validateGlob(p)
          if (problem) err(`paths[${i}]`, `"${p}" ${problem}`)
        }
      })
  }

  let flagsOk = true
  if (flags !== undefined) {
    if (typeof flags !== 'string') {
      err('flags', 'must be a string')
      flagsOk = false
    } else {
      const problem = validateFlags(flags)
      if (problem) {
        err('flags', problem)
        flagsOk = false
      }
    }
  }

  if (typeof pattern !== 'string' || pattern.length === 0) err('pattern', 'must be a non-empty string')
  else if (flagsOk) {
    let re: RegExp | null = null
    try {
      re = new RegExp(pattern, (flags as string | undefined) ?? '')
    } catch (e) {
      err('pattern', `does not compile: ${(e as Error).message}`)
    }
    if (re) {
      if (re.test('')) err('pattern', 'matches the empty string, so it would fire on every call')
      if (hasNestedQuantifier(pattern))
        err('pattern', 'has a nested unbounded quantifier such as (a+)+ (catastrophic backtracking risk)')
    }
  }

  if (typeof message !== 'string' || message.trim().length === 0) err('message', 'must be a non-empty string')
  else if (message.length > MAX_MESSAGE_CHARS) err('message', `must be at most ${MAX_MESSAGE_CHARS} characters`)

  if (errors.length !== before) return null
  const rule: TtsrRule = {
    id: id as string,
    event: event as TtsrEvent,
    tools: [...(tools as TtsrTool[])],
    field: field as TtsrField,
    pattern: pattern as string,
    mode: mode as TtsrMode,
    message: message as string
  }
  if (paths !== undefined) rule.paths = [...(paths as string[])]
  if (flags !== undefined) rule.flags = flags as string
  return rule
}

function parseEnvelope(
  text: string,
  maxBytes: number,
  maxRules: number,
  errors: string[]
): unknown[] | null {
  const bytes = byteLength(text)
  if (bytes > maxBytes) {
    errors.push(`file: ${bytes} bytes exceeds the ${maxBytes}-byte limit`)
    return null
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    errors.push(`file: invalid JSON: ${(e as Error).message}`)
    return null
  }
  if (!isObject(data)) {
    errors.push('file: must be a JSON object')
    return null
  }
  for (const k of Object.keys(data)) {
    if (!FILE_KEYS.includes(k)) errors.push(`file: ${k}: unknown field`)
  }
  if (data.version !== TTSR_FILE_VERSION) errors.push(`file: version: must be ${TTSR_FILE_VERSION}`)
  if (!Array.isArray(data.rules)) {
    errors.push('file: rules: must be an array')
    return null
  }
  if (data.rules.length > maxRules) {
    errors.push(`file: rules: ${data.rules.length} rules exceed the limit of ${maxRules}`)
    return null
  }
  return data.rules
}

/**
 * Validates a global or repo rules file. All errors are collected; an invalid
 * file yields no rules at all, never a partial subset.
 */
export function parseRulesFile(text: string): TtsrParseResult<TtsrRuleFile> {
  const errors: string[] = []
  const raws = parseEnvelope(text, MAX_FILE_BYTES, MAX_RULES, errors)
  if (!raws) return { ok: false, errors }
  const rules: TtsrRule[] = []
  const seen = new Map<string, number>()
  raws.forEach((raw, i) => {
    const rule = validateRule(raw, `rules[${i}]`, RULE_KEYS, errors)
    const id = isObject(raw) && typeof raw.id === 'string' ? raw.id : null
    if (id !== null) {
      const first = seen.get(id)
      if (first !== undefined) errors.push(`rules[${i}] "${id}": id: duplicates rules[${first}]`)
      else seen.set(id, i)
    }
    if (rule) rules.push(rule)
  })
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, file: { version: 1, rules } }
}

/** Tags a validated file rule with its source; the source prefix lives only in `qualifiedId`. */
export function qualifyRule(source: TtsrSource, rule: TtsrRule): TtsrEffectiveRule {
  return { ...rule, source, qualifiedId: `${source}/${rule.id}` }
}

/** Defensive parse of the per-tile effective file, through the same per-rule validator. */
export function parseEffectiveFile(text: string): TtsrParseResult<TtsrEffectiveFile> {
  const errors: string[] = []
  const raws = parseEnvelope(text, MAX_EFFECTIVE_BYTES, MAX_EFFECTIVE_RULES, errors)
  if (!raws) return { ok: false, errors }
  const rules: TtsrEffectiveRule[] = []
  const seen = new Map<string, number>()
  raws.forEach((raw, i) => {
    const label = `rules[${i}]`
    const rule = validateRule(raw, label, EFFECTIVE_RULE_KEYS, errors)
    if (!isObject(raw)) return
    const { source, qualifiedId } = raw
    const at = typeof raw.id === 'string' ? `${label} "${raw.id}"` : label
    let tagged = true
    if (!oneOf(TTSR_SOURCES, source)) {
      errors.push(`${at}: source: must be one of ${TTSR_SOURCES.join(', ')}`)
      tagged = false
    }
    if (typeof qualifiedId !== 'string') {
      errors.push(`${at}: qualifiedId: must be a string`)
      tagged = false
    } else if (tagged && typeof raw.id === 'string' && qualifiedId !== `${source}/${raw.id}`) {
      errors.push(`${at}: qualifiedId: must be "${source}/${raw.id}"`)
      tagged = false
    }
    if (typeof qualifiedId === 'string') {
      const first = seen.get(qualifiedId)
      if (first !== undefined) errors.push(`${at}: qualifiedId: duplicates rules[${first}]`)
      else seen.set(qualifiedId, i)
    }
    if (rule && tagged) rules.push(qualifyRule(source as TtsrSource, rule))
  })
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, file: { version: 1, rules } }
}

function cap(s: string): string {
  return s.length > FIELD_CAP ? s.slice(0, FIELD_CAP) : s
}

function pushString(out: string[], v: unknown): void {
  if (typeof v === 'string') out.push(cap(v))
}

/** Absolute or cwd-relative target path of a file tool, or null. */
function targetPath(input: Record<string, unknown>): string | null {
  const p = typeof input.file_path === 'string' ? input.file_path : input.notebook_path
  return typeof p === 'string' && p.length > 0 ? p : null
}

/**
 * The strings a rule's regex is tested against, per tool, each capped at
 * FIELD_CAP. `payload` is the raw hook input from Claude Code (untrusted JSON).
 */
export function extractField(payload: unknown, field: TtsrField): string[] {
  if (!isObject(payload)) return []
  const tool = payload.tool_name
  const input = isObject(payload.tool_input) ? payload.tool_input : {}
  const out: string[] = []
  switch (field) {
    case 'added':
      if (tool === 'Edit') pushString(out, input.new_string)
      else if (tool === 'MultiEdit') {
        if (Array.isArray(input.edits))
          for (const e of input.edits) if (isObject(e)) pushString(out, e.new_string)
      } else if (tool === 'Write') pushString(out, input.content)
      else if (tool === 'NotebookEdit') pushString(out, input.new_source)
      break
    case 'command':
      if (tool === 'Bash') pushString(out, input.command)
      break
    case 'file_path':
      if (oneOf(TEXT_TOOLS, tool)) {
        const p = targetPath(input)
        if (p !== null) out.push(cap(p))
      }
      break
    case 'output':
      if (tool === 'Bash') {
        const res = payload.tool_response
        // A bare string response is kept as the output rather than ignored.
        if (typeof res === 'string') pushString(out, res)
        else if (isObject(res)) {
          pushString(out, res.stdout)
          pushString(out, res.stderr)
        }
      }
      break
  }
  return out
}

/**
 * Realpath of `p`, or of its longest existing ancestor with the missing tail
 * re-appended (a Write target usually does not exist yet). Throws on any error
 * other than a missing component.
 */
export function canonicalizePath(p: string): string {
  const abs = resolve(p)
  const tail: string[] = []
  let cur = abs
  for (;;) {
    try {
      const real = realpathSync.native(cur)
      return tail.length > 0 ? join(real, ...tail.reverse()) : real
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e
      const parent = dirname(cur)
      if (parent === cur) return abs
      tail.push(basename(cur))
      cur = parent
    }
  }
}

/** `/`-separated path of `target` under `root`, `''` for the root itself, null when outside. */
function projectRelative(root: string, target: string): string | null {
  const rel = relative(root, target)
  if (rel === '') return ''
  if (isAbsolute(rel)) return null
  const parts = rel.split(sep)
  if (parts[0] === '..') return null
  return parts.join('/')
}

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\*?]/g, '\\$&')
}

function segmentToRe(seg: string): string {
  let re = ''
  for (const c of seg) re += c === '*' ? '[^/]*' : c === '?' ? '[^/]' : escapeRe(c)
  return re
}

/** Compiles a validated glob (without its `!` prefix) into an anchored regex. */
export function globToRegExp(glob: string): RegExp {
  const segs = glob.split('/')
  let re = ''
  let needSep = false
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1
    if (seg === '**') {
      if (last) re += needSep ? '(?:/.*)?' : '.*'
      else {
        re += needSep ? '/(?:.*/)?' : '(?:.*/)?'
        needSep = false
      }
    } else {
      if (needSep) re += '/'
      re += segmentToRe(seg)
      needSep = true
    }
  })
  return new RegExp(`^${re}$`)
}

interface Compiled {
  re: RegExp
  include: RegExp[]
  exclude: RegExp[]
}
const compiledCache = new WeakMap<TtsrRule, Compiled>()

function compiled(rule: TtsrRule): Compiled {
  let c = compiledCache.get(rule)
  if (!c) {
    const include: RegExp[] = []
    const exclude: RegExp[] = []
    for (const g of rule.paths ?? []) {
      if (g.startsWith('!')) exclude.push(globToRegExp(g.slice(1)))
      else include.push(globToRegExp(g))
    }
    c = { re: new RegExp(rule.pattern, rule.flags ?? ''), include, exclude }
    compiledCache.set(rule, c)
  }
  return c
}

function pathsAllow(c: Compiled, rel: string): boolean {
  if (c.include.length > 0 && !c.include.some((r) => r.test(rel))) return false
  return !c.exclude.some((r) => r.test(rel))
}

/**
 * Runs `rules` against one hook payload. `paths` filters on the tool's target
 * file, relative to `projectDir`, both canonicalized; a target outside the
 * project never matches a rule that has `paths`. Throws on an unexpected
 * filesystem error (see canonicalizePath): the caller fails open and traces it.
 */
export function evaluate(
  rules: readonly TtsrEffectiveRule[],
  payload: unknown,
  projectDir: string
): TtsrResult {
  const result: TtsrResult = { denies: [], warns: [] }
  if (!isObject(payload)) return result
  const event = payload.hook_event_name
  const tool = payload.tool_name
  let root: string | null = null
  let relTarget: string | null | undefined

  const relativeTarget = (): string | null => {
    if (relTarget !== undefined) return relTarget
    root ??= canonicalizePath(projectDir)
    const input = isObject(payload.tool_input) ? payload.tool_input : {}
    const cwd = typeof payload.cwd === 'string' && payload.cwd.length > 0 ? payload.cwd : null
    // Bash has no target file: `paths` filters on the session cwd instead.
    const raw = tool === 'Bash' ? cwd : targetPath(input)
    if (raw === null) relTarget = null
    else {
      const abs = isAbsolute(raw) ? raw : resolve(cwd ?? projectDir, raw)
      relTarget = projectRelative(root, canonicalizePath(abs))
    }
    return relTarget
  }

  for (const rule of rules) {
    if (rule.event !== event || !oneOf(rule.tools, tool)) continue
    const c = compiled(rule)
    if (rule.paths && rule.paths.length > 0) {
      const rel = relativeTarget()
      if (rel === null || !pathsAllow(c, rel)) continue
    }
    if (!extractField(payload, rule.field).some((s) => c.re.test(s))) continue
    const match: TtsrMatch = { qualifiedId: rule.qualifiedId, mode: rule.mode, message: rule.message }
    if (rule.mode === 'deny') result.denies.push(match)
    else result.warns.push(match)
  }
  return result
}

function joinCapped(matches: readonly TtsrMatch[]): string {
  const lines = matches.map((m) => `[${m.qualifiedId}] ${m.message}`)
  let text = ''
  for (let i = 0; i < lines.length; i++) {
    const next = text === '' ? lines[i]! : `${text}\n${lines[i]}`
    if (next.length > MAX_HOOK_TEXT_CHARS) {
      const more = `(+${lines.length - i} more rule(s) matched)`
      return text === '' ? `${lines[i]!.slice(0, MAX_HOOK_TEXT_CHARS - more.length - 1)}\n${more}` : `${text}\n${more}`
    }
    text = next
  }
  return text
}

/**
 * The JSON object the hook prints, or null for no output. A deny (PreToolUse
 * only) wins over warns and carries only the deny messages. The decision is
 * never "allow" or "ask": either would change the operator's permission prompt.
 * On PostToolUse, where a deny cannot apply, deny matches are reported as context.
 */
export function buildHookOutput(event: TtsrEvent, result: TtsrResult): TtsrHookOutput | null {
  if (event === 'PreToolUse' && result.denies.length > 0) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: joinCapped(result.denies)
      }
    }
  }
  const context = event === 'PreToolUse' ? result.warns : [...result.denies, ...result.warns]
  if (context.length === 0) return null
  return { hookSpecificOutput: { hookEventName: event, additionalContext: joinCapped(context) } }
}
