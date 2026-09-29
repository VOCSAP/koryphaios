/**
 * Named limit: a remote broker other than the one in the global claude-peers config is never
 * probed, so its outage never reaches the Avatar face; the Deck-supplied broker_url is untrusted.
 */
import { logInfo, reportError } from './log'

export const AVATAR_BROKER_PROBE_INTERVAL_MS = 5_000
export const AVATAR_BROKER_PROBE_TIMEOUT_MS = 2_000
export const AVATAR_BROKER_PROBE_FAILURES = 2
export const MAX_PROBE_TARGETS = 16

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export interface AvatarBrokerProbeOptions {
  brokerUrls(): string[]
  knownBrokerUrls(): string[]
  setBrokerReachable(brokerUrl: string, reachable: boolean): void
  probe?(url: string, signal: AbortSignal): Promise<boolean>
  every?(ms: number, tick: () => void): () => void
  after?(ms: number, fire: () => void): () => void
  report?: typeof reportError
  info?: typeof logInfo
}

export interface AvatarBrokerProbe {
  stop(): void
}

interface ProbeTarget {
  brokerUrls: Set<string>
  reachable: boolean
  failures: number
  abort: (() => void) | null
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null
    return url
  } catch {
    return null
  }
}

/** The /health URL to probe for a Deck-supplied broker_url, or null when the Avatar must not contact it. */
export function avatarBrokerProbeUrl(brokerUrl: string, knownBrokerUrls: readonly string[]): string | null {
  const url = parseHttpUrl(brokerUrl)
  if (!url) return null
  const known = knownBrokerUrls.some((candidate) => parseHttpUrl(candidate)?.origin === url.origin)
  if (!LOOPBACK_HOSTS.has(url.hostname) && !known) return null
  return `${url.origin}/health`
}

async function fetchHealth(url: string, signal: AbortSignal): Promise<boolean> {
  const response = await fetch(url, { signal, redirect: 'error' })
  await response.body?.cancel()
  return response.ok
}

function everyInterval(ms: number, tick: () => void): () => void {
  const timer = setInterval(tick, ms)
  return () => clearInterval(timer)
}

function afterTimeout(ms: number, fire: () => void): () => void {
  const timer = setTimeout(fire, ms)
  return () => clearTimeout(timer)
}

export function startAvatarBrokerProbe(options: AvatarBrokerProbeOptions): AvatarBrokerProbe {
  const probe = options.probe ?? fetchHealth
  const every = options.every ?? everyInterval
  const after = options.after ?? afterTimeout
  const report = options.report ?? reportError
  const info = options.info ?? logInfo
  const targets = new Map<string, ProbeTarget>()
  let refused = new Set<string>()
  let capped = false

  const forget = (brokerUrls: Iterable<string>): void => {
    for (const brokerUrl of brokerUrls) options.setBrokerReachable(brokerUrl, true)
  }

  const record = (url: string, target: ProbeTarget, ok: boolean, error: unknown): void => {
    if (ok) {
      target.failures = 0
      if (!target.reachable) info('avatar-broker-probe', `broker ${new URL(url).origin} reachable again`)
      target.reachable = true
    } else {
      target.failures += 1
      if (target.reachable && target.failures >= AVATAR_BROKER_PROBE_FAILURES) {
        target.reachable = false
        report('avatar-broker-probe', `broker ${new URL(url).origin} unreachable`, error)
      }
    }
    for (const brokerUrl of target.brokerUrls) options.setBrokerReachable(brokerUrl, target.reachable)
  }

  const run = (url: string, target: ProbeTarget): void => {
    const controller = new AbortController()
    const cancelTimeout = after(AVATAR_BROKER_PROBE_TIMEOUT_MS, () =>
      controller.abort(new Error(`broker /health timed out after ${AVATAR_BROKER_PROBE_TIMEOUT_MS} ms`))
    )
    target.abort = () => controller.abort()
    probe(url, controller.signal).then(
      (ok) => settle(ok, ok ? undefined : new Error('broker /health answered a non-2xx status')),
      (error: unknown) => settle(false, error)
    )

    function settle(ok: boolean, error: unknown): void {
      cancelTimeout()
      target.abort = null
      if (targets.get(url) !== target) return
      record(url, target, ok, error)
    }
  }

  const tick = (): void => {
    const known = options.knownBrokerUrls()
    const wanted = new Map<string, Set<string>>()
    const stillRefused = new Set<string>()
    let overCap = false
    for (const brokerUrl of new Set(options.brokerUrls())) {
      const url = avatarBrokerProbeUrl(brokerUrl, known)
      if (!url) {
        stillRefused.add(brokerUrl)
        if (!refused.has(brokerUrl)) {
          report('avatar-broker-probe', 'refused to probe a broker_url outside loopback and the configured broker')
        }
        continue
      }
      let group = wanted.get(url)
      if (!group) {
        if (wanted.size >= MAX_PROBE_TARGETS) {
          overCap = true
          continue
        }
        group = new Set<string>()
        wanted.set(url, group)
      }
      group.add(brokerUrl)
    }
    refused = stillRefused
    if (overCap && !capped) {
      report('avatar-broker-probe', `refused to probe more than ${MAX_PROBE_TARGETS} distinct brokers`)
    }
    capped = overCap

    for (const [url, target] of targets) {
      const group = wanted.get(url)
      if (!group) {
        target.abort?.()
        targets.delete(url)
        forget(target.brokerUrls)
        continue
      }
      forget([...target.brokerUrls].filter((brokerUrl) => !group.has(brokerUrl)))
    }

    for (const [url, group] of wanted) {
      let target = targets.get(url)
      if (!target) {
        target = { brokerUrls: group, reachable: true, failures: 0, abort: null }
        targets.set(url, target)
      }
      target.brokerUrls = group
      if (!target.abort) run(url, target)
    }
  }

  const stopTicking = every(AVATAR_BROKER_PROBE_INTERVAL_MS, tick)
  tick()

  return {
    stop() {
      stopTicking()
      for (const target of targets.values()) target.abort?.()
      targets.clear()
    }
  }
}
