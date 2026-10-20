/**
 * Where this run stands between launch and quit, local to the run and never
 * persisted. Quitting is final: a startup approval answered after a quit intent
 * must not resume the launch, so nothing moves the state out of it.
 */

export type StartupPhase = 'bootstrap' | 'running' | 'quitting'

export interface StartupState {
  phase(): StartupPhase
  isQuitting(): boolean
  /** No effect once quitting. */
  markRunning(): void
  markQuitting(): void
}

export function createStartupState(): StartupState {
  let phase: StartupPhase = 'bootstrap'
  return {
    phase: () => phase,
    isQuitting: () => phase === 'quitting',
    markRunning: () => {
      if (phase === 'bootstrap') phase = 'running'
    },
    markQuitting: () => {
      phase = 'quitting'
    }
  }
}
