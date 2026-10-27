// SESSION-scoped Deck state (desktop/src/main/session-state.ts +
// inbox-store.ts): two Kory windows share one userData, so each window's
// inbox lives under sessions/<groupId>/ and dies with the window. Three
// behaviours guarded here: isolation (a group's inbox is never read by
// another), a per-group cap (a chatty group never evicts another's history)
// and the cleanup (clean exit removes, the startup sweep removes only what is
// older than the TTL -- a RECENT orphan is a second live window and survives).
// Node builtins only (no electron), dirs and clock injected.

import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import {
  appendInboxHistory,
  appendAckedKey,
  discardUnscopedInboxFiles,
  inboxAckFile,
  inboxHistoryFile,
  loadAckState,
  loadInboxHistory
} from '../desktop/src/main/inbox-store.ts'
import {
  createSessionDirAccessor,
  DEFAULT_SESSION_STATE_TTL_DAYS,
  removeSessionStateDir,
  SESSION_STATE_SUBDIR,
  sessionStateDir,
  sessionStateTtlMs,
  sweepSessionStateDirs,
  touchSessionStateDir
} from '../desktop/src/main/session-state.ts'
import type { InboxMessage } from '../desktop/src/shared/types.ts'

const DAY = 86_400_000
/** Frozen clock: every fixture timestamp derives from it (TESTING.md, calendar rot). */
const NOW = Date.UTC(2026, 8, 6, 12, 0, 0)
const TTL = DEFAULT_SESSION_STATE_TTL_DAYS * DAY

const GROUP_A = 'a'.repeat(32)
const GROUP_B = 'b'.repeat(32)
const GROUP_C = 'c'.repeat(32)

function stateDir(): string {
  return mkdtempSync(join(tmpdir(), 'cp-session-state-'))
}

function msg(id: number, text = `t${id}`): InboxMessage {
  return { id, from: 'coder-1', text, sentAt: new Date(NOW + id).toISOString() }
}

/** A session directory whose newest mtime (dir + children) is `ageMs` old. */
function seedSessionDir(root: string, groupId: string, ageMs: number): string {
  const dir = sessionStateDir(root, groupId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'inbox-history.json'), '[]')
  const t = new Date(NOW - ageMs)
  utimesSync(join(dir, 'inbox-history.json'), t, t)
  utimesSync(dir, t, t)
  return dir
}

const noReport = (message: string, error: unknown): void => {
  throw new Error(`unexpected report: ${message}: ${String(error)}`)
}

// ----- 9.1 isolation -----

test('9.1 isolation: an inbox written under one group is never read by another', () => {
  const root = stateDir()
  appendInboxHistory(sessionStateDir(root, GROUP_A), [msg(1), msg(2)])
  appendInboxHistory(sessionStateDir(root, GROUP_B), [msg(3)])
  expect(
    loadInboxHistory(sessionStateDir(root, GROUP_A)).map((m) => m.id),
    "group A's inbox must hold only what group A drained -- an inbox of one group is never read by another"
  ).toEqual([1, 2])
  expect(
    loadInboxHistory(sessionStateDir(root, GROUP_B)).map((m) => m.id),
    "group B's inbox must hold only what group B drained"
  ).toEqual([3])
  expect(
    loadInboxHistory(root),
    'nothing may land at the shared state root: that is the unkeyed file both windows read'
  ).toEqual([])
})

test('9.1 isolation: ack state is per group too (acking in one window never marks the other)', () => {
  const root = stateDir()
  appendAckedKey(sessionStateDir(root, GROUP_A), 'message:1:x')
  expect(loadAckState(sessionStateDir(root, GROUP_A))).toEqual({ 'message:1:x': 'acked' })
  expect(
    loadAckState(sessionStateDir(root, GROUP_B)),
    'an ack recorded by one group must be invisible to another'
  ).toEqual({})
})

test('the constructed paths live under sessions/<groupId>/, checked on the path, not the name', () => {
  const root = stateDir()
  const expectedPrefix = join(root, SESSION_STATE_SUBDIR, GROUP_A) + sep
  for (const file of [inboxHistoryFile(sessionStateDir(root, GROUP_A)), inboxAckFile(sessionStateDir(root, GROUP_A))]) {
    expect(file.startsWith(expectedPrefix), `${file} must be under ${expectedPrefix}`).toBe(true)
  }
})

test('sessionStateDir refuses anything but a 32-hex group id (the only value-derived path segment)', () => {
  const root = stateDir()
  for (const bad of ['', '..', '../etc', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), `${'a'.repeat(31)}/`]) {
    expect(() => sessionStateDir(root, bad), `group id ${JSON.stringify(bad)} must be refused`).toThrow(
      /refusing group id/
    )
  }
  expect(sessionStateDir(root, GROUP_A)).toBe(join(root, SESSION_STATE_SUBDIR, GROUP_A))
})

// ----- 9.2 cap per group -----

test('9.2 cap per group: a chatty group evicts its own oldest entries, never another group history', () => {
  const root = stateDir()
  appendInboxHistory(sessionStateDir(root, GROUP_B), [msg(100), msg(101)], 3)
  appendInboxHistory(sessionStateDir(root, GROUP_A), [msg(1), msg(2), msg(3)], 3)
  appendInboxHistory(sessionStateDir(root, GROUP_A), [msg(4), msg(5)], 3)
  expect(
    loadInboxHistory(sessionStateDir(root, GROUP_A)).map((m) => m.id),
    'the cap applies within the chatty group (oldest first out)'
  ).toEqual([3, 4, 5])
  expect(
    loadInboxHistory(sessionStateDir(root, GROUP_B)).map((m) => m.id),
    "the chatty group's traffic must not evict the quiet group's history"
  ).toEqual([100, 101])
})

// ----- 9.3 cleanup -----

test('9.3 clean exit: removeSessionStateDir drops the whole group directory, and only it', () => {
  const root = stateDir()
  appendInboxHistory(sessionStateDir(root, GROUP_A), [msg(1)])
  appendAckedKey(sessionStateDir(root, GROUP_A), 'message:1:x')
  appendInboxHistory(sessionStateDir(root, GROUP_B), [msg(2)])
  expect(removeSessionStateDir(root, GROUP_A, noReport)).toBe(true)
  expect(existsSync(sessionStateDir(root, GROUP_A)), 'the exiting group directory must be gone').toBe(false)
  expect(
    loadInboxHistory(sessionStateDir(root, GROUP_B)).map((m) => m.id),
    "another group's directory must survive a sibling's clean exit"
  ).toEqual([2])
  expect(removeSessionStateDir(root, GROUP_A, noReport), 'a second removal is a no-op, not an error').toBe(false)
})

test('9.3 sweep: an orphan older than the TTL is removed', () => {
  const root = stateDir()
  seedSessionDir(root, GROUP_B, TTL + DAY)
  const result = sweepSessionStateDirs(root, { ownGroupId: GROUP_A, ttlMs: TTL, now: NOW, report: noReport })
  expect(result.removed, 'a directory older than the TTL is a crashed window, swept').toEqual([GROUP_B])
  expect(existsSync(sessionStateDir(root, GROUP_B))).toBe(false)
})

test('9.3 sweep: a RECENT orphan survives -- it is a second live window this one has never heard of', () => {
  const root = stateDir()
  seedSessionDir(root, GROUP_B, 5 * 60_000)
  const result = sweepSessionStateDirs(root, { ownGroupId: GROUP_A, ttlMs: TTL, now: NOW, report: noReport })
  expect(
    existsSync(sessionStateDir(root, GROUP_B)),
    'a group directory fresher than the TTL must survive the sweep even though this window does not own it: another live window does'
  ).toBe(true)
  expect(result.removed).toEqual([])
  expect(result.kept).toEqual([GROUP_B])
})

test('9.3 sweep: the boundary is the TTL itself (exactly TTL old is kept, one second past it is removed)', () => {
  const root = stateDir()
  // One second, not one millisecond: a filesystem with 1 s mtime granularity
  // would round both stamps to the same instant.
  seedSessionDir(root, GROUP_B, TTL)
  seedSessionDir(root, GROUP_C, TTL + 1000)
  const result = sweepSessionStateDirs(root, { ownGroupId: GROUP_A, ttlMs: TTL, now: NOW, report: noReport })
  expect(result.kept).toEqual([GROUP_B])
  expect(result.removed).toEqual([GROUP_C])
})

test('9.3 sweep: a child fresher than the directory keeps the directory alive', () => {
  const root = stateDir()
  const dir = seedSessionDir(root, GROUP_B, TTL + DAY)
  // The directory inode is old but a file inside was written recently: a
  // platform whose rename does not bump the directory mtime must not lose it.
  const fresh = new Date(NOW - 60_000)
  utimesSync(join(dir, 'inbox-history.json'), fresh, fresh)
  const result = sweepSessionStateDirs(root, { ownGroupId: GROUP_A, ttlMs: TTL, now: NOW, report: noReport })
  expect(result.kept, 'freshness is the newest mtime of the directory and its children').toEqual([GROUP_B])
})

test('9.3 sweep: this window own directory is never a candidate, whatever its age', () => {
  const root = stateDir()
  seedSessionDir(root, GROUP_A, TTL + 30 * DAY)
  const result = sweepSessionStateDirs(root, { ownGroupId: GROUP_A, ttlMs: TTL, now: NOW, report: noReport })
  expect(existsSync(sessionStateDir(root, GROUP_A)), 'own group directory must survive its own startup sweep').toBe(true)
  expect(result.kept).toEqual([GROUP_A])
})

test('9.3 sweep: entries that are not a group directory are left alone and listed as foreign', () => {
  const root = stateDir()
  const sessions = join(root, SESSION_STATE_SUBDIR)
  mkdirSync(join(sessions, 'not-a-group'), { recursive: true })
  writeFileSync(join(sessions, 'stray.json'), '{}')
  writeFileSync(join(sessions, GROUP_C), 'a file wearing a group name')
  const old = new Date(NOW - TTL - 30 * DAY)
  for (const p of [join(sessions, 'not-a-group'), join(sessions, 'stray.json'), join(sessions, GROUP_C)]) utimesSync(p, old, old)
  const result = sweepSessionStateDirs(root, { ownGroupId: GROUP_A, ttlMs: TTL, now: NOW, report: noReport })
  expect(result.removed).toEqual([])
  expect(result.foreign.sort()).toEqual([GROUP_C, 'not-a-group', 'stray.json'].sort())
  expect(readdirSync(sessions).sort()).toEqual([GROUP_C, 'not-a-group', 'stray.json'].sort())
})

test('9.3 sweep: no sessions/ dir yet is the empty result, not an error', () => {
  const root = stateDir()
  expect(sweepSessionStateDirs(root, { ownGroupId: GROUP_A, ttlMs: TTL, now: NOW, report: noReport })).toEqual({
    removed: [],
    kept: [],
    foreign: []
  })
})

test('9.3 clean exit: once the accessor is closed, no writer resuming late can recreate the removed directory', () => {
  const root = stateDir()
  const accessor = createSessionDirAccessor({ stateDir: () => root, groupId: () => GROUP_A })
  appendInboxHistory(accessor(), [msg(1)])
  appendAckedKey(accessor(), 'message:1:x')
  expect(accessor.isClosed()).toBe(false)
  accessor.close()
  expect(accessor.isClosed()).toBe(true)
  expect(removeSessionStateDir(root, GROUP_A, noReport)).toBe(true)
  const lateWriters: Array<[string, () => void]> = [
    ['appendInboxHistory', () => appendInboxHistory(accessor(), [msg(2)])],
    ['appendAckedKey', () => appendAckedKey(accessor(), 'message:2:x')],
    ['loadAckState', () => loadAckState(accessor())]
  ]
  for (const [name, write] of lateWriters) {
    expect(write, `${name} after close must throw into its caller's error sink, never write`).toThrow(/session state is closed/)
  }
  expect(
    existsSync(sessionStateDir(root, GROUP_A)),
    'no late writer may recreate the session directory after the clean exit removed it'
  ).toBe(false)
})

test('the accessor follows the live group id (a scope adopted later is a different directory)', () => {
  const root = stateDir()
  let gid = GROUP_A
  const accessor = createSessionDirAccessor({ stateDir: () => root, groupId: () => gid })
  expect(accessor()).toBe(sessionStateDir(root, GROUP_A))
  gid = GROUP_B
  expect(accessor()).toBe(sessionStateDir(root, GROUP_B))
})

test('touchSessionStateDir creates the directory and stamps it with the injected clock', () => {
  const root = stateDir()
  const dir = sessionStateDir(root, GROUP_A)
  touchSessionStateDir(dir, NOW - 3 * DAY)
  expect(existsSync(dir)).toBe(true)
  const stamped = statSync(dir).mtimeMs
  expect(Math.abs(stamped - (NOW - 3 * DAY)) < 2000, `mtime ${stamped} must reflect the injected clock`).toBe(true)
  // A keepalive touch moves it forward, which is what keeps an idle live
  // window out of another window's sweep.
  touchSessionStateDir(dir, NOW)
  expect(statSync(dir).mtimeMs > stamped).toBe(true)
})

// ----- TTL parsing -----

test('sessionStateTtlMs: unset is the 7-day default, silently', () => {
  let invalid: string | null = null
  expect(sessionStateTtlMs(undefined, (raw) => (invalid = raw))).toBe(7 * DAY)
  expect(invalid).toBeNull()
})

test('sessionStateTtlMs: a usable override is honoured, fractions included', () => {
  expect(sessionStateTtlMs('2', noReportTtl)).toBe(2 * DAY)
  expect(sessionStateTtlMs('0.5', noReportTtl)).toBe(DAY / 2)
  expect(sessionStateTtlMs(' 1 ', noReportTtl)).toBe(DAY)
})

test('sessionStateTtlMs: NaN, empty, zero, negative and Infinity are reported and fall back to the default', () => {
  for (const raw of ['abc', '', '   ', '0', '-1', 'Infinity', 'NaN']) {
    let invalid: string | null = null
    const ms = sessionStateTtlMs(raw, (r) => (invalid = r))
    expect(ms, `override ${JSON.stringify(raw)} must fall back to the default, never to 0 (sweep everything) or NaN (sweep nothing)`).toBe(
      7 * DAY
    )
    expect(invalid, `override ${JSON.stringify(raw)} must be reported as invalid`).toBe(raw)
  }
})

function noReportTtl(raw: string): void {
  throw new Error(`unexpected invalid TTL report: ${raw}`)
}

// ----- unkeyed legacy files -----

test('discardUnscopedInboxFiles removes the root-level files and counts what was thrown away', () => {
  const root = stateDir()
  appendInboxHistory(root, [msg(1), msg(2), msg(3)])
  appendAckedKey(root, 'message:1:x')
  appendAckedKey(root, 'message:2:x')
  // A session directory next to them is untouched.
  appendInboxHistory(sessionStateDir(root, GROUP_A), [msg(9)])
  const discarded = discardUnscopedInboxFiles(root)
  expect(discarded).toEqual({ historyEntries: 3, ackKeys: 2 })
  expect(existsSync(inboxHistoryFile(root)), 'the unkeyed history file must be gone').toBe(false)
  expect(existsSync(inboxAckFile(root)), 'the unkeyed ack file must be gone').toBe(false)
  expect(loadInboxHistory(sessionStateDir(root, GROUP_A)).map((m) => m.id)).toEqual([9])
  expect(discardUnscopedInboxFiles(root), 'nothing left to discard is null, the steady state').toBeNull()
})

test('discardUnscopedInboxFiles: a corrupt legacy file is still removed, counted as 0', () => {
  const root = stateDir()
  writeFileSync(inboxHistoryFile(root), '{not json')
  expect(discardUnscopedInboxFiles(root)).toEqual({ historyEntries: 0, ackKeys: 0 })
  expect(existsSync(inboxHistoryFile(root))).toBe(false)
})
