import { SESSION_COMMAND_LIMITS } from './session-skill-limits'

export type CommandLineRefusal =
  | 'not-a-string'
  | 'control-character'
  | 'empty'
  | 'missing-slash'
  | 'bad-command'
  | 'command-too-long'
  | 'args-too-long'

export type CommandLineResult = { ok: true; command: string; args: string } | { ok: false; reason: CommandLineRefusal }

const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/
// Same classes as the turn signal parser's text rule: a line it would refuse is refused here.
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/u

const refuse = (reason: CommandLineRefusal): CommandLineResult => ({ ok: false, reason })

/** Splits one configured line `/name [args]` into the engine's command name and its args. */
export function validateCommandLine(line: unknown): CommandLineResult {
  if (typeof line !== 'string') return refuse('not-a-string')
  if (UNSAFE_TEXT.test(line)) return refuse('control-character')
  const trimmed = line.trim()
  if (trimmed === '' || trimmed === '/') return refuse('empty')
  if (!trimmed.startsWith('/')) return refuse('missing-slash')
  const body = trimmed.slice(1)
  const command = body.split(/\s/, 1)[0] ?? ''
  if (!COMMAND_NAME.test(command)) return refuse('bad-command')
  if (Array.from(command).length > SESSION_COMMAND_LIMITS.command) return refuse('command-too-long')
  const args = body.slice(command.length).trim()
  if (Array.from(args).length > SESSION_COMMAND_LIMITS.args) return refuse('args-too-long')
  return { ok: true, command, args }
}
