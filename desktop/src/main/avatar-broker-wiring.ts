import type { TcpEndpoint } from './avatar-socket-owner'
import type { AvatarBrokerStopConfirmCopy } from './avatar-tray-copy'
import type { DeckBrokerModeLike } from './broker-spawn'

export interface BrokerStopDialogOptions {
  type: 'warning'
  title: string
  message: string
  detail: string
  buttons: [string, string]
  defaultId: 1
  cancelId: 1
  noLink: true
}

/** The configured broker URL joins the probed ones only when it is the loopback broker this Avatar controls. */
export function avatarBrokerProbeUrls(attached: readonly string[], mode: DeckBrokerModeLike, ownUrl: string): string[] {
  return mode === 'remote' ? [...attached] : [...attached, ownUrl]
}

/** Enter or Escape on the dialog lands on Cancel: stopping the broker cuts every session. */
export function brokerStopDialogOptions(text: AvatarBrokerStopConfirmCopy): BrokerStopDialogOptions {
  return {
    type: 'warning',
    title: text.title,
    message: text.message,
    detail: text.detail,
    buttons: [text.confirm, text.cancel],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  }
}

export const BROKER_HEALTH_MAX_BYTES = 64 * 1024

type HealthFetch = (url: string, init: { signal: AbortSignal; redirect: 'error' }) => Promise<Response>

/**
 * GET /health on 127.0.0.1, the host of the socket whose owner gets killed: a
 * `localhost` URL may resolve to ::1 and reach another process. The body is
 * read up to BROKER_HEALTH_MAX_BYTES before any JSON.parse.
 */
export async function fetchBrokerHealth(port: number, fetchImpl: HealthFetch): Promise<unknown> {
  const response = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000), redirect: 'error' })
  if (!response.ok) throw new Error(`/health answered ${response.status}`)
  const announced = Number(response.headers.get('content-length'))
  if (announced > BROKER_HEALTH_MAX_BYTES) {
    await response.body?.cancel()
    throw new Error(`/health announced ${announced} bytes, over ${BROKER_HEALTH_MAX_BYTES}`)
  }
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (reader) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > BROKER_HEALTH_MAX_BYTES) {
      await reader.cancel()
      throw new Error(`/health sent more than ${BROKER_HEALTH_MAX_BYTES} bytes`)
    }
    chunks.push(value)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function confirmedStop(response: number): boolean {
  return response === 0
}

/** A listening socket appears in netstat with the remote end 0.0.0.0:0. */
export function brokerListenerEnds(port: number): { local: TcpEndpoint; remote: TcpEndpoint } {
  return { local: { address: '127.0.0.1', port }, remote: { address: '0.0.0.0', port: 0 } }
}

export function trayBrokerSummary<T>(refresh: () => void, summary: () => T): () => T {
  return () => {
    refresh()
    return summary()
  }
}

/** The probe ticks even when the Tray does not exist, so the panne face never waits for it. */
export function probeBrokerUrls(refresh: () => void, urls: () => string[]): () => string[] {
  return () => {
    refresh()
    return urls()
  }
}

/** Applies the marker on every read; the Avatar window is republished only when the stop state flips. */
export function manualStopRefresher(read: () => boolean, apply: (stopped: boolean) => void, republish: () => void): () => void {
  let last = false
  return () => {
    const stopped = read()
    apply(stopped)
    if (stopped === last) return
    last = stopped
    republish()
  }
}
