// Hold-then-move gesture state machine (PLAN MB4 — EXPLORATION-mobile-lan §4,
// "grammaire gestuelle retenue"): long-press an item to SEIZE it, then
// - release without moving  -> 'options'  (the canonical action sheet)
// - move past the slop      -> 'detach'   (lift into the floating basket)
// - move before the hold    -> 'cancel'   (it was a scroll — never fight it)
//
// Pure logic, injectable clock via event timestamps: the component feeds
// pointer events in, renders from the phase, and reacts to the outcomes.
// The "peel the sticker" feel lives in the ANIMATION layer, not here — after
// seizure there are only two outcomes, so any movement means detach.

export interface HoldGestureConfig {
  /** Press duration (ms) before the item is seized. */
  holdMs: number
  /** Movement tolerance (px) while pressing; beyond it = scroll. */
  slopPx: number
  /** Movement (px) after seizure that triggers the detach. */
  detachPx: number
}

export const DEFAULT_HOLD_GESTURE: HoldGestureConfig = {
  holdMs: 450,
  slopPx: 10,
  detachPx: 12
}

export type HoldPhase = 'idle' | 'pressing' | 'held'

/** Outcome of feeding one event; 'none' means keep going. */
export type HoldOutcome = 'none' | 'seized' | 'options' | 'detach' | 'cancel'

export class HoldGesture {
  private phase: HoldPhase = 'idle'
  private x0 = 0
  private y0 = 0
  private t0 = 0

  constructor(private readonly cfg: HoldGestureConfig = DEFAULT_HOLD_GESTURE) {}

  get current(): HoldPhase {
    return this.phase
  }

  /** Pointer down at (x, y), timestamp t (ms). */
  down(x: number, y: number, t: number): HoldOutcome {
    this.phase = 'pressing'
    this.x0 = x
    this.y0 = y
    this.t0 = t
    return 'none'
  }

  /**
   * Pointer moved. While pressing, leaving the slop before the hold delay
   * cancels (scroll); the component checks `tick` for the hold promotion.
   * Once held, any move past detachPx detaches.
   */
  move(x: number, y: number, t: number): HoldOutcome {
    const dx = x - this.x0
    const dy = y - this.y0
    const dist = Math.hypot(dx, dy)
    switch (this.phase) {
      case 'pressing':
        if (dist > this.cfg.slopPx) {
          // Promotion race: a slow finger that ALREADY satisfied the hold
          // delay seizes on this very move instead of cancelling.
          if (t - this.t0 >= this.cfg.holdMs) {
            this.phase = 'held'
            return 'seized'
          }
          this.phase = 'idle'
          return 'cancel'
        }
        return this.tick(t)
      case 'held':
        if (dist > this.cfg.detachPx) {
          this.phase = 'idle'
          return 'detach'
        }
        return 'none'
      default:
        return 'none'
    }
  }

  /** Clock pulse (the component's hold timer): promotes pressing -> held. */
  tick(t: number): HoldOutcome {
    if (this.phase === 'pressing' && t - this.t0 >= this.cfg.holdMs) {
      this.phase = 'held'
      return 'seized'
    }
    return 'none'
  }

  /** Pointer released. */
  up(t: number): HoldOutcome {
    const phase = this.phase
    this.phase = 'idle'
    if (phase === 'held') return 'options'
    if (phase === 'pressing' && t - this.t0 >= this.cfg.holdMs) return 'options'
    return 'cancel'
  }

  /** External cancellation (pointercancel, scroll started, unmount). */
  cancel(): HoldOutcome {
    const wasActive = this.phase !== 'idle'
    this.phase = 'idle'
    return wasActive ? 'cancel' : 'none'
  }
}
