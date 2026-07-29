// Auto-acknowledgment of Claude Code's development-channels warning
// (anthropics/claude-code#42486): the channels flag the Deck's launch command
// passes (--dangerously-load-development-channels server:claude-peers) makes
// EVERY spawn — operator create, supervisor spawn, template, restart — stop on
// a full-screen warning dialog until a human presses Enter. The channel
// entries come from the operator's own launch command (C19-gated when
// project-sourced), so the Deck acknowledges its own flag automatically.
//
// Deliberately narrow, one keystroke:
// - BOTH screen cues must be present in the rolling buffer;
// - the ack fires ONCE per process run (re-armed by clear() on restart);
// - the service sends a single Enter — the dialog's default option is the
//   accept ("❯ 1. I am using this for local development"), and a
//   mis-detection can at worst submit an empty prompt. Never a digit: a "1"
//   landing on the WRONG dialog could pick a destructive option.
// - The MCP-server consent dialog ("New MCP server found in this project") is
//   NEVER auto-acknowledged: its content is project-sourced (hostile input
//   #1) — that trust decision stays with the operator.
//
// Same shape as attention.ts/quota.ts: ANSI-stripped rolling buffer per
// session, EventEmitter transitions, decisions stay in session-service.

import { EventEmitter } from 'node:events'

export interface StartupAckEvent {
  id: string
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

/**
 * Both must match: the dialog title AND its accept option's wording.
 *
 * `\s*` (zero or more) instead of literal spaces: the Windows ConPTY repaint
 * frame encodes inter-word spaces as cursor-forward sequences (`\x1b[1C`), so
 * after ANSI stripping the title reads `WARNING:Loadingdevelopmentchannels` --
 * space-anchored patterns can never match that frame (field capture,
 * 2026-07-28 audit). The joined form is specific enough that prose cannot
 * produce it by accident, and the two-cue requirement still holds.
 */
const CHANNELS_WARNING_PATTERNS = [
  /loading\s*development\s*channels/i,
  /I\s*am\s*using\s*this\s*for\s*local\s*development/i
]

export function detectChannelsWarning(text: string): boolean {
  return CHANNELS_WARNING_PATTERNS.every((re) => re.test(text))
}

const MAX_BUF = 4096

interface SessionState {
  buf: string
  /** Acked (or armed off) for this process run; clear() re-arms. */
  done: boolean
}

/**
 * Watches per-session PTY output for the development-channels warning screen
 * and emits 'ack' (StartupAckEvent) once per process run. The keystroke and
 * the liveness check belong to the caller (session-service).
 */
export class StartupAckDetector extends EventEmitter {
  private sessions = new Map<string, SessionState>()

  feed(id: string, data: string): void {
    let st = this.sessions.get(id)
    if (!st) {
      st = { buf: '', done: false }
      this.sessions.set(id, st)
    }
    if (st.done) return
    st.buf = (st.buf + stripAnsi(data)).slice(-MAX_BUF)
    if (detectChannelsWarning(st.buf)) {
      st.done = true
      st.buf = ''
      this.emit('ack', { id } satisfies StartupAckEvent)
    }
  }

  /** Fresh process (restart) or gone session: drop state, re-arm. */
  clear(id: string): void {
    this.sessions.delete(id)
  }

  /** Service teardown: drop all per-session state. */
  stop(): void {
    this.sessions.clear()
  }
}
