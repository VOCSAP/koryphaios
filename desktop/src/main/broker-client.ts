// Minimal outbound broker client for the Deck (v0.3.4). The Deck is a one-way
// participant: it POSTs /announce to broadcast operator messages to a group's
// peers, and never reads inbound traffic. It is NOT a registered peer.
//
// This module deliberately avoids electron/node-pty imports (node builtins +
// fetch only) so it can be unit-tested under `bun test`, and avoids the @shared
// alias (bun cannot resolve it in the repo-root test harness).
//
// The broker URL/token are read from the SAME claude-peers config the spawned
// sessions use (env > %APPDATA%/XDG config.json > loopback default), mirroring
// shared/config.ts -- but with Node fs, since shared/config.ts uses Bun.file
// which is unavailable in the Electron main process.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface BrokerEndpoint {
  url: string
  token: string | null
}

interface PeersFileConfig {
  port?: number
  broker_url?: string
  broker_token?: string
}

/** Path of the claude-peers core config.json, matching shared/config.ts. */
export function peersConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') {
    const appdata = env.APPDATA
    return appdata
      ? join(appdata, 'claude-peers', 'config.json')
      : join(homedir(), 'AppData', 'Roaming', 'claude-peers', 'config.json')
  }
  const xdg = env.XDG_CONFIG_HOME
  return xdg
    ? join(xdg, 'claude-peers', 'config.json')
    : join(homedir(), '.config', 'claude-peers', 'config.json')
}

function readPeersConfig(path: string): PeersFileConfig {
  try {
    if (!existsSync(path)) return {}
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as PeersFileConfig) : {}
  } catch {
    return {}
  }
}

/**
 * Resolve the broker endpoint (url + optional bearer token) the Deck should POST
 * /announce to. Precedence mirrors shared/config.ts: env > config file > default.
 */
export function resolveBrokerEndpoint(
  env: NodeJS.ProcessEnv = process.env,
  configPath: string = peersConfigPath(env)
): BrokerEndpoint {
  const file = readPeersConfig(configPath)
  const port = parseInt(env.CLAUDE_PEERS_PORT ?? String(file.port ?? 7899), 10)
  const url = env.CLAUDE_PEERS_BROKER_URL ?? file.broker_url ?? `http://127.0.0.1:${port}`
  const token = env.CLAUDE_PEERS_BROKER_TOKEN ?? file.broker_token ?? null
  return { url, token }
}

/** Full sha256 hex of a group secret (== shared/config.ts computeGroupSecretHash). */
export function computeGroupSecretHash(secret: string): string {
  return createHash('sha256').update(secret, 'utf-8').digest('hex')
}

export interface SendAnnounceParams {
  /** sha256(secret).slice(0,32) -- the broker group_id (== Scope.groupId). */
  groupId: string
  /** The forced-group secret (never the hash); hashed here for the payload. */
  secret: string
  text: string
  /** peer_id to exclude (e.g. the just-joined peer, so it skips its own join). */
  excludePeerId?: string | null
  /** Targeted announce (PLAN C10): deliver to this ONE active peer only. */
  toPeerId?: string | null
}

export interface AnnounceDeps {
  endpoint: BrokerEndpoint
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch
}

/**
 * Build the /announce request payload from a scope + text. Exposed for tests so
 * the wiring (hash, exclude) can be asserted without a live broker.
 */
export function buildAnnouncePayload(params: SendAnnounceParams): {
  group_id: string
  group_secret_hash: string
  text: string
  exclude_peer_id: string | null
  to_peer_id: string | null
} {
  return {
    group_id: params.groupId,
    group_secret_hash: computeGroupSecretHash(params.secret),
    text: params.text,
    exclude_peer_id: params.excludePeerId ?? null,
    // Targeted announce (PLAN C10): one active peer instead of the broadcast.
    to_peer_id: params.toPeerId ?? null
  }
}

/**
 * POST /announce. Best-effort: throws on a non-2xx or transport failure so the
 * caller can swallow it (an announce must never crash the Deck main process).
 */
export async function sendAnnounce(
  params: SendAnnounceParams,
  deps: AnnounceDeps
): Promise<{ sent: number }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (deps.endpoint.token) headers['Authorization'] = `Bearer ${deps.endpoint.token}`
  const f = deps.fetchFn ?? fetch
  const res = await f(`${deps.endpoint.url}/announce`, {
    method: 'POST',
    headers,
    body: JSON.stringify(buildAnnouncePayload(params))
  })
  if (!res.ok) throw new Error(`announce failed: ${res.status}`)
  return (await res.json()) as { sent: number }
}
