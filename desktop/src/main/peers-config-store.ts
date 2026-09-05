// Read and write the claude-peers CORE config file (config.json) -- the same
// file server.ts, cli.ts and every non-Kory session read to find their broker.
// The Deck only ever touches ONE key of it, `offline_replica`, and only from
// the Settings > Broker panel.
//
// Node builtins only (no electron, no @shared alias) so it is unit-testable
// under bun test on a throwaway file. The path is resolved MAIN-side by the
// caller (peersConfigPath) and is never a renderer argument; the only value
// crossing the IPC boundary is the boolean, re-validated here.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PeersConfigSummary } from '../shared/types'
import { deckBrokerMode, parseBooleanEnvFlag, readPeersConfig } from './broker-client'
import { writeFileAtomic } from './atomic-write'
import { reportError } from './log'


/**
 * What the Broker settings panel renders: the resolved mode, the endpoint, a
 * yes/no token marker and which env variables are deciding instead of the file.
 *
 * `hasToken` is a MARKER, never the token: the same rule as the local-provider
 * API keys (`hasKey`, C29) -- a secret that reaches the renderer can reach a
 * paired phone, a screenshot and a log line.
 */
export function readPeersConfigSummary(
  path: string,
  env: NodeJS.ProcessEnv = process.env
): PeersConfigSummary {
  const file = readPeersConfig(path)
  const url = env.CLAUDE_PEERS_BROKER_URL ?? file.broker_url ?? ''
  const token = env.CLAUDE_PEERS_BROKER_TOKEN ?? file.broker_token ?? ''
  return {
    // One decision of the mode for the whole app: the panel must show what the
    // sessions will actually do, not a second reading of the same keys.
    mode: deckBrokerMode(env, path),
    brokerUrl: url ? url : null,
    hasToken: token !== '',
    offlineReplica: file.offline_replica === true,
    // Env over file, same vocabulary as every other claude-peers flag, so the
    // panel reports what the broker will actually do rather than what the file
    // alone says. A word the parser does not recognize decides nothing.
    serveReplicas: parseBooleanEnvFlag(env.CLAUDE_PEERS_SERVE_REPLICAS) ?? file.serve_replicas === true,
    forcedByEnv: {
      // Mere PRESENCE, empty string included: the resolver reads the variable
      // before the file whatever it holds, so `CLAUDE_PEERS_BROKER_URL=` forces
      // local mode just as loudly as a real URL would force remote.
      brokerUrl: env.CLAUDE_PEERS_BROKER_URL !== undefined,
      // A DECISION, not a presence: the flag parser falls back to the file on
      // a word it does not recognize, so `=maybe` forces nothing and the
      // checkbox must stay live.
      offlineReplica: parseBooleanEnvFlag(env.CLAUDE_PEERS_OFFLINE_REPLICA) !== undefined
    }
  }
}

/**
 * The lock's environment, injected so its timing is testable without racing
 * real processes: the clock, the liveness probe, the synchronous wait and the
 * pid this process records in the lock file.
 */
export interface ConfigLockDeps {
  now(): number
  isAlive(pid: number): boolean
  sleep(ms: number): void
  pid: number
}

/** A lock older than this is a candidate for takeover; a live pid still wins. */
export const LOCK_STALE_MS = 10_000
export const LOCK_ATTEMPTS = 20
export const LOCK_RETRY_MS = 50

/**
 * EPERM means a process exists that we are not allowed to signal -- alive, not
 * absent. Only ESRCH (and a pid nothing answers for) makes a lock takeable.
 */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Synchronous on purpose: the read-modify-write this lock protects is one
 * synchronous statement sequence, and an `await` in the middle of it would let
 * a second IPC call interleave between the read and the write -- the very race
 * the lock exists to close, reintroduced inside a single process.
 */
function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function lockDeps(overrides: Partial<ConfigLockDeps>): ConfigLockDeps {
  return {
    now: Date.now,
    isAlive: processIsAlive,
    sleep: blockingSleep,
    pid: process.pid,
    ...overrides
  }
}

/**
 * Who holds the lock, or null when it is gone / unreadable (the caller simply
 * retries). `pid` is null for a lock whose content cannot be attributed to a
 * process, and `at` falls back to the file's mtime for the same reason: a lock
 * that says nothing must still be able to EXPIRE, or a process killed halfway
 * through creating it wedges every window on the machine forever.
 */
function readLockHolder(lockPath: string): { pid: number | null; at: number } | null {
  let raw: string
  let mtime: number
  try {
    raw = readFileSync(lockPath, 'utf-8')
    mtime = statSync(lockPath).mtimeMs
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      reportError('peers-config', `cannot inspect the lock file ${lockPath}`, e)
    }
    return null
  }
  // An EMPTY file is the ordinary race, not a fault: `wx` publishes the lock
  // the instant it is created, so a reader arriving between the create and the
  // body write sees zero bytes. Unattributed like a malformed one, but silent
  // -- tracing it would put a line in the journal on every contended write.
  if (raw.trim() === '') return { pid: null, at: mtime }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (e) {
    reportError('peers-config', `${lockPath} is not valid JSON; treated as unattributed`, e)
    return { pid: null, at: mtime }
  }
  const r = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>
  const pid = typeof r.pid === 'number' && Number.isInteger(r.pid) && r.pid > 0 ? r.pid : null
  const at = typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : mtime
  return { pid, at }
}

/** True when an abandoned lock was removed and the caller may retry at once. */
function takeOverIfStale(lockPath: string, deps: ConfigLockDeps): boolean {
  const holder = readLockHolder(lockPath)
  if (holder === null) return false
  if (deps.now() - holder.at < LOCK_STALE_MS) return false
  // An unattributed lock expires on age alone. An attributed one waits for its
  // process to be gone -- except when the pid is OURS: the critical section is
  // synchronous and always released in a finally, so a lock naming this
  // process while nobody in it holds one is a corpse of a previous run whose
  // pid the OS recycled, and honouring it would wedge the file permanently.
  if (holder.pid !== null && holder.pid !== deps.pid && deps.isAlive(holder.pid)) return false
  try {
    rmSync(lockPath, { force: true })
  } catch (e) {
    reportError('peers-config', `cannot remove the stale lock ${lockPath}`, e)
    return false
  }
  return true
}

/**
 * Exclusive, INTER-PROCESS lock around the read-modify-write below: two Kory
 * windows (or a window and the CLI) reading the same file before either has
 * written it would each preserve "every other key" as of their own read, and
 * the later write would silently drop whatever the earlier one added.
 * O_EXCL (`wx`) is the exclusion primitive -- the create either wins or fails,
 * with no window between a test and a set.
 */
function acquireConfigLock(path: string, deps: ConfigLockDeps): string {
  const lockPath = `${path}.lock`
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: deps.pid, at: deps.now() }), {
        flag: 'wx',
        mode: 0o600
      })
      return lockPath
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
        reportError('peers-config', `cannot create the lock file ${lockPath}`, e)
        throw new Error('claude-peers config.json could not be locked')
      }
    }
    // Held: take it over if it was abandoned, otherwise let the holder finish.
    if (!takeOverIfStale(lockPath, deps)) deps.sleep(LOCK_RETRY_MS)
  }
  reportError(
    'peers-config',
    `${lockPath} is still held after ${LOCK_ATTEMPTS} attempts; the replica opt-in was not saved`
  )
  // The recovery belongs IN the message: the operator sees this text and
  // nothing else (it crosses the IPC boundary into a raw error toast), and
  // "another process is writing" alone reads as a permanent state rather than
  // as something a second click resolves.
  throw new Error(
    'another process is writing the claude-peers config; a lock left behind by a ' +
      `crashed writer is taken over after ${LOCK_STALE_MS / 1000} s, so retry in a few seconds`
  )
}

function releaseConfigLock(lockPath: string): void {
  try {
    rmSync(lockPath, { force: true })
  } catch (e) {
    reportError('peers-config', `cannot release the lock file ${lockPath}`, e)
  }
}

/**
 * Read-modify-write the `offline_replica` opt-in, preserving every other key.
 *
 * Three refusals, all throwing so the operator gets a toast instead of a
 * silent no-op:
 *
 * - a non-boolean value (the one renderer-supplied argument of this module);
 * - a file that exists but does not parse, or parses to something that is not
 *   a JSON object: overwriting it would destroy a broker_url and a token
 *   nobody could read back, so a config we failed to understand is left alone;
 * - an unreadable/unwritable file.
 *
 * An ABSENT file is not a failure: the opt-in is the first key of a config the
 * operator never created, so the directory and the file are created at 0600.
 *
 * A fourth one comes from the lock: a file another process is writing right
 * now is left to it rather than read-modify-written underneath it.
 */
export function writeOfflineReplica(
  path: string,
  value: unknown,
  deps: Partial<ConfigLockDeps> = {}
): void {
  if (typeof value !== 'boolean') {
    throw new Error(`offline_replica must be a boolean, received ${typeof value}`)
  }
  // Before the lock: the lock file is a sibling of the config, so its own
  // directory must exist even when the config itself never did.
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch (e) {
    reportError('peers-config', `cannot create the directory of ${path}`, e)
    throw new Error('claude-peers config.json could not be written')
  }
  const lockPath = acquireConfigLock(path, lockDeps(deps))
  try {
    let current: Record<string, unknown> = {}
    if (existsSync(path)) {
      let raw: string
      try {
        raw = readFileSync(path, 'utf-8')
      } catch (e) {
        reportError('peers-config', `cannot read ${path}; the replica opt-in was not written`, e)
        throw new Error('claude-peers config.json could not be read')
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw) as unknown
      } catch (e) {
        reportError('peers-config', `${path} is not valid JSON; refusing to overwrite it`, e)
        throw new Error('claude-peers config.json is not valid JSON')
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reportError('peers-config', `${path} is not a JSON object; refusing to overwrite it`)
        throw new Error('claude-peers config.json is not a JSON object')
      }
      current = parsed as Record<string, unknown>
    }
    const next = { ...current, offline_replica: value }
    try {
      // 0600 like every other file that can carry a bearer token, and atomic so
      // a crash mid-write cannot leave the sessions without a broker_url.
      writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    } catch (e) {
      reportError('peers-config', `cannot write ${path}; the replica opt-in was not saved`, e)
      throw new Error('claude-peers config.json could not be written')
    }
  } finally {
    releaseConfigLock(lockPath)
  }
}
