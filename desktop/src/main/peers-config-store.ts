// Read and write the claude-peers CORE config file (config.json) -- the same
// file server.ts, cli.ts and every non-Kory session read to find their broker.
// The Deck only ever touches ONE key of it, `offline_replica`, and only from
// the Settings > Broker panel.
//
// Node builtins only (no electron, no @shared alias) so it is unit-testable
// under bun test on a throwaway file. The path is resolved MAIN-side by the
// caller (peersConfigPath) and is never a renderer argument; the only value
// crossing the IPC boundary is the boolean, re-validated here.

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
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
 */
export function writeOfflineReplica(path: string, value: unknown): void {
  if (typeof value !== 'boolean') {
    throw new Error(`offline_replica must be a boolean, received ${typeof value}`)
  }
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
    mkdirSync(dirname(path), { recursive: true })
    // 0600 like every other file that can carry a bearer token, and atomic so
    // a crash mid-write cannot leave the sessions without a broker_url.
    writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  } catch (e) {
    reportError('peers-config', `cannot write ${path}; the replica opt-in was not saved`, e)
    throw new Error('claude-peers config.json could not be written')
  }
}
