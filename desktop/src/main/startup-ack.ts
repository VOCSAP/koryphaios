// Auto-acknowledges Claude Code's development-channels warning
// (anthropics/claude-code#42486), since the Deck's own launch flags make every
// spawn stop on it until a human presses Enter.
// Requires both screen cues present before acking, fires once per process run,
// and sends a single Enter, never a digit, so a mis-detection at worst submits
// an empty prompt.
// The MCP-server consent dialog is never auto-acknowledged: its content is
// project-sourced, so that trust decision stays with the operator.

import { EventEmitter } from 'node:events'

export interface StartupAckEvent {
  id: string
}

// Strips both CSI and OSC sequences with one combined regex, re-run on the
// accumulated buffer in feed() so an OSC sequence split across two PTY chunks
// is still caught.
// The OSC branch's character class excludes ESC itself: that exclusion, not the
// length bound alongside it, prevents quadratic blowup on an adversarial buffer
// of unterminated OSC heads.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b\n]{0,4096}(?:\x07|\x1b\\))/g
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

/**
 * Both the dialog title and its accept option's wording must match.
 * \s* rather than literal spaces: the CLI's first paint of this dialog encodes
 * inter-word spaces as cursor-forward sequences, so after ANSI stripping the
 * title has no spaces at all; a later repaint uses literal spaces. \s* covers
 * both without missing the first frame.
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
    // Re-strip the accumulated buffer (not just the incoming per-chunk
    // delta): closes the cross-chunk OSC fragmentation gap, see the comment
    // on `stripAnsi` above.
    st.buf = stripAnsi((st.buf + stripAnsi(data)).slice(-MAX_BUF))
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
