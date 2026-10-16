// The Avatar tray's Start and Stop of the LOCAL broker. Nothing records the
// broker's pid, so Stop reads the process listening on the configured port
// and never matches a process by image name. The stop marker is written before
// the kill: written after, a Deck could relaunch the broker in between.

import type { BrokerStopMarker, BrokerStopReading } from '../../../shared/broker-stop-marker'
import type { AvatarTrayBroker } from './avatar-tray-menu'
import type { DeckBrokerModeLike, EnsureOutcome } from './broker-spawn'
import { createBrokerStart, type BrokerStartResult } from './broker-start'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost'])
const DEATH_POLLS = 30
const DEATH_POLL_MS = 100

export interface AvatarBrokerStopDetails {
  url: string
  pid: number
  decks: number
}

export interface AvatarBrokerControlDeps {
  /** The broker URL of the global claude-peers config, never one a Deck supplied. */
  url(): string
  selfPid: number
  /** The pid listening on 127.0.0.1:<port>, or null when no single process does. */
  listenerPid(port: number): Promise<number | null>
  isAlive(pid: number): boolean
  /** The parsed JSON body of GET http://127.0.0.1:<port>/health, the socket the stop inspects; rejects without a JSON answer. */
  brokerHealth(port: number): Promise<unknown>
  attachedBrokerUrls(): string[]
  confirm(details: AvatarBrokerStopDetails): Promise<boolean>
  writeMarker(marker: BrokerStopMarker): void
  clearMarker(): void
  kill(pid: number): void
  sleep(ms: number): Promise<void>
  now(): string
  health(): Promise<boolean>
  ensure(): Promise<EnsureOutcome>
  /** Re-reads the marker into the Avatar face and menu, whatever the outcome. */
  refresh(): void
  report(scope: string, message: string, error?: unknown): void
}

export type AvatarBrokerStopResult = { ok: true } | { ok: false; error: string } | { ok: false; cancelled: true }

export interface AvatarBrokerControl {
  stop(): Promise<AvatarBrokerStopResult>
  start(): Promise<BrokerStartResult>
}

/** A remote broker is never offered: the Avatar only controls the loopback broker of this machine. */
export function avatarTrayBroker(mode: DeckBrokerModeLike, stopped: boolean, reachable: boolean): AvatarTrayBroker | null {
  if (mode === 'remote') return null
  return { running: !stopped && reachable }
}

/** A stale marker left behind while the config points at a remote broker never shows the panne face. */
export function avatarManualStop(mode: DeckBrokerModeLike, reading: BrokerStopReading): boolean {
  return mode !== 'remote' && reading.stopped
}

function loopbackPort(value: string): number | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (!LOOPBACK_HOSTS.has(url.hostname) || !url.port) return null
  return Number(url.port)
}

/**
 * Not a proof of identity, only that the listener speaks claude-peers: /health
 * carries no pid or instance id, so a process that copies these fields passes.
 */
function isClaudePeersHealth(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  const health = body as Record<string, unknown>
  return health.status === 'ok' && typeof health.context_resume_version === 'number' && typeof health.operator_trust_state === 'string'
}

function origin(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

export function createAvatarBrokerControl(deps: AvatarBrokerControlDeps): AvatarBrokerControl {
  let stopping: Promise<AvatarBrokerStopResult> | null = null

  const fail = (message: string, error?: unknown): AvatarBrokerStopResult => {
    deps.report('avatar-broker', `local broker stop failed: ${message}`, error)
    return { ok: false, error: message }
  }

  const listener = async (port: number): Promise<number | null> => {
    const pid = await deps.listenerPid(port)
    return pid === null || pid === 0 || pid === deps.selfPid ? null : pid
  }

  const speaksClaudePeers = async (port: number): Promise<string | null> => {
    try {
      return isClaudePeersHealth(await deps.brokerHealth(port)) ? null : 'its /health is not a claude-peers broker answer'
    } catch (e) {
      return `its /health gave no JSON answer (${e instanceof Error ? e.message : String(e)})`
    }
  }

  const runStop = async (): Promise<AvatarBrokerStopResult> => {
    const url = deps.url()
    const port = loopbackPort(url)
    if (port === null) return fail(`${url} is not a loopback broker URL with a port`)
    let pid: number | null
    try {
      pid = await listener(port)
    } catch (e) {
      return fail(`the process listening on port ${port} could not be read`, e)
    }
    if (pid === null) {
      return fail(`no other process listens on 127.0.0.1:${port} (a broker bound to another host, see bind_host, is not stopped from the tray)`)
    }
    if (!deps.isAlive(pid)) return fail(`process ${pid} listening on port ${port} is not alive`)
    const foreign = await speaksClaudePeers(port)
    if (foreign !== null) return fail(`process ${pid} on port ${port} was left running: ${foreign}`)

    const target = origin(url)
    const decks = deps.attachedBrokerUrls().filter((candidate) => origin(candidate) === target).length
    if (!(await deps.confirm({ url, pid, decks }))) return { ok: false, cancelled: true }

    try {
      if ((await listener(port)) !== pid) return fail(`the broker on port ${port} changed while the confirmation was open`)
    } catch (e) {
      return fail(`the process listening on port ${port} could not be read again`, e)
    }
    const foreignNow = await speaksClaudePeers(port)
    if (foreignNow !== null) return fail(`process ${pid} on port ${port} was left running: ${foreignNow}`)
    try {
      deps.writeMarker({ stopped_at: deps.now(), by: 'avatar', killed_pid: pid })
    } catch (e) {
      return fail('the stop marker could not be written, the broker was left running', e)
    }
    try {
      deps.kill(pid)
    } catch (e) {
      deps.clearMarker()
      return fail(`process ${pid} could not be killed`, e)
    }
    for (let i = 0; i < DEATH_POLLS && deps.isAlive(pid); i++) await deps.sleep(DEATH_POLL_MS)
    if (deps.isAlive(pid)) {
      return fail(`kill sent, death not confirmed: process ${pid} is still alive ${(DEATH_POLLS * DEATH_POLL_MS) / 1000}s after the kill; the stop marker stays until Start`)
    }
    return { ok: true }
  }

  const stop = (): Promise<AvatarBrokerStopResult> => {
    stopping ??= runStop()
      .catch((e: unknown) => fail(e instanceof Error ? e.message : String(e), e))
      .finally(() => {
        stopping = null
        try {
          deps.refresh()
        } catch (e) {
          deps.report('avatar-broker', 'Avatar refresh after the broker stop failed', e)
        }
      })
    return stopping
  }

  const start = createBrokerStart({
    clearMarker: deps.clearMarker,
    isAlive: deps.health,
    ensure: deps.ensure,
    refresh: deps.refresh,
    report: deps.report
  })

  return { stop, start }
}
