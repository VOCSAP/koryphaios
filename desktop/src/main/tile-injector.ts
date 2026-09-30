// Command injection with one turn per tile: two directives never interleave
// their Escape and command writes, and magic_compact holds the tile for all of
// its steps. No electron or node-pty import, so it is unit-testable under bun.

import { logInfo, reportError } from './log'
import { encodeSubmittedKeystrokes } from './session-command'
import { DIRECTIVE_IDLE_WAIT_MS } from './directive-run'
import { MAGIC_TIMEOUT_MS } from './magic-compact'
import type { InjectGuardInspection, InjectGuardState } from './screen-model'
import type { DirectiveOutcome } from './session-service'

const DIRECTIVE_IDLE_POLL_MS = 500
const DIRECTIVE_SETTLE_MS = 120

/**
 * The longest a turn may hold its tile: the magic_compact sequence (two idle
 * waits around the banner wait) plus a margin. Past it the tile's queue is
 * released, so a turn that never settles cannot block the tile for good.
 */
export const TURN_CEILING_MS = 2 * DIRECTIVE_IDLE_WAIT_MS + MAGIC_TIMEOUT_MS + 60_000

export interface InjectorTerminal {
  isAlive(id: string): boolean
  write(id: string, data: string): boolean
}

export interface InjectorScreen {
  inspect(id: string): InjectGuardInspection
  classify(id: string): InjectGuardState
}

export interface InjectorRuntime {
  get(id: string): { needsAttention?: boolean; rateLimited?: boolean } | undefined
}

export interface InjectorTiming {
  settleMs: number
  idlePollMs: number
  activityIdleMs: number
  turnCeilingMs: number
}

export type InTurnInject = (command: string, idleWaitMs?: number) => Promise<DirectiveOutcome>

export class TileInjector {
  private readonly turns = new Map<string, Promise<void>>()
  private readonly timing: InjectorTiming

  constructor(
    private readonly pty: InjectorTerminal,
    private readonly screenGuard: InjectorScreen,
    private readonly runtime: InjectorRuntime,
    private readonly lastOutputAt: (id: string) => number | null,
    timing: Partial<InjectorTiming> & { activityIdleMs: number },
    private readonly report: (message: string) => void = (message) => reportError('session', message),
    private readonly info: (scope: string, message: string) => void = logInfo
  ) {
    this.timing = {
      settleMs: timing.settleMs ?? DIRECTIVE_SETTLE_MS,
      idlePollMs: timing.idlePollMs ?? DIRECTIVE_IDLE_POLL_MS,
      activityIdleMs: timing.activityIdleMs,
      turnCeilingMs: timing.turnCeilingMs ?? TURN_CEILING_MS
    }
  }

  /**
   * Runs `fn` after every earlier turn of tile `id` has settled, whatever its
   * outcome, or has held the tile past the turn ceiling.
   */
  inTurn<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.turns.get(id) ?? Promise.resolve()
    let release!: () => void
    const settled = new Promise<void>((resolve) => {
      release = resolve
    })
    const run = previous.then(() => {
      const ceiling = setTimeout(() => {
        this.report(`injection turn of tile ${id} still running after ${this.timing.turnCeilingMs} ms; its queue is released`)
        release()
      }, this.timing.turnCeilingMs)
      if (typeof ceiling.unref === 'function') ceiling.unref()
      const done = () => {
        clearTimeout(ceiling)
        release()
      }
      const turn = Promise.resolve().then(fn)
      turn.then(done, done)
      return turn
    })
    this.turns.set(id, settled)
    void settled.then(() => {
      if (this.turns.get(id) === settled) this.turns.delete(id)
    })
    return run
  }

  /**
   * One turn for a whole sequence; `inject` writes into the tile without taking
   * another turn. Its idle wait is capped at DIRECTIVE_IDLE_WAIT_MS, which is
   * what TURN_CEILING_MS is sized on.
   */
  serializeTile<T>(id: string, fn: (inject: InTurnInject) => Promise<T>): Promise<T> {
    return this.inTurn(id, () =>
      fn((command, idleWaitMs = DIRECTIVE_IDLE_WAIT_MS) =>
        this.injectCommand(id, command, Math.min(idleWaitMs, DIRECTIVE_IDLE_WAIT_MS))
      )
    )
  }

  /**
   * Types a command the way the operator would: dismiss any open menu, settle,
   * then one write carrying the text and its submit keystroke, only once the
   * tile is idle ('busy-timeout' past the deadline). Takes no turn itself:
   * callers go through inTurn or serializeTile, except the operator's stop.
   */
  async injectCommand(
    id: string,
    command: string,
    idleWaitMs: number = DIRECTIVE_IDLE_WAIT_MS
  ): Promise<DirectiveOutcome> {
    if (!this.pty.isAlive(id)) return 'no-terminal'
    const idle = await this.waitIdle(id, idleWaitMs)
    if (!this.pty.isAlive(id)) return 'no-terminal'
    if (!idle) return 'busy-timeout'
    // Escape or pasted text can change a modal selection, so every refusal blocks both writes.
    const guard = this.screenGuard.inspect(id)
    if (guard.state === 'modal') {
      const line = guard.line === undefined ? '' : ` at line ${guard.line}`
      this.info('session', `command injection refused-modal for ${id}: screen guard ${guard.rule}${line}`)
      return 'refused-modal'
    }
    if (this.runtime.get(id)?.needsAttention) {
      logInfo('session', `command injection refused-modal for ${id}: needs attention`)
      return 'refused-modal'
    }
    if (this.runtime.get(id)?.rateLimited) {
      logInfo('session', `command injection refused-modal for ${id}: rate limited`)
      return 'refused-modal'
    }
    this.pty.write(id, '\x1b')
    await new Promise((res) => setTimeout(res, this.timing.settleMs))
    if (!this.pty.isAlive(id)) return 'no-terminal'
    // One write, bracketed-paste wrapped, with the CR inside the same string:
    // two separate writes did not submit, because ConPTY coalesces them into
    // one read and the CLI only turns a control byte into Enter when the whole
    // read is under 64 characters. Do not split it or add a delay.
    // write()'s own return value is consulted: isAlive only proves liveness at
    // that instant, not for this write.
    if (!this.pty.write(id, encodeSubmittedKeystrokes(command))) return 'no-terminal'
    // 'written' means pty.write() returned true for bytes shaped like a main-prompt
    // submission, not that the terminal accepted them in every UI state.
    // On a modal dialog, a bare Escape quits the CLI outright, while the paste
    // alone confirms whichever option is highlighted; the screen-state guard
    // above is what stops both from reaching the dialog.
    return 'written'
  }

  /**
   * True once the PTY has been quiet for the activity idle time, false at the
   * deadline. Byte recency, not RuntimeState.activity: OSC 0 stays silent while
   * the operator types. A session with no output yet counts as idle.
   */
  private async waitIdle(id: string, deadlineMs: number): Promise<boolean> {
    const deadline = Date.now() + deadlineMs
    for (;;) {
      const r = this.runtime.get(id)
      if (!r) return false
      const last = this.lastOutputAt(id)
      if (last === null || Date.now() - last >= this.timing.activityIdleMs) return true
      if (Date.now() >= deadline) return false
      await new Promise((res) => setTimeout(res, this.timing.idlePollMs))
    }
  }
}
