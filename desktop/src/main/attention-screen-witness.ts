import type { XtermScreenRead, XtermScreenUnavailableReason } from './xterm-screen'

// A resize repaint leaves a blank screen for ~9 ms. Only reads spread over the
// window may veto, so one blank read cannot drop a dialog that is still open.
export const WITNESS_WINDOW_MS = 100
export const WITNESS_PERIOD_MS = 10
const MIN_READY_READS = 6
const RECENT_READS = 3
const MIN_SPAN_MS = WITNESS_WINDOW_MS / 2

// pending/incomplete say nothing about the screen; a pre-reflow, faulted or
// missing screen is no proof the wait screen is gone.
export const UNAVAILABLE_READ = {
  'screen-pending': 'ignore',
  'sequence-incomplete': 'ignore',
  'resize-pending': 'abstain',
  'screen-fault': 'abstain',
  disposed: 'abstain'
} as const satisfies Record<XtermScreenUnavailableReason, 'ignore' | 'abstain'>

type Observation = 'no-wait' | 'wait' | 'ignore' | 'abstain'

interface Read {
  observation: Observation
  at: number
}

export interface ScreenWitnessTimers {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(timer: unknown): void
}

export interface ScreenWitnessWindow {
  /** Takes the read at the deadline; true means the raise must be dropped. */
  decide(): boolean
  cancel(): void
}

export interface ScreenWitness {
  arm(id: string, delayMs: number, timers: ScreenWitnessTimers): ScreenWitnessWindow
}

export interface ScreenWitnessDeps {
  read(id: string): XtermScreenRead
  now(): number
  showsWait(text: string): boolean
  reportError(scope: string, message: string, error?: unknown): void
}

export function createScreenWitness(deps: ScreenWitnessDeps): ScreenWitness {
  const observe = (id: string): Observation => {
    let read: XtermScreenRead
    try {
      read = deps.read(id)
    } catch (error) {
      deps.reportError('attention', 'screen witness read failed', error)
      return 'abstain'
    }
    if (read.status === 'unavailable') return UNAVAILABLE_READ[read.reason]
    return deps.showsWait(read.snapshot.lines.join('\n')) ? 'wait' : 'no-wait'
  }

  return {
    arm(id, delayMs, timers) {
      const reads: Read[] = []
      const handles: unknown[] = []
      const take = (): void => {
        const observation = observe(id)
        reads.push({ observation, at: deps.now() })
      }
      for (let at = delayMs - WITNESS_WINDOW_MS; at < delayMs; at += WITNESS_PERIOD_MS) {
        handles.push(timers.setTimeout(take, Math.max(0, at)))
      }
      return {
        decide() {
          take()
          if (reads.some((r) => r.observation === 'wait' || r.observation === 'abstain')) return false
          const quiet = reads.filter((r) => r.observation === 'no-wait')
          if (quiet.length < MIN_READY_READS) return false
          if (!reads.slice(-RECENT_READS).some((r) => r.observation === 'no-wait')) return false
          return quiet[quiet.length - 1]!.at - quiet[0]!.at >= MIN_SPAN_MS
        },
        cancel() {
          for (const handle of handles) timers.clearTimeout(handle)
        }
      }
    }
  }
}
