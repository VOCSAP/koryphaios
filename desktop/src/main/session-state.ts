// SESSION-scoped Deck state: what THIS window lived through, keyed by the
// window's group id and gone with the window. userData is shared by every Kory
// window on the machine, so a session-scoped file written at the state root
// carries no key and is read by every other window; here each group gets its
// own directory, and that directory is a cache of the running session, never a
// history -- removed at exit for every scope kind, swept by age when the exit
// was not clean.
//
// Pure: node fs/path only, no electron import. The state root and the clock
// are injected by index.ts so this stays bun-testable on a throwaway tmp dir.

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'

/** `<stateDir>/sessions/<groupId>/` holds every SESSION-scoped file of one window. */
export const SESSION_STATE_SUBDIR = 'sessions'

/** Env override for the orphan sweep, in days (fractions allowed). */
export const SESSION_STATE_TTL_DAYS_ENV = 'KORY_SESSION_STATE_TTL_DAYS'
export const DEFAULT_SESSION_STATE_TTL_DAYS = 7

/** computeGroupId output: sha256 truncated to 32 hex chars, safe as a directory name. */
const GROUP_ID_RE = /^[0-9a-f]{32}$/

/**
 * The per-window directory. Throws on anything but a group id of the exact
 * shape computeScope mints: a group id is the only path segment this module
 * ever builds from a value, and refusing here keeps `..` or a separator out
 * of every session-scoped path at once.
 */
export function sessionStateDir(stateDir: string, groupId: string): string {
  if (!GROUP_ID_RE.test(groupId)) {
    throw new Error(`session state: refusing group id ${JSON.stringify(groupId)} (expected 32 hex chars)`)
  }
  return join(stateDir, SESSION_STATE_SUBDIR, groupId)
}

export type SessionDirAccessor = (() => string) & {
  /** After close() every call throws: no writer can recreate the removed directory. */
  close(): void
  isClosed(): boolean
}

/**
 * The single gate every session-scoped writer goes through. Closing it is
 * the first step of the quit path: a continuation still awaiting the broker
 * (a purge, a delete, an ack) resumes after the directory was removed and
 * would otherwise mkdir it back, with whatever it was about to write, until
 * the next sweep. Refusing loudly lands in the caller's own error sink.
 */
export function createSessionDirAccessor(deps: { stateDir: () => string; groupId: () => string }): SessionDirAccessor {
  let closed = false
  const accessor = (() => {
    if (closed) throw new Error('session state is closed: the window is quitting')
    return sessionStateDir(deps.stateDir(), deps.groupId())
  }) as SessionDirAccessor
  accessor.close = () => {
    closed = true
  }
  accessor.isClosed = () => closed
  return accessor
}

/**
 * Sweep TTL from the env override, in milliseconds. An unset variable is the
 * default silently; a set-but-unusable one (empty, NaN, zero, negative,
 * Infinity) reports through `onInvalid` and falls back to the default, so a
 * typo never turns into "sweep everything" (0) or "sweep nothing".
 */
export function sessionStateTtlMs(raw: string | undefined, onInvalid: (raw: string) => void): number {
  const dayMs = 86_400_000
  if (raw === undefined) return DEFAULT_SESSION_STATE_TTL_DAYS * dayMs
  const days = raw.trim() === '' ? NaN : Number(raw)
  if (!Number.isFinite(days) || days <= 0) {
    onInvalid(raw)
    return DEFAULT_SESSION_STATE_TTL_DAYS * dayMs
  }
  return days * dayMs
}

/**
 * Create the directory if missing and stamp it with `now`. The sweep below
 * reads freshness off mtimes, so a live window with no inbox traffic keeps
 * its directory alive by touching it (at startup and on a slow keepalive),
 * never by being known to the other window.
 */
export function touchSessionStateDir(dir: string, now: number): void {
  mkdirSync(dir, { recursive: true })
  const t = new Date(now)
  utimesSync(dir, t, t)
}

/**
 * Newest mtime among the directory itself and its direct children. A child
 * that cannot be stat'ed is reported, never skipped silently: dropping it
 * yields an OLDER answer, and older is the direction that sweeps.
 */
function newestMtimeMs(dir: string, report: (message: string, error: unknown) => void): number {
  let newest = statSync(dir).mtimeMs
  for (const name of readdirSync(dir)) {
    try {
      const m = statSync(join(dir, name)).mtimeMs
      if (m > newest) newest = m
    } catch (e) {
      report(`session state sweep: cannot stat ${join(dir, name)} (freshness may read older than it is)`, e)
    }
  }
  return newest
}

export interface SessionStateSweepOptions {
  /** This window's group: never a sweep candidate, whatever its mtime. */
  ownGroupId: string
  ttlMs: number
  now: number
  /** Failure sink (index.ts wires reportError). A failed removal is reported, never thrown. */
  report: (message: string, error: unknown) => void
}

export interface SessionStateSweepResult {
  /** Group ids whose directory was removed (older than the TTL). */
  removed: string[]
  /** Group ids kept: fresher than the TTL, which is what a second live window looks like. */
  kept: string[]
  /** Entries under sessions/ that are not a group directory: left alone. */
  foreign: string[]
}

/**
 * Startup sweep of `sessions/`: remove every group directory whose newest
 * mtime is older than the TTL. Age is the ONLY criterion -- never "a group I
 * do not know", because a second live window owns a group this one has never
 * heard of, and removing it would empty that window's inbox under its feet.
 */
export function sweepSessionStateDirs(
  stateDir: string,
  opts: SessionStateSweepOptions
): SessionStateSweepResult {
  const result: SessionStateSweepResult = { removed: [], kept: [], foreign: [] }
  const root = join(stateDir, SESSION_STATE_SUBDIR)
  if (!existsSync(root)) return result
  let names: string[]
  try {
    names = readdirSync(root)
  } catch (e) {
    opts.report('session state sweep: cannot list sessions dir', e)
    return result
  }
  for (const name of names) {
    if (!GROUP_ID_RE.test(name)) {
      result.foreign.push(name)
      continue
    }
    if (name === opts.ownGroupId) {
      result.kept.push(name)
      continue
    }
    const dir = join(root, name)
    try {
      if (!statSync(dir).isDirectory()) {
        result.foreign.push(name)
        continue
      }
      if (opts.now - newestMtimeMs(dir, opts.report) <= opts.ttlMs) {
        result.kept.push(name)
        continue
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
      result.removed.push(name)
    } catch (e) {
      opts.report(`session state sweep: could not inspect or remove ${name}`, e)
    }
  }
  return result
}

/**
 * Clean exit: drop this window's directory. One rule for every scope kind --
 * a custom scope's group id is stable, the peers behind it are not, so a
 * message kept across sessions would invite an answer to a question nobody
 * is asking anymore. Returns whether anything existed; a removal failure is
 * reported, never thrown, because this runs on the quit path.
 */
export function removeSessionStateDir(
  stateDir: string,
  groupId: string,
  report: (message: string, error: unknown) => void
): boolean {
  let dir = groupId
  try {
    dir = sessionStateDir(stateDir, groupId)
    if (!existsSync(dir)) return false
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    return true
  } catch (e) {
    report(`session state: could not remove ${dir}`, e)
    return false
  }
}
