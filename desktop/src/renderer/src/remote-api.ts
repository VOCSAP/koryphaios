// Remote DeckApi shim (PLAN MB1): when the bundle runs in a plain browser
// (companion mode — no Electron preload, so no window.api), this module
// builds the SAME window.api surface over the companion WebSocket, generated
// from the shared manifest so it can never drift from the preload.
//
// Lifecycle (EXPLORATION §5.5, ephemeral session): the pairing token arrives
// in the URL fragment (#t=…, never sent to the server by HTTP), is exchanged
// once for a per-run credential kept in sessionStorage for reconnects, and
// the host closing means a terminal "host disconnected" state — the operator
// re-scans a fresh QR after relaunching the desktop app.

import {
  COMPANION_CLIENT_TIMEOUT_MS,
  COMPANION_CRED_STORAGE_KEY,
  COMPANION_MANIFEST,
  REMOTE_BLOCKED_CHANNELS,
  type CompanionServerFrame
} from '@shared/companion'
import type { DeckApi } from '@shared/types'

export type RemoteState = 'connecting' | 'connected' | 'disconnected'

// Shared with the Android shell, which seeds this key to resume a host.
const CRED_KEY = COMPANION_CRED_STORAGE_KEY

let ws: WebSocket | null = null
let state: RemoteState = 'connecting'
let reqId = 0
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
const listeners = new Map<string, Set<(payload: unknown) => void>>()
const stateListeners = new Set<(s: RemoteState) => void>()
const refreshListeners = new Set<() => void>()
let lastSeen = 0
let watchdog: number | null = null

export function isRemoteClient(): boolean {
  return typeof window !== 'undefined' && !window.api
}

/** True once connectRemoteApi() installed the WebSocket shim as window.api. */
export function remoteInstalled(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!(window as unknown as { __companionRemote?: boolean }).__companionRemote
  )
}

export function remoteState(): RemoteState {
  return state
}

export function onRemoteState(cb: (s: RemoteState) => void): () => void {
  stateListeners.add(cb)
  return () => {
    stateListeners.delete(cb)
  }
}

/** Fired after a light→full resume or a successful reconnect: views should
 * re-hydrate list state they may have missed (MB5). */
export function onRemoteRefresh(cb: () => void): () => void {
  refreshListeners.add(cb)
  return () => {
    refreshListeners.delete(cb)
  }
}

function setState(next: RemoteState): void {
  if (state === next) return
  state = next
  for (const cb of stateListeners) cb(next)
}

function emitRefresh(): void {
  for (const cb of refreshListeners) cb()
}

function pairingTokenFromUrl(): string | null {
  const m = /[#&]t=([A-Za-z0-9_-]+)/.exec(window.location.hash)
  return m?.[1] ?? null
}

function openSocket(auth: { token?: string; cred?: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = `wss://${window.location.host}/ws`
    const sock = new WebSocket(url)
    ws = sock
    // Reset the liveness clock for the NEW socket: otherwise the watchdog,
    // comparing against a lastSeen stale from before the drop, could close a
    // still-connecting reconnect socket mid-handshake.
    lastSeen = Date.now()
    let settled = false
    sock.onopen = () => {
      sock.send(JSON.stringify({ t: 'hello', ...auth }))
    }
    sock.onmessage = (e) => {
      lastSeen = Date.now()
      let frame: CompanionServerFrame
      try {
        frame = JSON.parse(String(e.data)) as CompanionServerFrame
      } catch {
        return
      }
      switch (frame.t) {
        case 'welcome':
          if (frame.cred) sessionStorage.setItem(CRED_KEY, frame.cred)
          // The one-shot pairing token must not linger in the address bar
          // (nor in the browser history).
          if (pairingTokenFromUrl()) {
            history.replaceState(null, '', window.location.pathname)
          }
          settled = true
          setState('connected')
          resolve()
          return
        case 'res': {
          const p = pending.get(frame.id)
          if (!p) return
          pending.delete(frame.id)
          if (frame.ok) p.resolve(frame.value)
          else p.reject(new Error(frame.error ?? 'remote error'))
          return
        }
        case 'ev': {
          const subs = listeners.get(frame.ch)
          if (!subs) return
          for (const cb of subs) {
            try {
              cb(frame.payload)
            } catch (err) {
              // Mirror the preload multiplexer: one throwing handler must not
              // break delivery to the others.
              console.error(`[remote] ${frame.ch} handler threw:`, err)
            }
          }
          return
        }
        case 'hb':
          return
      }
    }
    sock.onclose = () => {
      if (!settled) {
        settled = true
        reject(new Error('companion connection refused'))
      }
      teardown()
    }
    sock.onerror = () => {
      // onclose follows; nothing to do here.
    }
  })
}

function teardown(): void {
  ws = null
  for (const [, p] of pending) p.reject(new Error('host disconnected'))
  pending.clear()
  void attemptReconnect()
}

let reconnecting = false
async function attemptReconnect(): Promise<void> {
  if (reconnecting) return
  const cred = sessionStorage.getItem(CRED_KEY)
  if (!cred) {
    setState('disconnected')
    return
  }
  reconnecting = true
  setState('connecting')
  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)))
    try {
      await openSocket({ cred })
      reconnecting = false
      sendMode(document.hidden ? 'light' : 'full')
      emitRefresh()
      return
    } catch {
      // next attempt; a denied cred also lands here (fresh app run PC-side).
    }
  }
  reconnecting = false
  setState('disconnected')
}

/** Manual retry from the disconnected overlay. */
export function retryRemoteConnection(): void {
  if (state === 'connected' || reconnecting) return
  void attemptReconnect()
}

function request(channel: string, args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('host disconnected'))
      return
    }
    const id = ++reqId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ t: 'req', id, ch: channel, args }))
  })
}

function fire(channel: string, args: unknown[]): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify({ t: 'send', ch: channel, args }))
}

function subscribeLocal(channel: string, cb: (payload: unknown) => void): () => void {
  let subs = listeners.get(channel)
  if (!subs) {
    subs = new Set()
    listeners.set(channel, subs)
  }
  subs.add(cb)
  return () => {
    subs.delete(cb)
  }
}

function sendMode(mode: 'light' | 'full'): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify({ t: 'mode', mode }))
}

function buildApi(): DeckApi {
  const api: Record<string, unknown> = {}
  for (const [method, spec] of Object.entries(COMPANION_MANIFEST)) {
    if (spec.kind === 'invoke') {
      api[method] = REMOTE_BLOCKED_CHANNELS.has(spec.channel)
        ? () => Promise.reject(new Error('remote-blocked'))
        : (...args: unknown[]) => request(spec.channel, args)
    } else if (spec.kind === 'send') {
      api[method] = (...args: unknown[]) => fire(spec.channel, args)
    } else {
      api[method] = (cb: (payload: unknown) => void) => subscribeLocal(spec.channel, cb)
    }
  }
  return api as unknown as DeckApi
}

/**
 * Connect and install window.api. Resolves once paired/resumed; rejects when
 * no pairing token nor stored credential can open the bridge.
 */
export async function connectRemoteApi(): Promise<void> {
  const token = pairingTokenFromUrl()
  const cred = sessionStorage.getItem(CRED_KEY)
  if (!token && !cred) throw new Error('no-pairing-token')
  try {
    await openSocket(token ? { token } : { cred: cred ?? undefined })
  } catch (e) {
    // A stale hash token (already consumed) with no cred is a dead end: the
    // operator must re-scan. Surface a distinct error for the boot screen.
    throw e instanceof Error ? e : new Error(String(e))
  }
  window.api = buildApi()
  ;(window as unknown as { __companionRemote?: boolean }).__companionRemote = true

  // Background = light channel (MB5): drop the terminal stream, keep signals.
  document.addEventListener('visibilitychange', () => {
    sendMode(document.hidden ? 'light' : 'full')
    if (!document.hidden) emitRefresh()
  })

  // Host-death watchdog (EXPLORATION §5.5): the server heartbeats every 5 s;
  // 12 s of silence on an OPEN socket = the host is gone (kill, crash, network
  // drop). Guarded against double-install (re-entrant connectRemoteApi) and
  // skips CONNECTING sockets so it never kills an in-flight reconnect.
  if (watchdog !== null) window.clearInterval(watchdog)
  watchdog = window.setInterval(() => {
    if (
      ws &&
      ws.readyState === WebSocket.OPEN &&
      Date.now() - lastSeen > COMPANION_CLIENT_TIMEOUT_MS
    ) {
      ws.close()
    }
  }, 2_000)
}
