// A verdict carries no dialog identity, so the screen is the only witness that
// the dialog the CLI shows is the one the operator approved. Layout read from
// Claude Code 2.1.291: below the last full-width rule, a header ("Bash
// command" + description, or "Create file" + cwd-relative path), a body
// between two dashed rules, then the numbered chooser. Only a command shown on
// one row is checked: indented by one space, or on a single " │ " gutter row.
// Across gutter rows nothing is decidable: trailing spaces are invisible and
// the CLI pads a wrapped row with spaces, so a long run of spaces and a typed
// newline render the same. Anything else is refused: an untyped verdict costs
// one terminal keystroke, a mistyped one grants what nobody approved.

import { basename, dirname, join, resolve } from 'node:path'
import { TITLE_DETAIL_MAX, summarizeToolInput } from '../../hooks/tool-summary'

const RULE = String.fromCodePoint(0x2500)
const DASHED = String.fromCodePoint(0x254c)
const CHEVRON = String.fromCodePoint(0x276f)
const GUTTER = ` ${String.fromCodePoint(0x2502)} `
/**
 * Longest one-line command the CLI shows in the indented form; a longer one
 * that still fits gets a single gutter row. Measured on 120 columns only, so
 * a single gutter row is refused on a narrower terminal.
 */
const INDENTED_MAX = 80
const GUTTER_MEASURED_COLUMNS = 120

/** Dialog header per tool, only for layouts measured on a live CLI. */
const HEADERS: Record<string, string> = { Bash: 'Bash command', Write: 'Create file' }
const INPUT_FIELD: Record<string, string> = { Bash: 'command', Write: 'file_path' }

/**
 * `absent`: no dialog to compare against yet (no screen, no chooser), so the
 * verdict may still land once one appears. Otherwise a dialog IS on screen, or
 * the row can never be checked, and the verdict must not be kept.
 */
export type DialogMatch = { ok: true } | { ok: false; absent: boolean; reason: string }

export interface DialogContext {
  /** The tile's working directory, which the CLI's relative paths hang off. */
  cwd: string | null
  /** Resolves symlinks and short names (canonicalPath). */
  canonical: (path: string) => string
}

const width = (s: string): number => [...s].length

const isRule = (line: string, ch: string): boolean => {
  const t = line.trim()
  return t.length >= 8 && [...t].every((c) => c === ch)
}

const lastIndex = (lines: string[], before: number, test: (line: string) => boolean): number => {
  for (let i = before - 1; i >= 0; i--) if (test(lines[i] ?? '')) return i
  return -1
}

const CHOOSER_RE = new RegExp(`^\\s*${CHEVRON}\\s*(\\d+)\\.\\s`)
const OPTION_RE = /^\s+\d+\.\s/
/** The one hint line measured under the chooser. */
const CHOOSER_HINT = 'Esc to cancel · Tab to amend'

/** Below the last rule only: the conversation above it echoes the same command. */
function dialogRegion(lines: string[]): { region: string[]; columns: number; selected: number; tail: string[] } | null {
  const chooser = lastIndex(lines, lines.length, (l) => CHOOSER_RE.test(l))
  if (chooser < 0) return null
  const rule = lastIndex(lines, chooser, (l) => isRule(l, RULE))
  if (rule < 0) return null
  return {
    region: lines.slice(rule + 1, chooser),
    columns: width((lines[rule] ?? '').trimEnd()),
    selected: Number(CHOOSER_RE.exec(lines[chooser] ?? '')?.[1]),
    tail: lines.slice(chooser + 1)
  }
}

/** Whether a numbered chooser is on screen, on any option, under a rule or not. */
export function permissionDialogShown(lines: string[] | null): boolean {
  return lines !== null && lines.some((l) => CHOOSER_RE.test(l))
}

type QuestionInput = { kind: 'none' } | { kind: 'ambiguous' } | { kind: 'ok'; value: string }

/**
 * The field from the hook's question line `Input: <json>`. `none` when the
 * line is absent or does not parse, which is what the hook's length cap does
 * to a long input; `ambiguous` when the question could be read two ways (two
 * Input lines, or a duplicated key JSON.parse would silently resolve).
 */
function questionInput(question: string, field: string): QuestionInput {
  const inputs = question.split('\n').filter((l) => l.startsWith('Input: '))
  if (inputs.length === 0) return { kind: 'none' }
  if (inputs.length > 1) return { kind: 'ambiguous' }
  const raw = inputs[0]!.slice('Input: '.length)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    if (e instanceof SyntaxError) return { kind: 'none' }
    throw e
  }
  if (JSON.stringify(parsed) !== raw) return { kind: 'ambiguous' }
  const value = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>)[field] : undefined
  return typeof value === 'string' ? { kind: 'ok', value } : { kind: 'none' }
}

/**
 * The tool input the operator approved. The title is what every channel
 * shows; the question carries the full input as JSON. Both must agree, so a
 * row cannot show one thing and carry another.
 */
function approvedInput(tool: string, title: string, question: string): string | null {
  const field = INPUT_FIELD[tool]!
  const parsed = questionInput(question, field)
  if (parsed.kind === 'ambiguous') return null
  const full = parsed.kind === 'ok' ? parsed.value : null
  if (full !== null) return summarizeToolInput(tool, { [field]: full }) === title ? full : null
  const detail = title.slice(tool.length + 2)
  // A cut title alone names only a prefix: an honest command and a longer one
  // sharing it look the same, so there is nothing to compare.
  return width(detail) < TITLE_DETAIL_MAX ? detail : null
}

/** The one row of the dialog body against the approved command. */
function commandMatches(line: string, command: string, columns: number): boolean {
  // The screen drops trailing whitespace of every kind, so only the ASCII space
  // can be told apart by its position.
  if (/[^\S ]/u.test(command)) return false
  if (!line.startsWith(GUTTER)) return line === ` ${command.replace(/ +$/, '')}`
  // Outside printable ASCII, code points are not display columns.
  return (
    columns >= GUTTER_MEASURED_COLUMNS &&
    width(command) > INDENTED_MAX &&
    line.slice(GUTTER.length) === command &&
    !/[^ -~]/.test(command)
  )
}

export function matchPermissionDialog(
  approval: { title: string; question: string },
  lines: string[] | null,
  ctx: DialogContext
): DialogMatch {
  const sep = approval.title.indexOf(': ')
  const tool = sep > 0 ? approval.title.slice(0, sep) : approval.title
  const expected = HEADERS[tool]
  if (!expected) return { ok: false, absent: false, reason: `no screen check exists for a ${tool} dialog` }
  const input = approvedInput(tool, approval.title, approval.question)
  if (input === null) {
    return { ok: false, absent: false, reason: 'the approval does not carry a full tool input matching its title' }
  }

  if (!lines) return { ok: false, absent: true, reason: 'no screen recorded for the tile' }
  const found = dialogRegion(lines)
  if (!found) return { ok: false, absent: true, reason: 'no permission dialog on screen' }
  const { region, columns, selected, tail } = found
  // Enter submits the highlighted option: only Yes is what the operator chose.
  if (selected !== 1) return { ok: false, absent: false, reason: `the chooser on screen has option ${selected} highlighted, not Yes` }
  if (!tail.every((l) => l.trim() === '' || OPTION_RE.test(l) || l.trim() === CHOOSER_HINT)) {
    return { ok: false, absent: false, reason: 'something other than the chooser follows it on screen' }
  }

  // Exactly two: the description line above the body is the agent's text, and
  // a dashed rule drawn inside it would frame a body of its choosing.
  const dashed = region.flatMap((l, i) => (isRule(l, DASHED) ? [i] : []))
  if (dashed.length !== 2) return { ok: false, absent: false, reason: 'the dialog on screen has no recognisable body' }
  const [open, close] = dashed as [number, number]
  const header = region.slice(0, open).map((l) => l.trim()).filter(Boolean)
  if (header[0] !== expected) {
    return { ok: false, absent: false, reason: `the dialog on screen is "${header[0] ?? '?'}", not "${expected}"` }
  }

  if (tool === 'Bash') {
    const body = region.slice(open + 1, close)
    if (body.length > 1) return { ok: false, absent: false, reason: 'a command shown on more than one line cannot be checked on screen' }
    return commandMatches(body[0] ?? '', input, columns)
      ? { ok: true }
      : { ok: false, absent: false, reason: 'the command on screen differs from the one the operator approved' }
  }

  const shown = header[1]
  const cwd = ctx.cwd
  if (!shown || !cwd) return { ok: false, absent: false, reason: 'the file on screen cannot be located' }
  const file = (p: string): string => {
    const full = resolve(cwd, p)
    return join(ctx.canonical(dirname(full)), basename(full))
  }
  return file(shown) === file(input)
    ? { ok: true }
    : { ok: false, absent: false, reason: 'the file on screen differs from the one the operator approved' }
}
