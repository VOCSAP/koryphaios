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

export type CommandClass = 'skill' | 'compact' | 'locale' | 'dialogue'

// A name the Deck does not know is a skill: it gets a step token and is proven by its own turn.
const COMPACT_COMMANDS: ReadonlySet<string> = new Set(['compact'])
const LOCAL_COMMANDS: ReadonlySet<string> = new Set([
  'branch', 'btw', 'bug', 'cd', 'clear', 'color', 'context', 'copy', 'diff', 'feedback', 'focus', 'fork',
  'keybindings', 'list-agents', 'mcp', 'plan', 'recap', 'release-notes', 'reload-skills', 'rename', 'subtask',
  'terminal-setup'
])
// Interactive built-ins, and those that end the session, are refused: no step can finish them safely.
const DIALOGUE_COMMANDS: ReadonlySet<string> = new Set([
  'add-dir', 'auto-mode-setup', 'autocompact', 'config', 'effort', 'export', 'fast', 'goal', 'help', 'hooks', 'ide',
  'login', 'mobile', 'model', 'permissions', 'powerup', 'rewind', 'status', 'tasks', 'theme', 'usage', 'workflows',
  'background', 'exit', 'logout',
  'memory', 'output-style', 'plugin', 'radio', 'reload-plugins', 'resume', 'skills', 'stickers', 'team-onboarding', 'tui'
])

export const BUILTIN_COMMAND_TABLES: Readonly<Record<Exclude<CommandClass, 'skill'>, ReadonlySet<string>>> = {
  dialogue: DIALOGUE_COMMANDS,
  compact: COMPACT_COMMANDS,
  locale: LOCAL_COMMANDS
}

function classOf(command: string): CommandClass {
  const name = command.toLowerCase()
  if (DIALOGUE_COMMANDS.has(name)) return 'dialogue'
  if (COMPACT_COMMANDS.has(name)) return 'compact'
  if (LOCAL_COMMANDS.has(name)) return 'locale'
  return 'skill'
}

export type ConfiguredLineResult =
  | { ok: true; command: string; args: string; commandClass: Exclude<CommandClass, 'dialogue'> }
  | { ok: false; reason: CommandLineRefusal | 'dialogue-command' }

export function checkConfiguredLine(line: unknown): ConfiguredLineResult {
  const parsed = validateCommandLine(line)
  if (!parsed.ok) return parsed
  const commandClass = classOf(parsed.command)
  if (commandClass === 'dialogue') return { ok: false, reason: 'dialogue-command' }
  return { ok: true, command: parsed.command, args: parsed.args, commandClass }
}
