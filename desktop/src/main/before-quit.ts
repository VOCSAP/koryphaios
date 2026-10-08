/**
 * Orchestration of the single shutdown pass, kept free of electron imports so
 * its failure modes are testable.
 *
 * Cancelling Electron's quit makes calling `quit` back the only exit, hence the
 * release armed in a `finally` around the effects and reached on every
 * settlement. Two latches, not one: a Quit commanded again during the
 * seconds-long release must be cancelled too, or the default quit overtakes the
 * release; passes are let through only once that release has settled.
 */

export type QuitErrorSink = (scope: string, message: string, error?: unknown) => void

export interface QuitEffect {
  /** Names the failing effect in the error trace. */
  readonly label: string
  readonly run: () => void | Promise<void>
  readonly timeoutMs?: number
}

export interface BeforeQuitPlan {
  readonly effects: readonly QuitEffect[]
  /** Bounded release of whatever outlives the window; may reject. */
  readonly release: () => Promise<unknown>
  readonly quit: () => void
  readonly onError: QuitErrorSink
}

function withinEffectDeadline(run: Promise<void>, timeoutMs: number | undefined): Promise<void> {
  if (timeoutMs === undefined) return run
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`quit effect timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([run, deadline]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * @returns a handler that runs the plan once and cancels every quit until its
 * own `quit` call is the one being served.
 */
export function createBeforeQuitHandler(
  plan: BeforeQuitPlan
): (preventDefault: () => void) => void {
  let started = false
  let allowQuit = false
  return (preventDefault) => {
    if (!allowQuit) preventDefault()
    if (started) return
    started = true
    const pendingEffects: Promise<void>[] = []
    try {
      for (const effect of plan.effects) {
        try {
          const run = effect.run()
          if (run) {
            pendingEffects.push(
              withinEffectDeadline(run, effect.timeoutMs).catch((error: unknown) => {
                plan.onError('main', `quit effect failed: ${effect.label}`, error)
              })
            )
          }
        } catch (error) {
          plan.onError('main', `quit effect failed: ${effect.label}`, error)
        }
      }
    } finally {
      void Promise.all(pendingEffects)
        .then(() => plan.release())
        .finally(() => {
          allowQuit = true
          try {
            plan.quit()
          } catch (error) {
            plan.onError('main', 'quit call failed', error)
          }
        })
        .catch((error: unknown) => plan.onError('main', 'quit release failed', error))
    }
  }
}
