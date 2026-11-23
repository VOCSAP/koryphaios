import type { SessionSkillRunResult } from '../shared/types'

export interface SkillSequenceChannelsService {
  runSkillSequence(id: unknown, moment: unknown, mode?: unknown): Promise<SessionSkillRunResult>
  cancelSequence(id: unknown): boolean
  overrideQuiescence(id: unknown): boolean
}

export function registerSkillSequenceChannels(
  regHandle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => void,
  service: SkillSequenceChannelsService
): void {
  regHandle('skills:run', (_e, id, moment, mode) => service.runSkillSequence(id, moment, mode))
  regHandle('sessions:sequence-cancel', (_e, id) => service.cancelSequence(id))
  regHandle('sessions:sequence-override', (_e, id) => service.overrideQuiescence(id))
}
