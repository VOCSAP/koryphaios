// Operator-inbox persistence: the broker drain is DESTRUCTIVE (messages are
// marked delivered and never returned again), so before this store a Deck
// restart lost the whole inbox. Drained batches are now journaled to one JSON
// file in the app-state dir and reloaded at startup. Plain JSON on purpose:
// these messages transit the broker's unencrypted SQLite anyway, so cipher
// here would protect nothing (unlike graph docs, which exist only Deck-side).
//
// Node builtins only (injectable dir): unit-testable under bun.

import { mkdirSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from './atomic-write'
import { join } from 'node:path'
import type { InboxMessage } from '../shared/types'

export const INBOX_HISTORY_CAP = 500
const FILE = 'inbox-history.json'

export function inboxHistoryFile(stateDir: string): string {
  return join(stateDir, FILE)
}

/** Load the persisted history (oldest first). Corrupt/missing file -> []. */
export function loadInboxHistory(stateDir: string): InboxMessage[] {
  try {
    const raw = JSON.parse(readFileSync(inboxHistoryFile(stateDir), 'utf-8'))
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (m): m is InboxMessage =>
        !!m &&
        typeof m === 'object' &&
        typeof (m as InboxMessage).id === 'number' &&
        typeof (m as InboxMessage).from === 'string' &&
        typeof (m as InboxMessage).text === 'string' &&
        typeof (m as InboxMessage).sentAt === 'string'
    )
  } catch {
    return []
  }
}

/**
 * Append a drained batch and persist, deduplicating by broker message id
 * (defensive: a crash between drain and write can re-deliver nothing, but a
 * double append from a retry must not duplicate). Oldest entries fall off
 * past the cap. Returns the merged history (oldest first).
 */
export function appendInboxHistory(
  stateDir: string,
  batch: InboxMessage[],
  cap = INBOX_HISTORY_CAP,
  onPersistError?: (e: unknown) => void
): InboxMessage[] {
  const current = loadInboxHistory(stateDir)
  const known = new Set(current.map((m) => m.id))
  const merged = [...current, ...batch.filter((m) => !known.has(m.id))].slice(-cap)
  try {
    mkdirSync(stateDir, { recursive: true })
    // Atomic (temp + rename): the inbox drain is destructive, so a torn write
    // would lose the only durable copy of the drained operator messages.
    writeFileAtomic(inboxHistoryFile(stateDir), JSON.stringify(merged))
  } catch (e) {
    // Persistence failure: the in-memory inbox still works this run, but the
    // broker drain was destructive -- the caller must know (O6) so it can
    // retry the batch instead of silently losing the only durable copy.
    onPersistError?.(e)
  }
  return merged
}
