// Pure activity predicate over OSC 0/2 emission FREQUENCY. Card f8082208 /
// docs/DESIGN-ACTIVITY-PREDICATE.md, verdict rendered 2026-08-26. No
// electron/node-pty import -- unit-testable directly under bun, same
// discipline as detect/osc.ts.
//
// VERDICT this module encodes: the FREQUENCY of osc.ts's titleSeq counter
// decides, the title TEXT decides nothing. A caller feeds observe() the
// latest titleSeq (desktop/src/main/detect/osc.ts's OscSnapshot field) on
// every PTY chunk -- this module never reads a title string or a glyph, and
// never imports a clock of its own (see the injected `now`/`setTimer`/
// `clearTimer` below).
//
// TERNARY BY DESIGN, never a boolean (design doc section 6, "audit de
// couverture"). An agent-kind that paints no OSC 0 title at all (codex,
// gemini, a bare shell, a sandbox session -- unmeasured, assumed) must read
// as 'unknown' FOREVER, never silently decay to 'idle': a boolean has no
// such state, which is exactly what would make that degradation invisible
// -- no error, no red test, just a badge that never lights and a fleet-stop
// that silently forgets those tiles. 'idle' is reachable ONLY after at
// least one real observation (state starts 'unknown' and stays there until
// the first titleSeq increase is observed).
//
// FRONT-EDGE, never LEVEL (design doc's own M4 measurement: a six-emission
// burst followed by silence). Every OBSERVED titleSeq increase re-arms the
// idle timer from the moment it is observed -- 'working' extends idleMs
// PAST THE LAST increase, never just "is a title arriving right now".
//
// INJECTED CLOCK (design doc section 7, the obligatory difference from
// thinking.ts's ThinkingDetector): the caller's wiring becomes pure and
// replayable against a real PTY fixture's own recorded timestamps, with no
// real setTimeout/Date.now() involved in a test.

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
