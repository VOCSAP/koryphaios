// "Needs you" detection (PLAN C11). Claude Code stops and waits for the
// operator on several screens -- tool-permission prompts, plan approvals,
// trust prompts, multiple-choice questions. Nothing in the Deck surfaced
// that: with several tiles you had to eyeball them. Same pattern as quota.ts:
// a rolling ANSI-stripped buffer per session, conservative regexes, one
// episode at a time, closed as soon as a turn runs again (busy cues).

import { EventEmitter } from 'node:events'

export interface AttentionEvent {
  id: string
  waiting: boolean
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

// A running turn means the operator answered (or the wait screen is gone).
const BUSY_RE = /esc to interrupt|[⠀-⣿]/i

// Waiting screens, deliberately narrow: ONLY strong screen-level cues, since
// a running turn can stream prose/code containing question-like sentences.
// The numbered-chooser selector ("❯ 1.") covers tool-permission prompts, plan
// approvals and AskUserQuestion menus; the trust prompt has its own wording.
// Free-text questions without a menu are NOT detected (accepted v1 limit).
const WAITING_PATTERNS = [
  /❯\s*1\./, // selected first option of a numbered chooser
  /\bdo you trust the files\b/i
]

export function detectWaiting(text: string): boolean {
  return WAITING_PATTERNS.some((re) => re.test(text))
}

const MAX_BUF = 4096

interface SessionState {
  buf: string
  waiting: boolean
}

/**
 * Tracks per-session "waiting for the operator" episodes from PTY output.
 * Emits 'attention' (AttentionEvent) on transitions only: waiting=true when a
 * wait screen is detected, waiting=false when a turn runs again.
 */
export class AttentionDetector extends EventEmitter {
  private sessions = new Map<string, SessionState>()

  feed(id: string, data: string): void {
    let st = this.sessions.get(id)
    if (!st) {
      st = { buf: '', waiting: false }
      this.sessions.set(id, st)
    }
    const stripped = stripAnsi(data)

    if (st.waiting) {
      if (BUSY_RE.test(stripped)) {
        st.waiting = false
        st.buf = ''
        this.emit('attention', { id, waiting: false } satisfies AttentionEvent)
      }
      return
    }

    // A busy cue invalidates the accumulated context (a wait screen never
    // coexists with a running turn) but the SAME chunk may already carry the
    // prompt that follows the turn's end -- so reset FIRST, then append.
    if (BUSY_RE.test(stripped)) st.buf = ''
    st.buf = (st.buf + stripped).slice(-MAX_BUF)
    if (detectWaiting(st.buf)) {
      st.waiting = true
      st.buf = ''
      this.emit('attention', { id, waiting: true } satisfies AttentionEvent)
    }
  }

  clear(id: string): void {
    this.sessions.delete(id)
  }

  stop(): void {
    this.sessions.clear()
  }
}
