import { MAX_LOGGED_CHARS, redactSecrets } from '../../../shared/log-redact'

export type JournalKind =
  | 'session'
  | 'quota'
  | 'attention'
  | 'worktree'
  | 'announce'
  | 'dispatch'
  | 'review'
  | 'checkpoint'
  | 'graph'
  | 'error'

export interface JournalEntry {
  id: number
  at: number
  kind: JournalKind
  text: string
}

export type JournalEntrySink = (entry: JournalEntry) => void

export const JOURNAL_CAP = 500

const carriageReturn = String.fromCharCode(13)
const lineFeed = String.fromCharCode(10)
const journalLineBreaks = new RegExp(
  `${carriageReturn}${lineFeed}|[${carriageReturn}${lineFeed}${String.fromCodePoint(0x2028)}${String.fromCodePoint(0x2029)}]`,
  'g'
)
const journalControls = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}${String.fromCodePoint(0x061c)}${String.fromCodePoint(0x200b)}-${String.fromCodePoint(0x200f)}${String.fromCodePoint(0x202a)}-${String.fromCodePoint(0x202e)}${String.fromCodePoint(0x2060)}-${String.fromCodePoint(0x2069)}${String.fromCodePoint(0xfeff)}]`,
  'g'
)
const replacement = String.fromCharCode(0xfffd)

function journalSafe(text: string): string {
  return text.replace(journalLineBreaks, ' / ').replace(journalControls, replacement)
}

function withoutSeparators(text: string): string {
  return text.replace(journalLineBreaks, '').replace(journalControls, '')
}

// The joined form is never emitted: joining drops the boundary the patterns
// anchor on, so it redacts less than the direct pass. It only shows a piece was missed.
function redactAcrossBreaks(text: string): string {
  const direct = redactSecrets(text)
  const flat = withoutSeparators(direct)
  if (redactSecrets(withoutSeparators(text)) === flat) return direct
  return redactSecrets(flat).replace(/\[redacted\][A-Za-z0-9._~+/=-]+/g, '[redacted]')
}

export class Journal {
  private entries: JournalEntry[] = []
  private seq = 0

  constructor(
    private cap: number = JOURNAL_CAP,
    private now: () => number = Date.now,
    private sink?: JournalEntrySink
  ) {}

  add(kind: JournalKind, text: string): JournalEntry {
    const entry: JournalEntry = { id: ++this.seq, at: this.now(), kind, text: journalSafe(redactAcrossBreaks(text.slice(0, MAX_LOGGED_CHARS))).slice(0, MAX_LOGGED_CHARS) }
    this.entries.push(entry)
    if (this.entries.length > this.cap) {
      this.entries.splice(0, this.entries.length - this.cap)
    }
    this.sink?.(entry)
    return entry
  }

  list(kind?: JournalKind | null): JournalEntry[] {
    return kind ? this.entries.filter((e) => e.kind === kind) : [...this.entries]
  }

  toText(): string {
    return this.entries
      .map((e) => `${new Date(e.at).toISOString()}  [${e.kind}]  ${e.text}`)
      .join('\n')
  }
}
