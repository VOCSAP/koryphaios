// Activity journal (PLAN C14): an in-memory ring buffer of what happened in
// this window — spawns/exits, quota episodes, attention screens, worktree
// operations, announces, dispatches, checkpoints (C16). Per window, never
// persisted: it narrates the current run, the workspace files persist state.
//
// No electron imports so it is unit-testable under `bun test`.

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
  // PLAN O3: swallowed failures surface here via log.ts reportError().
  | 'error'

export interface JournalEntry {
  /** Monotonic id (stable React key, cheap "anything new?" cursor). */
  id: number
  /** Epoch ms. */
  at: number
  kind: JournalKind
  text: string
}

export const JOURNAL_CAP = 500

export class Journal {
  private entries: JournalEntry[] = []
  private seq = 0

  constructor(
    private cap: number = JOURNAL_CAP,
    /** Injectable clock for tests. */
    private now: () => number = Date.now
  ) {}

  /** Append an entry (oldest entries fall off past the cap). */
  add(kind: JournalKind, text: string): JournalEntry {
    const entry: JournalEntry = { id: ++this.seq, at: this.now(), kind, text }
    this.entries.push(entry)
    if (this.entries.length > this.cap) {
      this.entries.splice(0, this.entries.length - this.cap)
    }
    return entry
  }

  /** Entries oldest-first, optionally only one kind. */
  list(kind?: JournalKind | null): JournalEntry[] {
    return kind ? this.entries.filter((e) => e.kind === kind) : [...this.entries]
  }

  /** Plain-text export (one line per entry, ISO timestamps). */
  toText(): string {
    return this.entries
      .map((e) => `${new Date(e.at).toISOString()}  [${e.kind}]  ${e.text}`)
      .join('\n')
  }
}
