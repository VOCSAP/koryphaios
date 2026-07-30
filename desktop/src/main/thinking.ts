// PLACEHOLDER thinking heuristic (DESIGN §10). Deliberately temporary and
// non-deterministic: it scrapes the PTY output for Claude Code's "busy" cues
// (the "esc to interrupt" hint and the braille spinner) and debounces back to
// idle once the output stops changing. A hook-based, deterministic detector
// replaces this in Phase 2. Isolated in its own module so the rules can be
// tuned per Claude version or swapped out wholesale.

import { EventEmitter } from 'node:events'

export interface ThinkingEvent {
  id: string
  busy: boolean
}

// Strip ANSI CSI escape sequences (colours, cursor moves) so a marker wrapped
// in colour codes still matches. Only touches ESC-introduced sequences.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

// Busy cues: the input-box hint shown while a turn runs, plus braille spinner
// frames (U+2800..U+28FF).
const BUSY_RE = /esc to interrupt|[⠀-⣿]/i

const DEFAULT_IDLE_MS = 1500

/**
 * Tracks per-session busy/idle state from PTY output. Emits `thinking`
 * (ThinkingEvent) only on transitions. While busy markers keep arriving the
 * idle timer is re-armed, so a continuously redrawn spinner stays "busy" until
 * output stops, then flips idle after `idleMs`.
 */
export class ThinkingDetector extends EventEmitter {
  private busy = new Map<string, boolean>()
  private timers = new Map<string, NodeJS.Timeout>()

  constructor(private idleMs: number = DEFAULT_IDLE_MS) {
    super()
  }

  feed(id: string, data: string): void {
    if (!BUSY_RE.test(stripAnsi(data))) return
    this.setBusy(id, true)
    this.armIdle(id)
  }

  /** Forget a session (on exit/remove): cancel its timer, drop state. */
  clear(id: string): void {
    const t = this.timers.get(id)
    if (t) clearTimeout(t)
    this.timers.delete(id)
    this.busy.delete(id)
  }

  /** Cancel every pending idle timer (app shutdown). */
  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    this.busy.clear()
  }

  private armIdle(id: string): void {
    const existing = this.timers.get(id)
    if (existing) clearTimeout(existing)
    const t = setTimeout(() => {
      this.timers.delete(id)
      this.setBusy(id, false)
    }, this.idleMs)
    // Do not keep the event loop alive just for the idle flip.
    if (typeof t.unref === 'function') t.unref()
    this.timers.set(id, t)
  }

  private setBusy(id: string, busy: boolean): void {
    if (this.busy.get(id) === busy) return
    this.busy.set(id, busy)
    this.emit('thinking', { id, busy } satisfies ThinkingEvent)
  }
}
