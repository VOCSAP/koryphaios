import type { SessionSkillSettings } from '../shared/types'
import { validateCommandLine, type CommandLineRefusal } from '../shared/session-command-line'
import type { SequenceInput, SequenceStepInput } from './session-turn-runner'
import type { CommandClass } from './session-turn-sequence'

export type SkillMoment = 'start' | 'end' | 'stop'
export type StopMode = 'soft' | 'hard'
export const SKILL_MOMENTS: readonly SkillMoment[] = ['start', 'end', 'stop']

/** The engine's name of each native skill, without its slash: typed by the Deck and expected back in the turn signal. */
export const NATIVE_COMMANDS = {
  start: 'claude-peers-deck-lead:kory-session-start',
  end: 'claude-peers-deck-lead:kory-session-end',
  stop: 'claude-peers-deck-lead:kory-session-stop'
} as const satisfies Record<SkillMoment, string>

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

/** Every built-in table by the class it gives; a name sits in one table only. */
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

export interface SkillSequenceRefusal {
  refused: true
  reason: CommandLineRefusal | 'dialogue-command'
  moment: SkillMoment
  /** 1-based position of the refused line in the moment's list. */
  line: number
}

export type SkillSequenceResult = SequenceInput | SkillSequenceRefusal

function configuredSteps(moment: SkillMoment, settings: SessionSkillSettings): SequenceStepInput[] | SkillSequenceRefusal {
  const steps: SequenceStepInput[] = []
  for (const [index, line] of settings.commands[moment].entries()) {
    const parsed = validateCommandLine(line)
    if (!parsed.ok) return { refused: true, reason: parsed.reason, moment, line: index + 1 }
    const commandClass = classOf(parsed.command)
    if (commandClass === 'dialogue') return { refused: true, reason: 'dialogue-command', moment, line: index + 1 }
    steps.push(parsed.args === '' ? { command: parsed.command, commandClass } : { command: parsed.command, args: parsed.args, commandClass })
  }
  return steps
}

/** Every step is copied out of `settings`, so a plan is frozen once built. */
export function assembleSkillSequence(moment: 'start' | 'end', settings: SessionSkillSettings): SkillSequenceResult
export function assembleSkillSequence(moment: 'stop', settings: SessionSkillSettings, mode: StopMode): SkillSequenceResult
export function assembleSkillSequence(moment: SkillMoment, settings: SessionSkillSettings, mode?: StopMode): SkillSequenceResult {
  const configured = configuredSteps(moment, settings)
  if ('refused' in configured) return configured
  const native: SequenceStepInput =
    moment === 'stop' ? { command: NATIVE_COMMANDS.stop, args: mode, commandClass: 'skill' } : { command: NATIVE_COMMANDS[moment], commandClass: 'skill' }
  return { steps: moment === 'start' ? [...configured, native] : [native, ...configured] }
}
