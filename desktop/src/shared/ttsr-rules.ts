// On-demand guard rules: a PreToolUse/PostToolUse hook matches a tool call's
// input (or Bash output) against a regex and either denies the call or injects
// the rule's message. This module is the single engine shared by the hook, the
// rules CLI and Deck main: validator, field extraction, evaluation, hash and
// hook output.
//
// Pure module: Node builtins only, no electron and no `@shared/*` alias, so it
// bundles with `bun build --target=node` and imports under `bun test`. It has no
// log sink of its own: invalid input and a rule that could not be evaluated
// come back as errors for the caller to trace. The pattern timing gate lives
// in ttsr-probe.ts (a worker, asynchronous); parseRulesFile stays synchronous.

import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
  TTSR_EVENTS,
  TTSR_FIELDS,
  TTSR_MODES,
  TTSR_SOURCES,
  TTSR_TOOLS,
  type TtsrEffectiveFile,
  type TtsrEffectiveRule,
  type TtsrEvent,
  type TtsrField,
  type TtsrMode,
  type TtsrRule,
  type TtsrRuleFile,
  type TtsrSource,
  type TtsrTool
} from './ttsr-types'

export { TTSR_EVENTS, TTSR_FIELDS, TTSR_MODES, TTSR_SOURCES, TTSR_TOOLS }
export type {
  TtsrEffectiveFile,
  TtsrEffectiveRule,
  TtsrEvent,
  TtsrField,
  TtsrMode,
  TtsrRule,
  TtsrRuleFile,
  TtsrSource,
  TtsrTool
}

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
/**
 * Lower cap for a Bash command line: a real command is short, and every
 * regex cost grows with the input. The price is that a rule does not see
 * past the first 16 Ki characters of a longer command (a big heredoc).
 */
export const COMMAND_CAP = 16 * 1024
/**
 * Strings that occur in almost every tool call: a pattern matching any of
 * them would fire on essentially everything.
 */
export const TRIVIAL_SAMPLES: readonly string[] = ['a', 'x y', '\n', '0', '_']
/** Cap of the text the hook hands back to Claude Code (deny reason or context). */
export const MAX_HOOK_TEXT_CHARS = 4000

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

/** What evaluate() returns: the matches, plus one entry per rule it could not evaluate. */
export interface TtsrEvaluation extends TtsrResult {
  /** `<qualifiedId>: <reason>`; such a rule did not fire, the others still ran. */
  errors: string[]
}

export interface TtsrEvaluateOptions {
  /** Return as soon as one deny matches: the hook needs one deny, not all of them. */
  stopAtFirstDeny?: boolean
  /**
   * Current content of a Write target, null when it does not exist. When
   * given, an `added` rule on Write fires only if the new content holds more
   * occurrences of a match than the file already does: rewriting a file never
   * blames the agent for text it did not add. May throw; the rule is then
   * reported in `errors` and does not fire.
   */
  readExisting?: (absPath: string) => string | null
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
      const trivial = TRIVIAL_SAMPLES.find((sample) => re!.test(sample))
      if (re.test('')) err('pattern', 'matches the empty string, so it would fire on every call')
      else if (trivial !== undefined)
        err('pattern', `matches the trivial text ${JSON.stringify(trivial)}, so it would fire on almost every call`)
      if (!((flags as string | undefined) ?? '').includes('u') && /(?:^|[^\\])(?:\\\\)*\\[pP]\{/.test(pattern))
        err('pattern', 'uses \\p{...} or \\P{...} without the "u" flag, where it means a literal "p{...}"; add "u" to flags')
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

/** The cap applied to the strings of `field` before any regex runs. */
export function fieldCap(field: TtsrField): number {
  return field === 'command' ? COMMAND_CAP : FIELD_CAP
}

function capTo(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s
}

/** Absolute or cwd-relative target path of a file tool, or null. */
function targetPath(input: Record<string, unknown>): string | null {
  const p = typeof input.file_path === 'string' ? input.file_path : input.notebook_path
  return typeof p === 'string' && p.length > 0 ? p : null
}

/**
 * The strings a rule's regex is tested against, per tool, each capped at
 * fieldCap(field). `payload` is the raw hook input from Claude Code (untrusted JSON).
 */
export function extractField(payload: unknown, field: TtsrField): string[] {
  if (!isObject(payload)) return []
  const tool = payload.tool_name
  const input = isObject(payload.tool_input) ? payload.tool_input : {}
  const out: string[] = []
  const max = fieldCap(field)
  const pushString = (o: string[], v: unknown): void => {
    if (typeof v === 'string') o.push(capTo(v, max))
  }
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
        if (p !== null) out.push(capTo(p, max))
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

/** Where a tool call lands: its path under the project (null when outside), and its canonical absolute path. */
interface Target {
  rel: string | null
  abs: string
}

/**
 * `paths` verdict for a target. No target (Bash without a cwd) never matches.
 * A target outside the project never matches a rule with an include glob; an
 * exclusion-only rule ("everywhere except *.md") still applies there, its
 * exclusions tested against the absolute path.
 */
function pathsAllowTarget(c: Compiled, target: Target | null): boolean {
  if (target === null) return false
  if (target.rel !== null) return pathsAllow(c, target.rel)
  if (c.include.length > 0) return false
  const abs = target.abs.split(sep).join('/').replace(/^\/+/, '')
  return !c.exclude.some((r) => r.test(abs))
}

/** Occurrences of each distinct match of `re` in `text`. */
function matchCounts(re: RegExp, text: string): Map<string, number> {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
  const counts = new Map<string, number>()
  for (const m of text.matchAll(g)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1)
  return counts
}

/** True when `next` holds some match of `re` more often than `before` does. */
function addsMatch(re: RegExp, next: string, before: string): boolean {
  const old = matchCounts(re, before)
  for (const [text, n] of matchCounts(re, next)) if (n > (old.get(text) ?? 0)) return true
  return false
}

/**
 * The order the hook evaluates rules in: every deny before any warn, and
 * within a mode Kory, then user, then repo rules. With `stopAtFirstDeny`,
 * a slow user or repo rule can then delay but never cancel a Kory deny, and
 * no warn runs once a deny is known.
 */
export function hookEvaluationOrder(rules: readonly TtsrEffectiveRule[]): TtsrEffectiveRule[] {
  const rank = (r: TtsrEffectiveRule): number => (r.mode === 'deny' ? 0 : 3) + TTSR_SOURCES.indexOf(r.source)
  return [...rules].sort((a, b) => rank(a) - rank(b))
}

/**
 * Runs `rules` against one hook payload, in the given order. `paths` filters
 * on the tool's target file (Bash: the session cwd) relative to the project
 * root, both canonicalized. `projectDir` may be a function: it is then called
 * at most once, and only when a rule with `paths` has matched its field, so a
 * costly root lookup is not paid on calls no such rule matches. A failure
 * while resolving a path or reading a Write target is confined to the rules
 * that needed it: they do not fire and are listed in `errors`.
 */
export function evaluate(
  rules: readonly TtsrEffectiveRule[],
  payload: unknown,
  projectDir: string | (() => string),
  opts: TtsrEvaluateOptions = {}
): TtsrEvaluation {
  const result: TtsrEvaluation = { denies: [], warns: [], errors: [] }
  if (!isObject(payload)) return result
  const event = payload.hook_event_name
  const tool = payload.tool_name
  const input = isObject(payload.tool_input) ? payload.tool_input : {}
  const cwd = typeof payload.cwd === 'string' && payload.cwd.length > 0 ? payload.cwd : null

  let root: string | null = null
  const projectRoot = (): string => {
    root ??= canonicalizePath(typeof projectDir === 'string' ? projectDir : projectDir())
    return root
  }
  // Bash has no target file: `paths` filters on the session cwd instead.
  const rawTarget = tool === 'Bash' ? cwd : targetPath(input)
  const absTarget = (): string | null => {
    if (rawTarget === null) return null
    return isAbsolute(rawTarget) ? rawTarget : resolve(cwd ?? projectRoot(), rawTarget)
  }
  let target: { value: Target | null } | { error: unknown } | undefined
  const resolveTarget = (): Target | null => {
    if (target === undefined) {
      try {
        const abs = absTarget()
        if (abs === null) target = { value: null }
        else {
          const canon = canonicalizePath(abs)
          target = { value: { rel: projectRelative(projectRoot(), canon), abs: canon } }
        }
      } catch (e) {
        target = { error: e }
      }
    }
    if ('error' in target) throw target.error
    return target.value
  }
  let existing: { value: string | null } | undefined
  const existingContent = (read: (p: string) => string | null): string | null => {
    if (existing === undefined) {
      const abs = absTarget()
      existing = { value: abs === null ? null : read(abs) }
    }
    return existing.value
  }

  const fires = (rule: TtsrEffectiveRule): boolean => {
    const c = compiled(rule)
    const hasPaths = rule.paths !== undefined && rule.paths.length > 0
    // Paths first when the root is already known (cheap); otherwise the regex
    // first, so the root lookup only runs for a rule that matched.
    const pathsFirst = hasPaths && (root !== null || typeof projectDir === 'string')
    if (pathsFirst && !pathsAllowTarget(c, resolveTarget())) return false
    const texts = extractField(payload, rule.field)
    if (!texts.some((s) => c.re.test(s))) return false
    if (hasPaths && !pathsFirst && !pathsAllowTarget(c, resolveTarget())) return false
    if (rule.field === 'added' && tool === 'Write' && opts.readExisting && texts.length === 1) {
      const before = existingContent(opts.readExisting)
      if (before !== null) return addsMatch(c.re, texts[0]!, capTo(before, FIELD_CAP))
    }
    return true
  }

  for (const rule of rules) {
    if (rule.event !== event || !oneOf(rule.tools, tool)) continue
    let hit: boolean
    try {
      hit = fires(rule)
    } catch (e) {
      result.errors.push(`${rule.qualifiedId}: ${(e as Error).message ?? String(e)}`)
      continue
    }
    if (!hit) continue
    const match: TtsrMatch = { qualifiedId: rule.qualifiedId, mode: rule.mode, message: rule.message }
    if (rule.mode === 'deny') {
      result.denies.push(match)
      if (opts.stopAtFirstDeny) return result
    } else result.warns.push(match)
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
