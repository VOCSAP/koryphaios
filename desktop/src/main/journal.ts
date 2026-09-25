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

export class Journal {
  private entries: JournalEntry[] = []
  private seq = 0

  constructor(
    private cap: number = JOURNAL_CAP,
    private now: () => number = Date.now,
    private sink?: JournalEntrySink
  ) {}

  add(kind: JournalKind, text: string): JournalEntry {
    const entry: JournalEntry = { id: ++this.seq, at: this.now(), kind, text }
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
