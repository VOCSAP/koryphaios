// The Deck starts the loopback broker itself when no session has: without it
// a Deck opened before any tile cannot read the roadmap (local or replica),
// and a replica cannot replicate or federate. Same contract as server.ts's
// ensureBroker: loopback only, a remote broker is never spawned here.
//
// The broker script is located from GLOBAL configuration only -- the user's
// ~/.claude.json `claude-peers` MCP entry (what every session launches, so the
// Deck spawns the same version), then the repository the Deck itself lives
// in. A project's .mcp.json is never read: a cloned repo must not decide what
// this process executes.

import { resolve } from 'node:path'

export type DeckBrokerModeLike = 'local' | 'remote' | 'replica'

export interface BrokerScriptLocation {
  script: string
  /** The executable the MCP entry names for server.ts, reused for broker.ts. */
  command: string
  /**
   * The CLAUDE_PEERS_* variables the MCP entry sets. A session-spawned broker
   * inherits them through server.ts; without them the Deck would start a
   * broker in a different mode than the one the sessions get.
   */
  env: Record<string, string>
  source: 'claude-json' | 'app-root'
}

export interface LocateDeps {
  readFile: (path: string) => string | null
  exists: (path: string) => boolean
  /** The operator's home directory, so a hand-written `~/...` entry resolves. */
  homeDir: string
  /** Trace sink for a claude.json that cannot be parsed (the fallback still runs). */
  warn: (message: string) => void
}

/**
 * The claude-peers entry of the user-scope ~/.claude.json, when it names a
 * server.ts: broker.ts is its sibling. Only `command` and `args` are read, only
 * a string arg ending in server.ts qualifies, and the sibling must exist.
 */
export function locateBrokerScript(
  claudeJsonPath: string,
  appRoot: string,
  deps: LocateDeps
): BrokerScriptLocation | null {
  const raw = deps.readFile(claudeJsonPath)
  if (raw !== null) {
    let parsed: unknown = null
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      deps.warn(`${claudeJsonPath} is not valid JSON, the claude-peers MCP entry cannot be read: ${e instanceof Error ? e.message : String(e)}`)
      parsed = null
    }
    const entry = mcpEntry(parsed, 'claude-peers')
    if (entry) {
      const serverArg = entry.args.find((a) => /(^|[\\/])server\.ts$/.test(a))
      if (serverArg) {
        // `claude mcp add ... -- bun ~/koryphaios/server.ts` stores whatever the
        // shell handed it, normally already absolute; a file edited by hand can
        // still carry the tilde, which no filesystem call expands.
        const expanded = /^~[\\/]/.test(serverArg) ? deps.homeDir + serverArg.slice(1) : serverArg
        // Suffix swap rather than dirname/join: the entry was written on the
        // machine it names, in that platform's separator, which the posix
        // path module of a Linux CI run would not recognise.
        const script = expanded.slice(0, -'server.ts'.length) + 'broker.ts'
        if (deps.exists(script)) {
          return { script, command: entry.command, env: entry.env, source: 'claude-json' }
        }
      }
    }
  }
  const sibling = resolve(appRoot, '..', 'broker.ts')
  if (deps.exists(sibling)) return { script: sibling, command: 'bun', env: {}, source: 'app-root' }
  return null
}

function mcpEntry(
  parsed: unknown,
  name: string
): { command: string; args: string[]; env: Record<string, string> } | null {
  if (!parsed || typeof parsed !== 'object') return null
  const servers = (parsed as { mcpServers?: unknown }).mcpServers
  if (!servers || typeof servers !== 'object') return null
  const entry = (servers as Record<string, unknown>)[name]
  if (!entry || typeof entry !== 'object') return null
  const command = (entry as { command?: unknown }).command
  const args = (entry as { args?: unknown }).args
  if (typeof command !== 'string' || !command) return null
  if (!Array.isArray(args)) return null
  // Only the broker's own namespace travels: the entry may not redefine PATH,
  // the home directory, or anything else this process runs on.
  const env: Record<string, string> = {}
  const declared = (entry as { env?: unknown }).env
  if (declared && typeof declared === 'object') {
    for (const [k, v] of Object.entries(declared as Record<string, unknown>)) {
      if (k.startsWith('CLAUDE_PEERS_') && typeof v === 'string') env[k] = v
    }
  }
  return { command, args: args.filter((a): a is string => typeof a === 'string'), env }
}

/**
 * Add `dir` to a copy of `base`, writing to the PATH key ALREADY there --
 * Windows names it `Path`, and handing a child both `Path` and `PATH` leaves
 * which one wins to the process launcher.
 */
export function withPathEntry(
  base: Record<string, string | undefined>,
  dir: string,
  separator: string
): Record<string, string | undefined> {
  const key = Object.keys(base).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
  const current = base[key] ?? ''
  return { ...base, [key]: current ? `${current}${separator}${dir}` : dir }
}

export type EnsureOutcome =
  | { action: 'skipped'; reason: 'remote-mode' }
  | { action: 'skipped'; reason: 'manual-stop' }
  | { action: 'already-running' }
  | { action: 'not-found' }
  | { action: 'started'; script: string; source: BrokerScriptLocation['source'] }
  | { action: 'failed'; script: string; reason: string }

export interface EnsureDeps {
  /** GET <url>/health: true when the broker answers 2xx. */
  isAlive: (url: string) => Promise<boolean>
  /** True while the operator's broker stop marker is present, malformed included. */
  stopped: () => boolean
  locate: () => BrokerScriptLocation | null
  /** Spawn detached, stdio ignored, unref'd; throws when the executable is missing. */
  spawn: (command: string, script: string, env: Record<string, string>) => void
  sleep: (ms: number) => Promise<void>
  /** Poll attempts after a spawn, each preceded by one sleep of `pollMs`. */
  attempts?: number
  pollMs?: number
}

/**
 * server.ts's ensureBroker, Deck-side: a remote endpoint is never spawned for
 * (a loopback process would not serve that URL), an answering broker is left
 * alone, otherwise the script is spawned and /health polled for ~6 s.
 */
export async function ensureLoopbackBroker(
  mode: DeckBrokerModeLike,
  url: string,
  deps: EnsureDeps
): Promise<EnsureOutcome> {
  if (mode === 'remote') return { action: 'skipped', reason: 'remote-mode' }
  if (await deps.isAlive(url)) return { action: 'already-running' }
  if (deps.stopped()) return { action: 'skipped', reason: 'manual-stop' }
  const located = deps.locate()
  if (!located) return { action: 'not-found' }
  try {
    deps.spawn(located.command, located.script, located.env)
  } catch (e) {
    return { action: 'failed', script: located.script, reason: e instanceof Error ? e.message : String(e) }
  }
  const attempts = deps.attempts ?? 30
  const pollMs = deps.pollMs ?? 200
  for (let i = 0; i < attempts; i++) {
    await deps.sleep(pollMs)
    if (await deps.isAlive(url)) return { action: 'started', script: located.script, source: located.source }
  }
  return {
    action: 'failed',
    script: located.script,
    reason: `no /health answer ${(attempts * pollMs) / 1000}s after spawning`
  }
}

/**
 * A down-flip of the health tracker may mean the broker died: one respawn
 * attempt per outage, never more often than `minIntervalMs`, so a broker that
 * refuses to start does not get relaunched on every failing poll.
 */
export class RespawnThrottle {
  private lastAt: number | null = null

  constructor(
    private minIntervalMs: number,
    private now: () => number = Date.now
  ) {}

  /** True when a respawn may be attempted now; records the attempt. */
  allow(): boolean {
    const t = this.now()
    if (this.lastAt !== null && t - this.lastAt < this.minIntervalMs) return false
    this.lastAt = t
    return true
  }
}
