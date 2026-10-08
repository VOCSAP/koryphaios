export const JOB_STARTUP_SCAN_WINDOW_MS = 20_000
/** An escape sequence longer than this many UTF-16 code units is abandoned and the parser returns to text. */
export const MAX_ESCAPE_SEQUENCE_CODE_UNITS = 4096

export interface JobStartupUpdate {
  reportFailure: boolean
  /** Terminal: the status has reported or its window has expired, and will never report again. */
  done: boolean
}

const ESC = 0x1b
const BEL = 0x07
const LEFT_BRACKET = 0x5b
const RIGHT_BRACKET = 0x5d
const BACKSLASH = 0x5c
const JOB_WARNING_MARKER = 'kory-job: tree kill disabled'

type ParserState = 'text' | 'esc' | 'csi' | 'osc' | 'oscEsc'

export class JobStartupStatus {
  private done = false
  private tail = ''
  private state: ParserState = 'text'
  private sequenceLength = 0

  constructor(
    private readonly startedAt: number,
    private readonly windowMs = JOB_STARTUP_SCAN_WINDOW_MS
  ) {}

  consume(data: string, now: number): JobStartupUpdate {
    if (this.done) return { reportFailure: false, done: true }
    if (now - this.startedAt >= this.windowMs) return this.finish(false)

    const output = this.tail + this.stripControlSequences(data)
    if (output.includes(JOB_WARNING_MARKER)) return this.finish(true)

    this.tail = output.slice(-(JOB_WARNING_MARKER.length - 1))
    return { reportFailure: false, done: false }
  }

  private finish(reportFailure: boolean): JobStartupUpdate {
    this.done = true
    this.tail = ''
    return { reportFailure, done: true }
  }

  private stripControlSequences(data: string): string {
    let visible = ''

    for (let index = 0; index < data.length; index++) {
      const code = data.charCodeAt(index)
      if (this.state !== 'text' && ++this.sequenceLength > MAX_ESCAPE_SEQUENCE_CODE_UNITS) this.state = 'text'

      switch (this.state) {
        case 'text':
          if (code === ESC) {
            this.state = 'esc'
            this.sequenceLength = 1
          } else {
            visible += data[index]
          }
          break
        case 'esc':
          if (code === LEFT_BRACKET) this.state = 'csi'
          else if (code === RIGHT_BRACKET) this.state = 'osc'
          else if (code === ESC) this.sequenceLength = 1
          else {
            this.state = 'text'
            visible += data[index]
          }
          break
        case 'csi':
          if (code >= 0x40 && code <= 0x7e) this.state = 'text'
          break
        case 'osc':
          if (code === BEL) this.state = 'text'
          else if (code === ESC) this.state = 'oscEsc'
          break
        case 'oscEsc':
          if (code === BACKSLASH) this.state = 'text'
          else if (code !== ESC) this.state = 'osc'
          break
      }
    }

    return visible
  }
}

/** The clock is read only while a status is live, so a finished tile costs nothing per chunk. */
export function scanJobStartup(
  status: JobStartupStatus | null,
  data: string,
  clock: () => number
): { status: JobStartupStatus | null; reportFailure: boolean } {
  if (!status) return { status: null, reportFailure: false }
  const update = status.consume(data, clock())
  return { status: update.done ? null : status, reportFailure: update.reportFailure }
}
