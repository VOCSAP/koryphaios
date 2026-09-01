// Graceful close routine for a peer session (DESIGN 6.6).
// Escalation: write "/exit" -> if still alive, Esc + Ctrl+C + retry "/exit" ->
// if still alive, SIGTERM (the peer side is cleaned by server.ts on its end).
//
// Pure: all IO (write to PTY, liveness check, kill, delay) is injected, so the
// escalation logic is unit-testable under bun without a real terminal. No
// module imports at all (not even node builtins) -- setTimeout used below for
// the absolute-deadline safety net is a global, not an import.
//
// Card 032bdeae: gracefulClose's ORIGINAL signature (write/isAlive/kill/delay,
// exitGraceMs/interruptGraceMs) is UNCHANGED -- the 4 tests in
// tests/desktop-workspace.test.ts:931-994 call it exactly as before and their
// outcomes/write-sequences are untouched. Everything below is new OPTIONAL
// fields that only activate when a caller (session-service.ts) supplies them.

export type CloseOutcome = 'exit' | 'interrupt' | 'sigterm' | 'modal' | 'forced' | 'deadline'

export interface GracefulCloseOpts {
  /** Write raw bytes to the session PTY. */
  write: (data: string) => void
  /** Is the session process still alive? */
  isAlive: () => boolean
  /** Last resort: send SIGTERM. */
  kill: () => void
  /** Await a delay (real: setTimeout; tests: a controllable fake). */
  delay: (ms: number) => Promise<void>
  /** Grace after the first "/exit" before escalating. Default 1500ms. */
  exitGraceMs?: number
  /** Grace after Esc/Ctrl+C + retry "/exit" before SIGTERM. Default 1500ms. */
  interruptGraceMs?: number
  /**
   * Poll cadence while waiting out a stage's grace period. Default 100ms.
   * Card 032bdeae: the ORIGINAL implementation only ever called `isAlive()`
   * once, AFTER the full grace delay had elapsed -- a session that died in
   * 80ms still cost the full 1500ms of perceived latency. Polling closes
   * that gap for every caller, old and new, without changing any outcome
   * the 4 pre-existing tests assert on (their fake `delay` resolves
   * instantly regardless of the ms argument).
   */
  pollMs?: number
  /**
   * Card 032bdeae: checked ONCE, before the very first write. When true, the
   * whole escalation is skipped -- kill() only, zero writes. Exists because a
   * blind "/exit\n" landing on a modal/confirmation screen can silently
   * confirm whichever option is highlighted (session-service.ts's own
   * screen-guard comment on injectCommand has the measurement); this is the
   * gate that keeps a wired gracefulClose from being a regression on those
   * tiles relative to today's bare kill.
   */
  isModal?: () => boolean
  /**
   * Card 032bdeae: polled during every grace-period wait. When true, the
   * escalation stops writing further stages and jumps straight to kill() --
   * this is what lets a SECOND close request on the same session force an
   * immediate stop instead of racing a second write onto the same pty.
   */
  isClosingForced?: () => boolean
  /**
   * Card 032bdeae: called exactly once, regardless of which path this
   * function took to finish (normal completion of any stage, the modal
   * pre-check, a forced short-circuit, a thrown write()/isAlive(), or the
   * absolute-deadline safety net below) -- MUST be idempotent, since the
   * deadline path and the normal path can both end up calling it under a
   * genuine race. Intended for the caller's own full teardown (beyond the
   * bare pty kill that `kill` performs).
   */
  cleanup?: () => void
  /**
   * Card 032bdeae, filet (b): a hard ceiling across the WHOLE escalation,
   * independent of exitGraceMs/interruptGraceMs. This is the ONLY safety net
   * that survives a `delay()` that never resolves -- in that case the
   * escalation's own try/finally is permanently stuck awaiting that promise
   * and never reaches its own cleanup, so this uses a REAL timer
   * (`setTimeout`, not the injected `delay`) racing independently against it.
   * Undefined (no timer armed) preserves the bare function's old behavior.
   */
  absoluteDeadlineMs?: number
}

const EXIT = '/exit\n'
const ESC = '\x1b'
const CTRL_C = '\x03'

/** 'dead' -> stop escalating (process died). 'forced' -> stop escalating (a concurrent second close won the race). 'alive' -> proceed to the next stage. */
type WaitResult = 'dead' | 'alive' | 'forced'

/** Poll isAlive()/isClosingForced() every `pollMs` for up to `budgetMs`. */
async function waitOut(
  opts: Pick<GracefulCloseOpts, 'isAlive' | 'isClosingForced' | 'delay'>,
  budgetMs: number,
  pollMs: number
): Promise<WaitResult> {
  let elapsed = 0
  for (;;) {
    if (opts.isClosingForced?.()) return 'forced'
    if (!opts.isAlive()) return 'dead'
    if (elapsed >= budgetMs) return 'alive'
    const step = Math.min(pollMs, budgetMs - elapsed)
    await opts.delay(step)
    elapsed += step
  }
}

async function escalate(opts: GracefulCloseOpts): Promise<CloseOutcome> {
  const exitGraceMs = opts.exitGraceMs ?? 1500
  const interruptGraceMs = opts.interruptGraceMs ?? 1500
  const pollMs = opts.pollMs ?? 100

  if (!opts.isAlive()) return 'exit'

  // Card 032bdeae: modal pre-check, t0 only, zero writes either way.
  if (opts.isModal?.()) {
    opts.kill()
    return 'modal'
  }

  // 1. Ask Claude to exit cleanly.
  opts.write(EXIT)
  let r = await waitOut(opts, exitGraceMs, pollMs)
  if (r === 'forced') {
    opts.kill()
    return 'forced'
  }
  if (r === 'dead') return 'exit'

  // 2. Interrupt any in-progress prompt, then retry the clean exit.
  opts.write(ESC)
  opts.write(CTRL_C)
  opts.write(EXIT)
  r = await waitOut(opts, interruptGraceMs, pollMs)
  if (r === 'forced') {
    opts.kill()
    return 'forced'
  }
  if (r === 'dead') return 'interrupt'

  // 3. Last resort.
  opts.kill()
  return 'sigterm'
}

/**
 * Close a session as gently as possible. Returns how it actually stopped:
 * 'exit' (died after /exit), 'interrupt' (died after Esc/Ctrl+C), 'sigterm'
 * (only kill() stopped it), 'modal' (skipped straight to kill(), t0 guard),
 * 'forced' (a concurrent second close won the race), or 'deadline' (the
 * absolute-deadline safety net fired). Stops early as soon as `isAlive()`
 * reports false.
 */
export async function gracefulClose(opts: GracefulCloseOpts): Promise<CloseOutcome> {
  const run = async (): Promise<CloseOutcome> => {
    try {
      return await escalate(opts)
    } catch {
      // Card 032bdeae, filet (a): a thrown write()/isAlive() must not leave
      // the pty running -- force the last-resort kill this escalation would
      // otherwise have reached on its own. Deliberately NOT unconditional on
      // every outcome (only on a throw): the 4 pre-existing tests assert
      // kill() is NEVER called on a clean 'exit'/'interrupt', by making their
      // fake kill() throw if invoked -- an unconditional finally-kill would
      // break that guarantee.
      opts.kill()
      return 'sigterm'
    } finally {
      opts.cleanup?.()
    }
  }

  if (opts.absoluteDeadlineMs === undefined) return run()

  // Deliberately not a bare Promise.race: without clearing the timer, a
  // NORMAL early completion would still leave the deadline callback pending,
  // firing a redundant kill()/cleanup() later. `settled` + `clearTimeout`
  // make exactly one of the two paths act.
  return new Promise<CloseOutcome>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      opts.kill()
      opts.cleanup?.()
      resolve('deadline')
    }, opts.absoluteDeadlineMs)
    void run().then((outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    })
  })
}
