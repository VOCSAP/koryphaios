// SUPERSEDED (card f8082208, 2026-08-26) by the frequency-based activity
// predicate in detect/activity.ts -- its transitions no longer feed
// RuntimeState or any consumer. Kept wired ONLY because two tests still
// anchor on it directly: tests/desktop-osc.test.ts's pinned pty.on('data')
// detector-field list, and tests/desktop-inject-command-modal-guard.test.ts's
// screenGuard-ordering probe. Real cost still paid for zero effect: BUSY_RE
// against every chunk (ANSI-stripped, OSC left untouched -- see
// EXEMPT_DETECTORS in desktop-osc.test.ts) and a re-armed 1500ms idle timer
// per session, on the hot PTY path.
//
// PLACEHOLDER thinking heuristic (DESIGN §10), history kept for context:
// deliberately temporary and non-deterministic, it scrapes the PTY output
// for Claude Code's "busy" cues (the "esc to interrupt" hint and the
// braille spinner) and debounces back to idle once the output stops
// changing. Isolated in its own module so the rules could be tuned per
// Claude version or swapped out wholesale -- which is exactly what
// happened, see above.

import { EventEmitter } from 'node:events'

export interface ThinkingEvent {
  id: string
  busy: boolean
}

// Strip ANSI CSI escape sequences (colours, cursor moves) so a marker wrapped
// in colour codes still matches. Only touches ESC-introduced sequences.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
// Exported only to support a test's own staleness check; this export does not
// change behaviour or add a consumer.
export function stripAnsi(s: string): string {
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
 * output stops, then flips idle after `idleMs`. SUPERSEDED (see module
 * header): still fed real bytes, but its emitted event has no listener in
 * production anymore.
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
