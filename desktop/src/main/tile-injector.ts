// Command injection with one turn per tile: two directives never interleave
// their Escape and command writes, and magic_compact holds the tile for all of
// its steps. No electron or node-pty import, so it is unit-testable under bun.

import { logInfo, reportError } from './log'
import { encodeSubmittedKeystrokes } from './session-command'
import { DIRECTIVE_IDLE_WAIT_MS } from './directive-run'
import { MAGIC_TIMEOUT_MS } from './magic-compact'
import { composerState, inspectInjectGuard, type XtermScreenRead } from './xterm-screen'
import type { DirectiveOutcome, InjectRefusal } from './session-service'

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
  life(id: string): object | null
  write(id: string, data: string): boolean
}

export interface InjectorScreen {
  read(id: string): XtermScreenRead
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

export interface InjectorClock {
  now(): number
  setTimeout(callback: () => void, delay: number): NodeJS.Timeout
  clearTimeout(timer: NodeJS.Timeout): void
}

export type InTurnInject = (command: string, idleWaitMs?: number) => Promise<DirectiveOutcome>

export interface InjectCommandOptions {
  /** False types the command with no Escape first, for a caller that has already proven the screen. */
  escape?: boolean
}

export interface HoldInjectOptions extends InjectCommandOptions {
  idleWaitMs?: number
}

export interface TileHold {
  isCurrent: () => boolean
  /** Resolves with the reason given to `revokeHold`; stays pending when the hold ends any other way. */
  revoked: Promise<string>
  inject: (command: string, options?: HoldInjectOptions) => Promise<DirectiveOutcome>
}

export class TileInjector {
  private readonly turns = new Map<string, Promise<void>>()
  private readonly turnGenerations = new Map<string, object>()
  private readonly holds = new Map<string, { generation: object; done: () => void; onRevoke: (reason: string) => void }>()
  private readonly revocations = new Map<string, { count: number; reason: string }>()
  private readonly holdGuards = new WeakSet<() => boolean>()
  private readonly timing: InjectorTiming

  constructor(
    private readonly pty: InjectorTerminal,
    private readonly screenGuard: InjectorScreen,
    private readonly runtime: InjectorRuntime,
    private readonly lastOutputAt: (id: string) => number | null,
    timing: Partial<InjectorTiming> & { activityIdleMs: number },
    private readonly report: (message: string) => void = (message) => reportError('session', message),
    private readonly info: (scope: string, message: string) => void = logInfo,
    private readonly clock: InjectorClock = { now: () => Date.now(), setTimeout, clearTimeout }
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
   * outcome, or has held the tile past the turn ceiling. A turn queued behind a
   * hold has no bound: it waits for the hold to settle or be revoked.
   */
  inTurn<T>(id: string, fn: (isCurrent: () => boolean) => Promise<T>): Promise<T> {
    return this.takeTurn(id, fn)
  }

  /**
   * A turn with no ceiling, for a sequence that waits on events, not on the
   * clock. It ends when `fn` settles or on `revokeHold`; its writes are refused
   * from then on, like a turn released at its ceiling. `inject` also refuses
   * ('no-terminal') once the tile runs another PTY than the one it had when
   * this was called, not when the hold starts.
   */
  holdTile<T>(id: string, fn: (hold: TileHold) => Promise<T>): Promise<T> {
    let onRevoke!: (reason: string) => void
    const revoked = new Promise<string>((resolve) => {
      onRevoke = resolve
    })
    const life = this.pty.life(id)
    const revokedAtCall = this.revocations.get(id)?.count ?? 0
    return this.takeTurn(
      id,
      (isCurrent) => {
        const revocation = this.revocations.get(id)
        if (revocation && revocation.count !== revokedAtCall) {
          this.info('session', `hold of tile ${id} started revoked: ${revocation.reason}`)
          this.holds.get(id)?.done()
          onRevoke(revocation.reason)
        }
        return fn({
          isCurrent,
          revoked,
          inject: async (command, options = {}) => {
            if (!isCurrent()) throw this.staleTurn(id)
            if (life === null || this.pty.life(id) !== life) return 'no-terminal'
            return this.injectCommand(id, command, options.idleWaitMs ?? DIRECTIVE_IDLE_WAIT_MS, isCurrent, {
              escape: options.escape
            })
          }
        })
      },
      onRevoke
    )
  }

  /**
   * Ends the running hold of tile `id`: its generation goes first, then the
   * next turn is released. Every hold already queued when this is called
   * starts revoked and writes nothing. True only when a hold was running; an
   * inTurn turn is never revoked.
   */
  revokeHold(id: string, reason: string): boolean {
    this.revocations.set(id, { count: (this.revocations.get(id)?.count ?? 0) + 1, reason })
    const hold = this.holds.get(id)
    if (!hold) return false
    this.info('session', `hold of tile ${id} revoked: ${reason}`)
    hold.done()
    hold.onRevoke(reason)
    return true
  }

  /** A turn with `onRevoke` is a hold: no ceiling, revocable. Without it, it is released at the ceiling. */
  private takeTurn<T>(id: string, fn: (isCurrent: () => boolean) => Promise<T>, onRevoke?: (reason: string) => void): Promise<T> {
    const previous = this.turns.get(id) ?? Promise.resolve()
    let release!: () => void
    const settled = new Promise<void>((resolve) => {
      release = resolve
    })
    const run = previous.then(() => {
      const generation = {}
      this.turnGenerations.set(id, generation)
      let ceiling: NodeJS.Timeout | undefined
      const done = () => {
        if (ceiling) this.clock.clearTimeout(ceiling)
        if (this.turnGenerations.get(id) === generation) this.turnGenerations.delete(id)
        if (this.holds.get(id)?.generation === generation) this.holds.delete(id)
        release()
      }
      if (onRevoke === undefined) {
        ceiling = this.clock.setTimeout(() => {
          this.report(`injection turn of tile ${id} still running after ${this.timing.turnCeilingMs} ms; its queue is released`)
          done()
        }, this.timing.turnCeilingMs)
        if (typeof ceiling.unref === 'function') ceiling.unref()
      } else {
        this.holds.set(id, { generation, done, onRevoke })
      }
      const isCurrent = () => this.turnGenerations.get(id) === generation
      if (onRevoke !== undefined) this.holdGuards.add(isCurrent)
      const turn = Promise.resolve().then(() => fn(isCurrent))
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
    return this.inTurn(id, (isCurrent) =>
      fn((command, idleWaitMs = DIRECTIVE_IDLE_WAIT_MS) =>
        this.injectCommand(id, command, Math.min(idleWaitMs, DIRECTIVE_IDLE_WAIT_MS), isCurrent)
      )
    )
  }

  /**
   * Types a command the way the operator would: dismiss any open menu (unless
   * `options.escape` is false), settle, then one write carrying the text and
   * its submit keystroke, only once the tile is idle ('busy-timeout' past the
   * deadline). With `escape` false the composer is read once more right before
   * the write and must be empty, or the outcome is 'refused-modal'. Takes no
   * turn itself: callers go through inTurn, serializeTile or holdTile, except
   * the operator's stop.
   */
  async injectCommand(
    id: string,
    command: string,
    idleWaitMs: number = DIRECTIVE_IDLE_WAIT_MS,
    isCurrent?: () => boolean,
    options?: InjectCommandOptions
  ): Promise<DirectiveOutcome> {
    if (isCurrent && !isCurrent()) throw this.staleTurn(id)
    if (!this.pty.isAlive(id)) return 'no-terminal'
    const life = this.pty.life(id)
    if (!life) return 'no-terminal'
    const idle = await this.waitIdle(id, idleWaitMs)
    if (isCurrent && !isCurrent()) throw this.staleTurn(id, this.holdGuards.has(isCurrent))
    if (!this.pty.isAlive(id) || this.pty.life(id) !== life) return 'no-terminal'
    if (!idle) return 'busy-timeout'
    const firstRefusal = this.refusal(id)
    if (firstRefusal) return firstRefusal
    if (options?.escape !== false) {
      if (isCurrent && !isCurrent()) throw this.staleTurn(id)
      if (!this.pty.write(id, '\x1b')) return 'no-terminal'
      await new Promise<void>((res) => this.clock.setTimeout(res, this.timing.settleMs))
      if (isCurrent && !isCurrent()) throw this.staleTurn(id, this.holdGuards.has(isCurrent))
      if (!this.pty.isAlive(id) || this.pty.life(id) !== life) return 'no-terminal'
      const secondRefusal = this.refusal(id)
      if (secondRefusal) return secondRefusal
    }
    if (isCurrent && !isCurrent()) throw this.staleTurn(id)
    if (options?.escape === false) {
      const draft = this.draftRefusal(id)
      if (draft) return draft
    }
    if (!this.pty.write(id, encodeSubmittedKeystrokes(command))) return 'no-terminal'
    return 'written'
  }

  /** The screen read just before a write that sends no Escape: only an empty composer takes the command. */
  private draftRefusal(id: string): InjectRefusal | null {
    const screen = this.screenGuard.read(id)
    if (screen.status === 'unavailable') {
      this.info('session', `command injection screen-unavailable for ${id}: ${screen.reason}`)
      return 'screen-unavailable'
    }
    const state = composerState(screen.snapshot)
    if (state === 'empty') return null
    this.info('session', `command injection refused-modal for ${id}: draft-present, composer ${state}`)
    return 'refused-modal'
  }

  /** `ended`: a hold's own caller ended it while an injection waited, so the refusal is a log line, not an error. */
  private staleTurn(id: string, ended = false): Error {
    const error = new Error(`injection callback refused for ${id}: its turn is no longer current`)
    if (ended) this.info('session', error.message)
    else this.report(error.message)
    return error
  }

  private refusal(id: string): InjectRefusal | null {
    const screen = this.screenGuard.read(id)
    if (screen.status === 'unavailable') {
      this.info('session', `command injection screen-unavailable for ${id}: ${screen.reason}`)
      return 'screen-unavailable'
    }
    const guard = inspectInjectGuard(screen.snapshot)
    if (guard.state === 'modal') {
      const line = guard.line === undefined ? '' : ` at line ${guard.line}`
      this.info('session', `command injection refused-modal for ${id}: screen guard ${guard.rule}${line}`)
      return 'refused-modal'
    }
    if (this.runtime.get(id)?.needsAttention) {
      this.info('session', `command injection needs-attention for ${id}`)
      return 'needs-attention'
    }
    if (this.runtime.get(id)?.rateLimited) {
      this.info('session', `command injection rate-limited for ${id}`)
      return 'rate-limited'
    }
    return null
  }

  /**
   * True once the PTY has been quiet for the activity idle time, false at the
   * deadline. Byte recency, not RuntimeState.activity: OSC 0 stays silent while
   * the operator types. A session with no output yet counts as idle.
   */
  private async waitIdle(id: string, deadlineMs: number): Promise<boolean> {
    const deadline = this.clock.now() + deadlineMs
    for (;;) {
      const r = this.runtime.get(id)
      if (!r) return false
      const last = this.lastOutputAt(id)
      if (last === null || this.clock.now() - last >= this.timing.activityIdleMs) return true
      if (this.clock.now() >= deadline) return false
      await new Promise<void>((res) => this.clock.setTimeout(res, this.timing.idlePollMs))
    }
  }
}
