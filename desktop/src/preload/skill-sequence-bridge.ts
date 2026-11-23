import type { DeckApi } from '@shared/types'

export interface SkillSequenceIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

export function skillSequenceBridge(
  ipc: SkillSequenceIpc
): Pick<DeckApi, 'runSessionSkill' | 'cancelSessionSequence' | 'overrideSessionQuiescence'> {
  return {
    runSessionSkill: (id, moment, mode) => ipc.invoke('skills:run', id, moment, mode) as ReturnType<DeckApi['runSessionSkill']>,
    cancelSessionSequence: (id) => ipc.invoke('sessions:sequence-cancel', id) as Promise<boolean>,
    overrideSessionQuiescence: (id) => ipc.invoke('sessions:sequence-override', id) as Promise<boolean>
  }
}
