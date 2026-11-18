// "Needs you" detection (PLAN C11). Claude Code stops and waits for the
// operator on several screens -- tool-permission prompts, plan approvals,
// trust prompts, multiple-choice questions. Nothing in the Deck surfaced
// that: with several tiles you had to eyeball them. Same pattern as quota.ts:
// a rolling ANSI-stripped buffer per session, conservative regexes, one
// episode at a time, closed as soon as a turn runs again (busy cues).

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { detectChannelsWarning } from './startup-ack'
import { createBusyCue, type BusyCue } from './detect/busy'
import type { ScreenWitness, ScreenWitnessWindow } from './attention-screen-witness'
import { composerGeometryVisible, type XtermScreenRead, type XtermScreenSnapshot } from './xterm-screen'

export interface UnknownDialogPayload {
  title: string
  text: string
  truncated: boolean
}

export type AttentionSource = 'known' | 'unknown-dialog'

export interface AttentionEvent {
  id: string
  waiting: boolean
  /**
   * True only when the operator dismissed the flag by hand. Load-bearing:
   * index.ts reads `waiting: false` as "a turn ran, someone answered" and
   * claims the open remote approval, but a manual dismiss means the flag was
   * wrong, so the consumer skips claiming when this is set.
   */
  manual?: boolean
  /** Absent means 'known'. */
  source?: AttentionSource
  /** One per unknown-dialog episode; a fall carries the id of the episode it closes. */
  episodeId?: string
  /** Present on an unknown-dialog raise only, captured once on the confirming snapshot. */
  dialog?: UnknownDialogPayload
}

// Excludes ESC, not just BEL, from the OSC branch's character class: without
// it, an unterminated OSC head is quadratic on an adversarial buffer, and
// excluding ESC makes each new escape head halt the match immediately
// regardless of any length bound.
// The `{0,4096}` bound still matters separately, for memory on a plain-text OSC
// body with no ESC and no terminator.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b\n]{0,4096}(?:\x07|\x1b\\))/g
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

// Workspace trust prompt, both wordings. The current one ("Quick safety check")
// is an unnumbered chooser whose words, and on ConPTY whose rows, are placed by
// cursor moves the stripper deletes, hence `\s*` and no required line break;
// both options are required, in order, so prose saying "I trust this folder"
// does not raise. No `\b` after "folder": ConPTY glues it to the next row.
const TRUST_PATTERNS = [
  /\bdo you trust the files\b/i,
  /No,\s*exit\s*(?:\u276f\s*)?Yes,\s*I\s*trust\s*this\s*folder/i
]

// The welcome banner ("Claude Code v2.1.282"; cursor moves may eat the spaces)
// that the CLI paints once the trust prompt is accepted. Accepting runs no turn,
// so no busy cue ends that episode.
const WELCOME_BANNER_RE = /Claude\s*Code\s*v\d+\.\d+\.\d+/

/** The part of `text` after the first trust prompt in it, or null when it holds none. */
function afterTrustPrompt(text: string): string | null {
  for (const re of TRUST_PATTERNS) {
    const m = re.exec(text)
    if (m) return text.slice(m.index + m[0].length)
  }
  return null
}

// The 2.1.229 prompt numbers its options with "Yes" first and highlighted, so no
// TRUST_PATTERNS entry (which expects "No, exit" first) matches it.
const NUMBERED_TRUST_RE = /Yes,\s*I\s*trust\s*this\s*folder\s*(?:\u276f\s*)?2\.\s*No,\s*exit/i

/** Whether a trust prompt is on the screen `lines` (rows of the visible snapshot). */
export function trustPromptShown(lines: readonly string[]): boolean {
  const text = lines.join('\n')
  return TRUST_PATTERNS.some((re) => re.test(text)) || NUMBERED_TRUST_RE.test(text)
}

const SELECTOR = '\u276f'
const BORDER = '\u2500'

// A numbered chooser (tool permission, plan approval, AskUserQuestion, resume)
// raises by default: footers and questions vary too much to list. Its selected
// option shares the glyph with the echo of a submitted prompt and with the
// composer, so only the LAST glyph in the buffer counts, since the empty
// composer is painted below an echo once a turn settles. The period is not
// required: a selection repaint redraws only changed cells ("\u276f1Yes"). A
// glyph right under a border is the composer holding a numbered draft, and
// "esc to interrupt" after it is a running turn.
// Free-text questions without a menu are NOT detected (accepted v1 limit).
function detectChooser(text: string): boolean {
  const at = text.lastIndexOf(SELECTOR)
  if (at < 0) return false
  const tail = text.slice(at + 1)
  if (!/^\s*1/.test(tail) || /esc\s*to\s*interrupt/i.test(tail)) return false
  return !text.slice(0, at).trimEnd().endsWith(BORDER)
}

const isWaitingScreen = (text: string): boolean => detectChooser(text) || TRUST_PATTERNS.some((re) => re.test(text))

// Exempts only the dev-channels startup warning's own two-cue screen (title and
// accept-option wording, both required via detectChannelsWarning), not any
// other auto-advancing single-option chooser.
// If either cue's wording changes, the exemption silently stops matching and
// this falls back to the waiting-screen rule with no error.
// purgeScreenMemory, called when startup-ack answers the dialog, is the actual
// guarantee against a stuck false exemption; the re-scan fallback only bounds
// it.
export function detectWaiting(text: string): boolean {
  if (detectChannelsWarning(text)) {
    return TRUST_PATTERNS.some((re) => re.test(text))
  }
  return isWaitingScreen(text)
}

// Deliberately does not reuse detectWaiting's exemption: raising and clearing
// are opposite decisions under uncertainty, and reusing it let a real chooser's
// flag get cleared by unrelated dev-channels text entering the buffer
// afterward.
// Only clears on positive evidence the chooser is gone: a running turn, the
// composer box, or no glyph left in the window. Moving the selection off
// option 1 leaves the glyph on another option, which is still a chooser; and a
// non-manual clear settles the tile's approvals as answered in the terminal.
function stillWaiting(text: string): boolean {
  if (TRUST_PATTERNS.some((re) => re.test(text))) return true
  const at = text.lastIndexOf(SELECTOR)
  if (at < 0) return false
  if (/esc\s*to\s*interrupt/i.test(text.slice(at + 1))) return false
  return !text.slice(0, at).trimEnd().endsWith(BORDER)
}

export const screenShowsWait = (text: string): boolean => detectWaiting(text) || stillWaiting(text)

/** What crosses IPC to the renderer and the companion: never the internal dialog text or episode id. */
export function projectAttentionEvent(e: AttentionEvent): Pick<AttentionEvent, 'id' | 'waiting' | 'manual'> {
  return e.manual === undefined ? { id: e.id, waiting: e.waiting } : { id: e.id, waiting: e.waiting, manual: e.manual }
}

export const DIALOG_TITLE_MAX = 256
export const DIALOG_TEXT_MAX = 2048

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g

/** Strips control characters (newlines kept) and caps by code points; `truncated` says a cap bit. */
export function boundDialog(title: string, text: string): UnknownDialogPayload {
  const cap = (s: string, max: number): { value: string; cut: boolean } => {
    const points = [...s.replace(CONTROL_RE, '')]
    return points.length > max ? { value: points.slice(0, max).join(''), cut: true } : { value: points.join(''), cut: false }
  }
  const t = cap(title, DIALOG_TITLE_MAX)
  const x = cap(text, DIALOG_TEXT_MAX)
  return { title: t.value, text: x.value, truncated: t.cut || x.cut }
}

/** The journal entry of an unknown-dialog episode: bounded again here, the entry never trusts its payload. */
export function describeUnknownDialog(id: string, name: string, dialog: UnknownDialogPayload): string {
  const bounded = boundDialog(dialog.title, dialog.text)
  const cut = dialog.truncated || bounded.truncated
  return (
    `session "${name}" (${id}) is stopped on a Claude Code dialog the Deck does not know; nothing was typed.\n` +
    `${bounded.title}\n${bounded.text}${cut ? '\n[truncated]' : ''}`
  )
}

/** True for a claude tile whose readable screen shows an unknown dialog; other CLIs are never judged here. */
export function unknownDialogOnScreen(claudeLaunch: boolean, read: XtermScreenRead): boolean {
  return claudeLaunch && read.status === 'ready' && inspectUnknownDialog(read.snapshot) !== null
}

export interface UnknownDialog {
  title: string
  options: string[]
  footer: string
  text: string
  /** Title, option labels and footer, normalised; the selector position is not part of it. */
  signature: string
}

const UP_DOWN = '↑/↓'
const MIDDLE_DOT = '·'
const FOOTER_RES = [
  new RegExp(`^${UP_DOWN} to navigate ${MIDDLE_DOT} enter to (?:confirm|select) ${MIDDLE_DOT} esc to cancel$`),
  new RegExp(`^enter to (?:confirm|select) ${MIDDLE_DOT} esc to cancel$`),
  new RegExp(`^enter to (?:confirm|select) ${MIDDLE_DOT} ${UP_DOWN} to navigate ${MIDDLE_DOT} esc to cancel$`)
]
const MCP_CONSENT_RE = /new MCP servers? found in this project/i
const FRAME_SIDES_RE = /^│|│$/g
const RULE_RE = /^╭?─{3,}╮?$/
const BOTTOM_FRAME_RE = /^╰─*╯$/
const FOOTER_MAX_ROWS = 4
const TITLE_SCAN_MAX_ROWS = 20

const unframe = (line: string): string => line.replace(FRAME_SIDES_RE, '').trimEnd()
const normalise = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()
const leadingSpaces = (s: string): number => s.length - s.trimStart().length
const startsWithSelector = (s: string): boolean => s.trimStart().startsWith(SELECTOR)

/**
 * The modal an unknown Claude Code screen shows: a rule, a title, one selected option among at least two
 * aligned ones, and a complete confirm/cancel footer as the last content. Null for anything else, for a
 * visible composer, and for every screen a known detector owns.
 */
export function inspectUnknownDialog(snapshot: XtermScreenSnapshot): UnknownDialog | null {
  if (composerGeometryVisible(snapshot)) return null
  const raw = snapshot.lines
  const rows = raw.map(unframe)
  let end = rows.length - 1
  while (end >= 0 && (rows[end]!.trim() === '' || BOTTOM_FRAME_RE.test(raw[end]!.trim()) || RULE_RE.test(raw[end]!.trim()))) end--
  if (end < 0) return null

  let footerStart = -1
  let footer = ''
  for (let k = 1; k <= FOOTER_MAX_ROWS && end - k + 1 >= 0; k++) {
    const span = rows.slice(end - k + 1, end + 1)
    if (span.some((row) => row.trim() === '')) break
    const joined = normalise(span.join(' '))
    if (FOOTER_RES.some((re) => re.test(joined))) {
      footerStart = end - k + 1
      footer = joined
      break
    }
  }
  if (footerStart < 0) return null

  let selected = -1
  for (let i = footerStart - 1; i >= 0; i--) {
    if (startsWithSelector(rows[i]!)) {
      selected = i
      break
    }
  }
  if (selected < 0) return null
  const chevronAt = rows[selected]!.indexOf(SELECTOR)
  const afterChevron = rows[selected]!.slice(chevronAt + 1)
  const labelColumn = chevronAt + 1 + leadingSpaces(afterChevron)
  const selectedLabel = afterChevron.trim()
  if (selectedLabel === '' || /^\d+\./.test(selectedLabel)) return null

  const options: string[] = []
  let blockStart = selected
  for (let probe = selected - 1, scanned = 0; probe >= 0 && scanned < TITLE_SCAN_MAX_ROWS; probe--, scanned++) {
    const row = rows[probe]!
    if (row.trim() !== '' && (startsWithSelector(row) || leadingSpaces(row) !== labelColumn)) break
    if (row.trim() !== '') blockStart = probe
  }
  for (let i = blockStart; i < selected; i++) {
    if (rows[i]!.trim() !== '') options.push(rows[i]!.trim())
  }
  options.push(selectedLabel)
  for (let i = selected + 1; i < footerStart; i++) {
    const row = rows[i]!
    if (row.trim() === '') continue
    if (leadingSpaces(row) !== labelColumn) return null
    options.push(row.trim())
  }
  if (options.length < 2) return null

  let titleEnd = blockStart - 1
  const titleRows: string[] = []
  let separated = false
  for (let scanned = 0; titleEnd >= 0 && scanned < TITLE_SCAN_MAX_ROWS; titleEnd--, scanned++) {
    if (RULE_RE.test(raw[titleEnd]!.trim())) {
      separated = true
      break
    }
    titleRows.unshift(rows[titleEnd]!)
  }
  if (!separated || titleRows.some(startsWithSelector)) return null
  const titleLines = titleRows.map((row) => row.trim()).filter((row) => row !== '')
  if (titleLines.length === 0) return null

  const text = [...titleLines, ...options, footer].join('\n')
  if (trustPromptShown(raw) || detectChannelsWarning(text) || MCP_CONSENT_RE.test(text)) return null
  return {
    title: titleLines[0]!,
    options,
    footer,
    text,
    signature: JSON.stringify([titleLines.map(normalise), options.map(normalise), footer])
  }
}

// Load-bearing for one of five ways a raised flag clears: a busy cue,
// purgeScreenMemory on the dev-channels ack, the welcome screen following a
// trust prompt, the operator dismissing it by hand, or the raising pattern
// sliding out of this window once it fills. The last path is real but bounded and rare; comparing against the current
// screen instead of a cumulative buffer would remove it but is out of scope
// here.
const MAX_BUF = 4096

// Full-screen repaints take roughly 300 ms; 1.5 s filters them before raising attention.
export const ATTENTION_CONFIRMATION_DELAY_MS = 1_500

const MAX_CONSECUTIVE_VETOES = 3

export interface AttentionDetectorOptions {
  confirmationDelayMs?: number
  setTimeout?: (callback: () => void, delayMs: number) => unknown
  clearTimeout?: (timer: unknown) => void
  /** Can only drop a raise at its deadline; never raises and never clears. */
  screenWitness?: ScreenWitness
  /** The unknown-dialog path runs only with a screen to read and a tile it is enabled for. */
  screenRead?: (id: string) => XtermScreenRead
  unknownDialogEnabled?: (id: string) => boolean
  now?: () => number
  reportError?: (scope: string, message: string, error?: unknown) => void
}

interface UnknownEpisode {
  id: string
  signature: string
  lastSeenAt: number
}

interface UnknownState {
  sampleTimer?: unknown
  candidate: { signature: string; since: number } | null
  episode: UnknownEpisode | null
  challenger: { signature: string; since: number } | null
  fall: { since: number } | null
  busyAt: number | null
  /** Consecutive unreadable samples since the last output; bounds the retry. */
  unreadable: number
}

export const UNKNOWN_UNREADABLE_RETRIES = 40

interface SessionState {
  buf: string
  waiting: boolean
  pending: object | null
  timer?: unknown
  witness?: ScreenWitnessWindow
  /** A running turn means the operator answered (or the wait screen is gone). */
  busy: BusyCue
  unknown: UnknownState
}

export const UNKNOWN_SAMPLE_INTERVAL_MS = 50

/**
 * Tracks per-session "waiting for the operator" episodes from PTY output.
 * Emits 'attention' on transitions: waiting=true after a screen persists for
 * the confirmation delay, waiting=false immediately when the screen clears.
 */
export class AttentionDetector extends EventEmitter {
  private sessions = new Map<string, SessionState>()
  private readonly confirmationDelayMs: number
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown
  private readonly clearTimer: (timer: unknown) => void
  private readonly screenWitness: ScreenWitness | undefined
  private readonly screenRead: ((id: string) => XtermScreenRead) | undefined
  private readonly unknownEnabled: (id: string) => boolean
  private readonly now: () => number
  private readonly reportError: (scope: string, message: string, error?: unknown) => void

  constructor(options: AttentionDetectorOptions = {}) {
    super()
    this.screenWitness = options.screenWitness
    this.screenRead = options.screenRead
    this.unknownEnabled = options.unknownDialogEnabled ?? (() => false)
    this.now = options.now ?? (() => Date.now())
    this.reportError = options.reportError ?? (() => undefined)
    this.confirmationDelayMs = options.confirmationDelayMs ?? ATTENTION_CONFIRMATION_DELAY_MS
    this.setTimer = options.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs))
    this.clearTimer = options.clearTimeout ?? ((timer) => globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>))
  }

  private cancelPending(st: SessionState): void {
    if (st.pending === null) return
    if (st.timer !== undefined) this.clearTimer(st.timer)
    st.witness?.cancel()
    st.pending = null
    st.timer = undefined
    st.witness = undefined
  }

  private scheduleConfirmation(id: string, st: SessionState, vetoes = 0): void {
    const pending = {}
    st.pending = pending
    st.witness = this.screenWitness?.arm(id, this.confirmationDelayMs, { setTimeout: this.setTimer, clearTimeout: this.clearTimer })
    const timer = this.setTimer(() => {
      if (st.pending !== pending) return
      const witness = st.witness
      st.pending = null
      st.timer = undefined
      st.witness = undefined
      if (this.sessions.get(id) !== st || st.waiting || !stillWaiting(st.buf)) return
      // The buffer is kept and the check re-armed, so a wrong veto only delays the raise;
      // the bound stops a stale buffer from re-arming for ever.
      if (witness?.decide()) {
        if (vetoes + 1 < MAX_CONSECUTIVE_VETOES) this.scheduleConfirmation(id, st, vetoes + 1)
        return
      }
      this.endUnknownEpisode(st)
      st.waiting = true
      this.emit('attention', { id, waiting: true } satisfies AttentionEvent)
    }, this.confirmationDelayMs)
    if (st.pending === pending) st.timer = timer
  }

  private endUnknownEpisode(st: SessionState): void {
    st.unknown.episode = null
    st.unknown.challenger = null
    st.unknown.fall = null
    st.unknown.busyAt = null
  }

  private cancelUnknownSampling(st: SessionState): void {
    if (st.unknown.sampleTimer !== undefined) this.clearTimer(st.unknown.sampleTimer)
    st.unknown.sampleTimer = undefined
    st.unknown.candidate = null
    st.unknown.challenger = null
    st.unknown.fall = null
  }

  private requestUnknownSample(id: string, st: SessionState): void {
    if (this.screenRead === undefined || st.unknown.sampleTimer !== undefined || !this.unknownEnabled(id)) return
    const timer = this.setTimer(() => {
      if (this.sessions.get(id) !== st) return
      st.unknown.sampleTimer = undefined
      this.sampleUnknown(id, st)
    }, UNKNOWN_SAMPLE_INTERVAL_MS)
    if (st.unknown.sampleTimer === undefined) st.unknown.sampleTimer = timer
  }

  private sampleUnknown(id: string, st: SessionState): void {
    const u = st.unknown
    const now = this.now()
    let read: XtermScreenRead
    try {
      read = this.screenRead!(id)
    } catch (error) {
      this.reportError('attention', 'unknown-dialog screen read failed', error)
      read = { status: 'unavailable', reason: 'screen-fault' }
    }
    const snapshot = read.status === 'ready' ? read.snapshot : null
    const dialog = snapshot ? inspectUnknownDialog(snapshot) : null
    const delay = this.confirmationDelayMs

    if (u.episode === null) {
      if (dialog === null) u.candidate = null
      else if (u.candidate?.signature !== dialog.signature) u.candidate = { signature: dialog.signature, since: now }
      else if (now - u.candidate.since >= delay) this.raiseUnknown(id, st, dialog, now)
    } else if (dialog !== null && dialog.signature === u.episode.signature) {
      u.episode.lastSeenAt = now
      u.fall = null
      u.challenger = null
    } else if (dialog !== null) {
      u.fall = null
      if (u.challenger?.signature !== dialog.signature) u.challenger = { signature: dialog.signature, since: now }
      else if (now - u.challenger.since >= delay) this.raiseUnknown(id, st, dialog, now)
    } else {
      u.challenger = null
      const positive =
        snapshot !== null &&
        snapshot.lines.some((line) => line !== '') &&
        (composerGeometryVisible(snapshot) || (u.busyAt !== null && u.busyAt > u.episode.lastSeenAt))
      if (!positive) u.fall = null
      else if (u.fall === null) u.fall = { since: now }
      else if (now - u.fall.since >= delay) {
        const closed = u.episode
        this.endUnknownEpisode(st)
        this.emit('attention', {
          id,
          waiting: false,
          source: 'unknown-dialog',
          episodeId: closed.id
        } satisfies AttentionEvent)
      }
    }
    if (this.sessions.get(id) !== st) return
    u.unreadable = snapshot === null ? u.unreadable + 1 : 0
    const retryUnreadable = snapshot === null && u.unreadable <= UNKNOWN_UNREADABLE_RETRIES
    if (retryUnreadable || u.candidate !== null || u.challenger !== null || u.fall !== null) {
      this.requestUnknownSample(id, st)
    }
  }

  private raiseUnknown(id: string, st: SessionState, dialog: UnknownDialog, now: number): void {
    this.cancelPending(st)
    st.buf = ''
    st.waiting = false
    const u = st.unknown
    u.candidate = null
    u.challenger = null
    u.fall = null
    u.busyAt = null
    u.episode = { id: randomUUID(), signature: dialog.signature, lastSeenAt: now }
    this.emit('attention', {
      id,
      waiting: true,
      source: 'unknown-dialog',
      episodeId: u.episode.id,
      dialog: boundDialog(dialog.title, dialog.text)
    } satisfies AttentionEvent)
  }

  feed(id: string, data: string): void {
    let st = this.sessions.get(id)
    if (!st) {
      st = {
        buf: '',
        waiting: false,
        pending: null,
        busy: createBusyCue({ title: false }),
        unknown: { candidate: null, episode: null, challenger: null, fall: null, busyAt: null, unreadable: 0 }
      }
      this.sessions.set(id, st)
    }
    const stripped = stripAnsi(data)
    const busy = st.busy.feed(data)
    st.unknown.unreadable = 0
    if (busy) {
      st.unknown.candidate = null
      st.unknown.challenger = null
      if (st.unknown.episode !== null) st.unknown.busyAt = this.now()
    }
    this.requestUnknownSample(id, st)

    if (st.waiting) {
      if (busy) {
        st.waiting = false
        st.buf = ''
        this.emit('attention', { id, waiting: false } satisfies AttentionEvent)
        return
      }
      // Fallback clearer: some dismissals never produce a busy cue (the
      // dev-channels auto-ack, an accepted trust prompt), so the retained
      // buffer is re-scanned with `stillWaiting`, never `detectWaiting`:
      // clearing must never go through the dev-channels exemption.
      // Re-strip the accumulated buffer (not just `stripped`, the per-chunk
      // delta): closes the cross-chunk OSC fragmentation gap, see the
      // comment on `stripAnsi` above.
      st.buf = stripAnsi((st.buf + stripped).slice(-MAX_BUF))
      // The welcome screen painted after the trust prompt means it was
      // answered: drop the prompt's text but re-scan what followed it, so a
      // repainted prompt or a chooser drawn after the banner holds the flag.
      const afterTrust = afterTrustPrompt(st.buf)
      if (afterTrust !== null && WELCOME_BANNER_RE.test(afterTrust)) st.buf = afterTrust
      if (!stillWaiting(st.buf)) {
        st.waiting = false
        st.buf = ''
        this.emit('attention', { id, waiting: false } satisfies AttentionEvent)
      }
      return
    }

    // A busy cue invalidates the accumulated context (a wait screen never
    // coexists with a running turn) but the SAME chunk may already carry the
    // prompt that follows the turn's end -- so reset FIRST, then append.
    if (busy) st.buf = ''
    // Re-strip the accumulated buffer, same reasoning as the branch above.
    st.buf = stripAnsi((st.buf + stripped).slice(-MAX_BUF))
    const afterWelcome = afterTrustPrompt(st.buf)
    if (afterWelcome !== null && WELCOME_BANNER_RE.test(afterWelcome)) st.buf = afterWelcome
    if (st.pending !== null && (busy || !stillWaiting(st.buf))) this.cancelPending(st)
    if (st.pending === null && detectWaiting(st.buf)) this.scheduleConfirmation(id, st)
  }

  clear(id: string): void {
    const st = this.sessions.get(id)
    if (st) {
      this.cancelPending(st)
      this.cancelUnknownSampling(st)
    }
    this.sessions.delete(id)
  }

  /** Clears retained screen data and cancels an unconfirmed raise without changing confirmed attention. */
  purgeScreenMemory(id: string): void {
    const st = this.sessions.get(id)
    if (st) {
      this.cancelPending(st)
      st.buf = ''
      st.unknown.candidate = null
    }
  }

  stop(): void {
    for (const st of this.sessions.values()) {
      this.cancelPending(st)
      this.cancelUnknownSampling(st)
    }
    this.sessions.clear()
  }
}
