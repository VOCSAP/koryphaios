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

export function shouldQuitAfterAllWindowsClosed(platform: string, phase: StartupPhase): boolean {
  return platform !== 'darwin' && phase === 'running'
}

/**
 * A launch step that throws after ready: a run still in bootstrap has no window and window-all-closed will not
 * quit it, so it quits; a running Deck stays up, and a quitting one is already shutting down once.
 */
export function onStartupFailure(phase: StartupPhase, error: unknown, deps: { report(error: unknown): void; quit(): void }): void {
  deps.report(error)
  if (phase === 'bootstrap') deps.quit()
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
