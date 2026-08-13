// Operator-inbox persistence: the broker drain is DESTRUCTIVE (messages are
// marked delivered and never returned again), so before this store a Deck
// restart lost the whole inbox. Drained batches are now journaled to one JSON
// file in the app-state dir and reloaded at startup. Plain JSON on purpose:
// these messages transit the broker's unencrypted SQLite anyway, so cipher
// here would protect nothing (unlike graph docs, which exist only Deck-side).
//
// Node builtins only (injectable dir): unit-testable under bun.

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from './atomic-write'
import { join } from 'node:path'
import { inboxEntryKey, type InboxAckStatus, type InboxMessage } from '../shared/types'

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

// ----- ack state (ask_operator lot, Etape A) -----
//
// Family 1/2 Courrier entries only (never family 3, blocking questions —
// see AckableInboxEntry in shared/types.ts). Separate small file, THREE
// read-states (card 8fdac3dd: never fold to two) persisted across a Deck
// restart: absent from both sets below = unread, in `seen` = opened but not
// resolved, in `acked` = dismissed. `seen` never regresses an `acked` entry
// (checked at the call site in ipc.ts).
//
// Key widened past the bare broker id on review (team-lead, ask_operator
// lot): `messages.id` is an integer from the BROKER's own DB, which can be
// wiped/reinstalled/swapped to a shared broker independently of this Deck's
// local inbox-ack.json. A bare 'msg:<id>' would then silently mask a brand
// new message reusing a low id — the exact "singleton keyed by too little"
// failure this repo's conventions call out, and silent because nothing
// would ever flag the collision. `sentAt` is the broker's own timestamp and
// does not get reissued on a DB reset, so it disambiguates a replayed id.

export const INBOX_ACK_CAP = 2000
const ACK_FILE = 'inbox-ack.json'

interface AckFileShape {
  seen: string[]
  acked: string[]
}

export function inboxAckFile(stateDir: string): string {
  return join(stateDir, ACK_FILE)
}

function loadAckFile(stateDir: string): AckFileShape {
  try {
    const raw = JSON.parse(readFileSync(inboxAckFile(stateDir), 'utf-8'))
    const seen = Array.isArray(raw?.seen)
      ? raw.seen.filter((k: unknown): k is string => typeof k === 'string')
      : []
    const acked = Array.isArray(raw?.acked)
      ? raw.acked.filter((k: unknown): k is string => typeof k === 'string')
      : []
    return { seen, acked }
  } catch {
    return { seen: [], acked: [] }
  }
}

function saveAckFile(
  stateDir: string,
  state: AckFileShape,
  onPersistError?: (e: unknown) => void
): void {
  try {
    mkdirSync(stateDir, { recursive: true })
    writeFileAtomic(inboxAckFile(stateDir), JSON.stringify(state))
  } catch (e) {
    onPersistError?.(e)
  }
}

/** Merged read-state map for startup hydration: key -> 'seen' | 'acked'. */
export function loadAckState(stateDir: string): Record<string, InboxAckStatus> {
  const { seen, acked } = loadAckFile(stateDir)
  const out: Record<string, InboxAckStatus> = {}
  for (const k of seen) out[k] = 'seen'
  for (const k of acked) out[k] = 'acked' // acked always wins over a stale seen entry
  return out
}

/**
 * One-time migration seed (team-lead review, ask_operator lot follow-up):
 * on the very FIRST read of ack state -- inbox-ack.json does not exist yet
 * -- every entry already in inbox-history.json (up to 500) is seeded as
 * 'acked' before the normal read. These entries predate the ack feature,
 * and under the previous session-counter model opening the inbox panel had
 * already reset all of them to zero, so seeding them acked restores what
 * the operator believed their inbox state was, instead of surfacing a
 * badge of up to 500 items nobody asked for.
 *
 * Triggers ONLY on ABSENCE of the file, checked with `existsSync` BEFORE
 * any read -- never inferred from a read failure. A corrupt/unreadable
 * file is a corrupt file (loadAckFile's own catch already degrades it to
 * empty, unrelated to this function) and must never be treated as
 * "missing": a disk incident silently mass-acknowledging real unacked
 * state would be strictly worse than the badge this seed exists to avoid.
 * Writes the file unconditionally on that first read (even when there is
 * no history yet, i.e. an empty acked set) so the existence check alone
 * makes this idempotent -- once the file exists, no later call can
 * reseed, and only entries seen at THIS call are ever touched; anything
 * appended afterward follows the normal appendSeenKey/appendAckedKey path.
 */
export function loadAckStateWithMigrationSeed(
  stateDir: string,
  onPersistError?: (e: unknown) => void
): Record<string, InboxAckStatus> {
  if (!existsSync(inboxAckFile(stateDir))) {
    const seedKeys = loadInboxHistory(stateDir).map((m) =>
      inboxEntryKey({ kind: 'message', message: m })
    )
    saveAckFile(stateDir, { seen: [], acked: seedKeys }, onPersistError)
  }
  return loadAckState(stateDir)
}

/**
 * Mark one key seen (idempotent) and persist. A no-op if the key is already
 * 'acked' — seen must never regress an ack.
 */
export function appendSeenKey(
  stateDir: string,
  key: string,
  cap = INBOX_ACK_CAP,
  onPersistError?: (e: unknown) => void
): void {
  const state = loadAckFile(stateDir)
  if (state.acked.includes(key) || state.seen.includes(key)) return
  state.seen = [...state.seen, key].slice(-cap)
  saveAckFile(stateDir, state, onPersistError)
}

/**
 * Mark one key acked and persist (idempotent). Removed from `seen` if
 * present there — the two sets stay disjoint on disk, `loadAckState`'s
 * override order is defense in depth, not the only guard.
 */
export function appendAckedKey(
  stateDir: string,
  key: string,
  cap = INBOX_ACK_CAP,
  onPersistError?: (e: unknown) => void
): void {
  const state = loadAckFile(stateDir)
  if (state.acked.includes(key)) return
  state.seen = state.seen.filter((k) => k !== key)
  state.acked = [...state.acked, key].slice(-cap)
  saveAckFile(stateDir, state, onPersistError)
}
