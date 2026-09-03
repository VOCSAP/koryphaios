// Frequency of the OSC title counter decides activity, never the title text
// itself; this module never reads a title string or imports a clock of its own.
// Ternary, not boolean: an agent kind that never paints an OSC 0 title reads as
// 'unknown' forever rather than silently decaying to 'idle', so a fleet-stop
// cannot silently forget those tiles.
// Front-edge, not level: every observed titleSeq increase re-arms the idle
// timer, so 'working' extends past the last increase rather than requiring one
// right now.

export type Activity = 'working' | 'idle' | 'unknown'

export interface ActivityTrackerOptions<T> {
  /** Milliseconds of silence (no titleSeq increase) before 'working' decays to 'idle'. */
  idleMs: number
  /** Injectable clock -- unused by the tracker itself (observe() is called
   *  by the caller's own clock-driven loop), kept on the options shape so a
   *  future refinement that needs "now" has nowhere else to smuggle a real
   *  Date.now() in. */
  now: () => number
  /** Injectable timer primitives -- see the module header. */
  setTimer: (fn: () => void, ms: number) => T
  clearTimer: (t: T) => void
}

/**
 * Default idle threshold (design doc section 4): DELIBERATELY identical to
 * the byte-recency threshold `waitIdle` uses in session-service.ts -- the
 * design doc is explicit that a third, different number must not be
 * introduced. Callers of both share this one constant.
 */
export const ACTIVITY_IDLE_MS = 3000

/**
 * One tracker per session id (same per-instance-Map shape as
 * detect/osc.ts's createOscParser -- no module-level mutable state
 * anywhere in this file, so two sessions can never share a timer or a
 * sequence number even if their chunks arrive interleaved).
 */
export function createActivityTracker<T>(
  opts: ActivityTrackerOptions<T>
): {
  /** Feed the latest osc.ts titleSeq on every PTY chunk (unchanged values are a no-op). */
  observe(seq: number): void
  state(): Activity
  /** At most one listener; session-service.ts is this module's sole caller. */
  on(cb: (state: Activity) => void): void
  /** Cancel any pending idle timer (session exit/removal) -- no leaked timer keeps the event loop alive. */
  stop(): void
} {
  let state: Activity = 'unknown'
  let lastSeq = 0
  let timer: T | null = null
  let listener: ((state: Activity) => void) | null = null

  function setState(next: Activity): void {
    if (state === next) return
    state = next
    listener?.(state)
  }

  function armIdle(): void {
    if (timer !== null) opts.clearTimer(timer)
    timer = opts.setTimer(() => {
      timer = null
      setState('idle')
    }, opts.idleMs)
  }

  function observe(seq: number): void {
    // titleSeq starts at 0 in osc.ts and only increments on an applied
    // OSC 0/2 payload -- seq<=lastSeq (including the initial 0<=0) means
    // "nothing new happened", never "working". Strictly-greater is what
    // lets a genuine six-identical-titles burst (M4) still count as six
    // separate re-arms: osc.ts increments its counter on every applied
    // payload regardless of whether the title TEXT changed.
    if (seq <= lastSeq) return
    lastSeq = seq
    setState('working')
    armIdle()
  }

  function stop(): void {
    if (timer !== null) {
      opts.clearTimer(timer)
      timer = null
    }
  }

  return {
    observe,
    state: () => state,
    on: (cb) => {
      listener = cb
    },
    stop
  }
}
