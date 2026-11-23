import type { SessionSkillSettings } from '../shared/types'
import { checkConfiguredLine, type CommandLineRefusal } from '../shared/session-command-line'
import type { SequenceInput, SequenceStepInput } from './session-turn-runner'

export type SkillMoment = 'start' | 'end' | 'stop'
export type StopMode = 'soft' | 'hard'
export const SKILL_MOMENTS: readonly SkillMoment[] = ['start', 'end', 'stop']

/** The engine's name of each native skill, without its slash: typed by the Deck and expected back in the turn signal. */
export const NATIVE_COMMANDS = {
  start: 'claude-peers-deck-lead:kory-session-start',
  end: 'claude-peers-deck-lead:kory-session-end',
  stop: 'claude-peers-deck-lead:kory-session-stop'
} as const satisfies Record<SkillMoment, string>

export { BUILTIN_COMMAND_TABLES } from '../shared/session-command-line'

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
    const checked = checkConfiguredLine(line)
    if (!checked.ok) return { refused: true, reason: checked.reason, moment, line: index + 1 }
    const { command, args, commandClass } = checked
    steps.push(args === '' ? { command, commandClass } : { command, args, commandClass })
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
  const steps = moment === 'start' ? [...configured, native] : [native, ...configured]
  return moment === 'stop' ? { moment, mode, steps } : { moment, steps }
}
