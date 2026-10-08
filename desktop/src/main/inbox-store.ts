// Plain JSON on purpose: these messages transit the broker's unencrypted SQLite
// anyway, so encrypting the local copy would protect nothing.
// The journal is the only durable copy of what was already shown: a session_id
// is minted in-memory and never persisted, so a restart starts a brand new
// session whose cursor seeds at the box's current max id, unable to replay
// anything from the broker either.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { writeFileAtomic } from './atomic-write'
import { join } from 'node:path'
import { countPendingInboxMessages } from '../shared/inbox-pending'
import { inboxEntryKey, type InboxAckStatus, type InboxMessage } from '../shared/types'
import { reportError } from './log'

export const INBOX_HISTORY_CAP = 500
const FILE = 'inbox-history.json'

export type InboxReadErrorSink = (message: string, error?: unknown) => void

const traceInboxRead: InboxReadErrorSink = (message, error) => reportError('inbox', message, error)

/** Absent is a normal empty state; any other read or parse failure is traced, then read as absent. */
function readJsonFile(file: string, onReadError: InboxReadErrorSink): unknown {
  let text: string
  try {
    text = readFileSync(file, 'utf-8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') onReadError(`${file} unreadable, read as empty`, e)
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch (e) {
    onReadError(`${file} is not valid JSON, read as empty`, e)
    return undefined
  }
}

export function inboxHistoryFile(sessionDir: string): string {
  return join(sessionDir, FILE)
}

/** Load the persisted history (oldest first). Missing file -> []; a corrupt one is traced, then []. */
export function loadInboxHistory(sessionDir: string, onReadError: InboxReadErrorSink = traceInboxRead): InboxMessage[] {
  const file = inboxHistoryFile(sessionDir)
  const raw = readJsonFile(file, onReadError)
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    onReadError(`${file} is not a list, read as empty`)
    return []
  }
  return raw.filter(
    (m): m is InboxMessage =>
      !!m &&
      typeof m === 'object' &&
      typeof (m as InboxMessage).id === 'number' &&
      typeof (m as InboxMessage).from === 'string' &&
      typeof (m as InboxMessage).text === 'string' &&
      typeof (m as InboxMessage).sentAt === 'string'
  )
}

/**
 * Append a drained batch and persist, deduplicating by broker message id
 * (defensive: a crash between drain and write can re-deliver nothing, but a
 * double append from a retry must not duplicate). Oldest entries fall off
 * past the cap. Returns the merged history (oldest first).
 */
export function appendInboxHistory(
  sessionDir: string,
  batch: InboxMessage[],
  cap = INBOX_HISTORY_CAP,
  onPersistError?: (e: unknown) => void
): InboxMessage[] {
  const current = loadInboxHistory(sessionDir)
  const known = new Set(current.map((m) => m.id))
  const merged = [...current, ...batch.filter((m) => !known.has(m.id))].slice(-cap)
  try {
    mkdirSync(sessionDir, { recursive: true })
    // Atomic (temp + rename): the inbox drain is destructive, so a torn write
    // would lose the only durable copy of the drained operator messages.
    writeFileAtomic(inboxHistoryFile(sessionDir), JSON.stringify(merged))
  } catch (e) {
    // Persistence failure: the in-memory inbox still works this run, but the
    // broker drain was destructive -- the caller must know (O6) so it can
    // retry the batch instead of silently losing the only durable copy.
    onPersistError?.(e)
  }
  return merged
}

/**
 * Courrier lot 1D (card 1e81ee7b, design doc section 6.1/8): truncate the
 * WHOLE local journal to empty, at the SAME instant as the broker-side
 * session-scope purge (ipc.ts's app:new-clear / workspace:restore /
 * template:apply-replace handlers). Skipping this half is the exact trap the
 * design doc names: deleting broker-side without truncating here leaves the
 * dead entries ON SCREEN, so the bug would read as unfixed.
 */
export function clearInboxHistory(sessionDir: string, onPersistError?: (e: unknown) => void): void {
  try {
    mkdirSync(sessionDir, { recursive: true })
    writeFileAtomic(inboxHistoryFile(sessionDir), JSON.stringify([]))
  } catch (e) {
    onPersistError?.(e)
  }
}

/**
 * Courrier lot 1E (card 1e81ee7b): remove specific entries by broker message
 * id -- the manual "delete this one" gesture, distinct from clearInboxHistory
 * above (a session-scope reset) and from ack (a read-state change that never
 * removes the entry). Returns the remaining history (oldest first) so the
 * caller can re-broadcast it without a second disk read.
 */
export function deleteInboxHistoryEntries(
  sessionDir: string,
  ids: number[],
  onPersistError?: (e: unknown) => void
): InboxMessage[] {
  const idSet = new Set(ids)
  const remaining = loadInboxHistory(sessionDir).filter((m) => !idSet.has(m.id))
  try {
    mkdirSync(sessionDir, { recursive: true })
    writeFileAtomic(inboxHistoryFile(sessionDir), JSON.stringify(remaining))
  } catch (e) {
    onPersistError?.(e)
  }
  return remaining
}

// Three read-states, never folded to two: absent from both sets is unread, in
// `seen` is opened but not resolved, in `acked` is dismissed; `seen` never
// regresses an `acked` entry.
// Keyed by (id, sentAt) rather than the bare broker id: messages.id can collide
// after the broker's DB is wiped or swapped to a shared broker, and sentAt
// disambiguates a replayed id.

export const INBOX_ACK_CAP = 2000
const ACK_FILE = 'inbox-ack.json'

interface AckFileShape {
  seen: string[]
  acked: string[]
}

export function inboxAckFile(sessionDir: string): string {
  return join(sessionDir, ACK_FILE)
}

function loadAckFile(sessionDir: string, onReadError: InboxReadErrorSink = traceInboxRead): AckFileShape {
  const file = inboxAckFile(sessionDir)
  const raw = readJsonFile(file, onReadError) as { seen?: unknown; acked?: unknown } | null | undefined
  if (raw === undefined) return { seen: [], acked: [] }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    onReadError(`${file} is not an object, read as empty`)
    return { seen: [], acked: [] }
  }
  const seen = Array.isArray(raw.seen) ? raw.seen.filter((k: unknown): k is string => typeof k === 'string') : []
  const acked = Array.isArray(raw.acked) ? raw.acked.filter((k: unknown): k is string => typeof k === 'string') : []
  return { seen, acked }
}

function saveAckFile(
  sessionDir: string,
  state: AckFileShape,
  onPersistError?: (e: unknown) => void
): void {
  try {
    mkdirSync(sessionDir, { recursive: true })
    writeFileAtomic(inboxAckFile(sessionDir), JSON.stringify(state))
  } catch (e) {
    onPersistError?.(e)
  }
}

/** Merged read-state map for startup hydration: key -> 'seen' | 'acked'. */
export function loadAckState(
  sessionDir: string,
  onReadError: InboxReadErrorSink = traceInboxRead
): Record<string, InboxAckStatus> {
  const { seen, acked } = loadAckFile(sessionDir, onReadError)
  const out: Record<string, InboxAckStatus> = {}
  for (const k of seen) out[k] = 'seen'
  for (const k of acked) out[k] = 'acked' // acked always wins over a stale seen entry
  return out
}

/**
 * Triggers only on absence of the ack file, checked with existsSync before any
 * read, never inferred from a read failure -- a corrupt file must never be
 * treated as missing, or a disk incident would silently mass-acknowledge real
 * unacked state.
 * Writes the file unconditionally on first read, even when empty, so the
 * existence check alone makes this idempotent.
 */
export function loadAckStateWithMigrationSeed(
  sessionDir: string,
  onPersistError?: (e: unknown) => void
): Record<string, InboxAckStatus> {
  if (!existsSync(inboxAckFile(sessionDir))) {
    const seedKeys = loadInboxHistory(sessionDir).map((m) =>
      inboxEntryKey({ kind: 'message', message: m })
    )
    saveAckFile(sessionDir, { seen: [], acked: seedKeys }, onPersistError)
  }
  return loadAckState(sessionDir)
}

/**
 * Mark one key seen (idempotent) and persist. A no-op if the key is already
 * 'acked' — seen must never regress an ack.
 */
export function appendSeenKey(
  sessionDir: string,
  key: string,
  cap = INBOX_ACK_CAP,
  onPersistError?: (e: unknown) => void
): void {
  const state = loadAckFile(sessionDir)
  if (state.acked.includes(key) || state.seen.includes(key)) return
  state.seen = [...state.seen, key].slice(-cap)
  saveAckFile(sessionDir, state, onPersistError)
}

/**
 * Mark one key acked and persist (idempotent). Removed from `seen` if
 * present there — the two sets stay disjoint on disk, `loadAckState`'s
 * override order is defense in depth, not the only guard.
 */
export function appendAckedKey(
  sessionDir: string,
  key: string,
  cap = INBOX_ACK_CAP,
  onPersistError?: (e: unknown) => void
): void {
  const state = loadAckFile(sessionDir)
  if (state.acked.includes(key)) return
  state.seen = state.seen.filter((k) => k !== key)
  state.acked = [...state.acked, key].slice(-cap)
  saveAckFile(sessionDir, state, onPersistError)
}

export interface UnscopedInboxDiscard {
  /** History entries thrown away with the unkeyed file. */
  historyEntries: number
  /** seen + acked keys thrown away with the unkeyed ack file. */
  ackKeys: number
}

/**
 * Remove the unkeyed inbox files an earlier layout wrote at the state ROOT
 * (`<stateDir>/inbox-history.json`, `<stateDir>/inbox-ack.json`). Their
 * content is an unattributable mix of every window that ever ran here, so it
 * is discarded rather than split across groups by guesswork; the caller logs
 * the returned counts. Returns null when neither file exists (the steady
 * state after the first run). A removal failure propagates: the caller
 * reports it and the next start retries.
 */
export function discardUnscopedInboxFiles(stateDir: string): UnscopedInboxDiscard | null {
  const historyFile = join(stateDir, FILE)
  const ackFile = join(stateDir, ACK_FILE)
  const hadHistory = existsSync(historyFile)
  const hadAck = existsSync(ackFile)
  if (!hadHistory && !hadAck) return null
  const historyEntries = hadHistory ? loadInboxHistory(stateDir).length : 0
  let ackKeys = 0
  if (hadAck) {
    const { seen, acked } = loadAckFile(stateDir)
    ackKeys = seen.length + acked.length
  }
  if (hadHistory) rmSync(historyFile)
  if (hadAck) rmSync(ackFile)
  return { historyEntries, ackKeys }
}

/**
 * The Courrier badge's message count, from what main holds: the journal plus
 * the batches whose journal write failed (they were shown, they exist nowhere
 * else). Deduplicated by broker id and capped like the renderer's list.
 */
export function countPendingInbox(
  history: readonly InboxMessage[],
  unjournaled: readonly InboxMessage[],
  ackState: Readonly<Record<string, InboxAckStatus>>
): number {
  const byId = new Map<number, InboxMessage>()
  for (const message of [...history, ...unjournaled]) if (!byId.has(message.id)) byId.set(message.id, message)
  return countPendingInboxMessages([...byId.values()].slice(-INBOX_HISTORY_CAP), ackState)
}

// A seen -> acked move keeps the ack file's size, so the size and a millisecond mtime alone can miss it;
// writeFileAtomic renames a new file into place, so the inode changes on every write.
function fileStamp(file: string): string {
  const stat = statSync(file, { bigint: true, throwIfNoEntry: false })
  return stat ? `${stat.ino}:${stat.mtimeNs}:${stat.size}` : 'absent'
}

/** Avoid reparsing both journals on every five-second Avatar heartbeat. */
export function pendingInboxCounter(
  sessionDir: () => string,
  unjournaled: () => readonly InboxMessage[],
  onReadError: InboxReadErrorSink = traceInboxRead
): () => number {
  let lastKey = ''
  let lastCount = 0
  return () => {
    const dir = sessionDir()
    const pending = unjournaled()
    const key = [dir, fileStamp(inboxHistoryFile(dir)), fileStamp(inboxAckFile(dir)), pending.map((m) => m.id).join(',')].join('|')
    if (key !== lastKey) {
      lastCount = countPendingInbox(loadInboxHistory(dir, onReadError), pending, loadAckState(dir, onReadError))
      lastKey = key
    }
    return lastCount
  }
}
